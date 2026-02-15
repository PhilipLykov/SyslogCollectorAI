import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { resolveAiConfig, resolveCustomPrompts, resolveTaskModels } from '../llm/aiConfig.js';
import { DEFAULT_RAG_SYSTEM_PROMPT, humanAge } from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';

/**
 * RAG-style natural language query endpoint.
 *
 * Builds context from stored meta summaries, findings, and event snippets.
 * Calls LLM with a RAG-style prompt. Returns a short answer.
 *
 * Enhanced to include:
 *   1. Findings as primary context (compact, high-signal)
 *   2. Dynamic meta_result limit based on requested time range
 *   3. Increased response token limit
 *
 * OWASP A03: Sanitize question to reduce prompt injection.
 * Note: Full prompt injection prevention for LLM is an evolving challenge.
 * The question is placed inside a clearly delimited block.
 */
export interface RagResult {
  answer: string;
  context_used: number;
}

/** Compute dynamic limit for meta_results based on the requested time range. */
function computeMetaLimit(from?: string, to?: string): number {
  if (!from && !to) return 100; // "All time" handled separately with two-phase fetch

  const fromMs = from ? new Date(from).getTime() : Date.now() - 365 * 24 * 60 * 60 * 1000;
  const toMs = to ? new Date(to).getTime() : Date.now();
  const rangeMs = Math.max(0, toMs - fromMs);
  const rangeHours = rangeMs / (60 * 60 * 1000);

  if (rangeHours <= 2)  return 24;   // Short: covers full range of 5-min windows
  if (rangeHours <= 24) return 50;   // Medium
  if (rangeHours <= 168) return 80;  // Long (up to 7 days)
  return 100;                         // Very long
}

export async function askQuestion(
  db: Knex,
  question: string,
  options?: { systemId?: string; from?: string; to?: string },
): Promise<RagResult> {
  // Resolve config from DB first, then env vars (supports runtime changes via UI)
  const aiCfg = await resolveAiConfig(db);
  const apiKey = aiCfg.apiKey;
  const model = aiCfg.model;
  const baseUrl = aiCfg.baseUrl;

  if (!apiKey) throw new Error('OPENAI_API_KEY not configured. Set it in Settings → AI Model or via environment variable.');

  // Sanitize question (A03: limit length, strip control chars)
  const sanitized = question.replace(/[\x00-\x1f]/g, '').slice(0, 500);

  // ── 1. Query findings (primary context — compact, high-signal) ──
  let findingsQuery = db('findings')
    .join('monitored_systems', 'findings.system_id', 'monitored_systems.id')
    .select(
      'monitored_systems.name as system_name',
      'findings.text', 'findings.severity', 'findings.status',
      'findings.criterion_slug', 'findings.created_at', 'findings.last_seen_at',
      'findings.occurrence_count', 'findings.reopen_count', 'findings.is_flapping',
      'findings.resolution_evidence', 'findings.resolved_at',
    );

  if (options?.systemId) {
    findingsQuery = findingsQuery.where('findings.system_id', options.systemId);
  }

  // Include open/acknowledged findings + resolved ones within the time range
  const fromVal = options?.from;
  if (fromVal) {
    findingsQuery = findingsQuery.where(function () {
      this.whereIn('findings.status', ['open', 'acknowledged'])
        .orWhere(function () {
          this.where('findings.status', 'resolved')
            .where('findings.resolved_at', '>=', fromVal);
        });
    });
  } else {
    // "All time" — include all open/acknowledged + recently resolved
    findingsQuery = findingsQuery.where(function () {
      this.whereIn('findings.status', ['open', 'acknowledged'])
        .orWhere(function () {
          this.where('findings.status', 'resolved')
            .where('findings.resolved_at', '>=', db.raw("NOW() - INTERVAL '30 days'"));
        });
    });
  }

  findingsQuery = findingsQuery
    .orderByRaw(`
      CASE findings.status
        WHEN 'open' THEN 0
        WHEN 'acknowledged' THEN 1
        WHEN 'resolved' THEN 2
      END,
      CASE findings.severity
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'info' THEN 4
      END,
      findings.last_seen_at DESC NULLS LAST
    `)
    .limit(50);

  const findingsRows = await findingsQuery;

  const findingsParts = findingsRows.map((f: any) => {
    const parts: string[] = [];
    let statusTag = f.status.toUpperCase();
    if (f.is_flapping) statusTag += '|FLAPPING';

    parts.push(`[${statusTag}] [${f.severity}] ${f.system_name}: ${f.text}`);

    const meta: string[] = [];
    if (f.created_at) meta.push(`age: ${humanAge(f.created_at)}`);
    const occ = Number(f.occurrence_count) || 1;
    if (occ > 1) meta.push(`seen: ${occ} times`);
    const reopens = Number(f.reopen_count) || 0;
    if (reopens > 0) meta.push(`reopened: ${reopens} times`);
    if (f.criterion_slug) meta.push(`criterion: ${f.criterion_slug}`);
    if (f.resolution_evidence) meta.push(`resolution: ${f.resolution_evidence}`);
    if (meta.length > 0) parts.push(`  ${meta.join(' | ')}`);

    return parts.join('\n');
  });

  // ── 2. Query meta_result summaries (secondary context) ──
  // "All time" uses a two-phase fetch to cover both recent detail and
  // historical breadth (up to 30 days). Custom ranges use a single query.
  const isAllTime = !options?.from && !options?.to;

  let metaRows: any[];

  if (isAllTime) {
    // Phase 1: Recent 48 hours — detailed recent context
    let recentQuery = db('meta_results')
      .join('windows', 'meta_results.window_id', 'windows.id')
      .join('monitored_systems', 'windows.system_id', 'monitored_systems.id')
      .where('windows.from_ts', '>=', db.raw("NOW() - INTERVAL '48 hours'"))
      .orderBy('meta_results.created_at', 'desc')
      .limit(100)
      .select(
        'monitored_systems.name as system_name',
        'windows.from_ts',
        'windows.to_ts',
        'meta_results.summary',
        'meta_results.findings',
        'meta_results.recommended_action',
      );
    if (options?.systemId) {
      recentQuery = recentQuery.where('windows.system_id', options.systemId);
    }
    const recentRows = await recentQuery;

    // Phase 2: Historical 2–30 days — one summary per day per system using
    // PostgreSQL DISTINCT ON to efficiently sample without fetching thousands of rows.
    // Uses parameterized query (OWASP A03) — never interpolate user input into SQL.
    const histSql = `
      SELECT DISTINCT ON (date_trunc('day', w.from_ts), w.system_id)
        ms.name as system_name,
        w.from_ts,
        w.to_ts,
        mr.summary,
        mr.findings,
        mr.recommended_action
      FROM meta_results mr
      JOIN windows w ON mr.window_id = w.id
      JOIN monitored_systems ms ON w.system_id = ms.id
      WHERE w.from_ts >= NOW() - INTERVAL '30 days'
        AND w.from_ts < NOW() - INTERVAL '48 hours'
        ${options?.systemId ? 'AND w.system_id = ?' : ''}
      ORDER BY date_trunc('day', w.from_ts) DESC, w.system_id, mr.created_at DESC
      LIMIT 100
    `;
    const histBindings = options?.systemId ? [options.systemId] : [];
    const historicalRows = await db.raw(histSql, histBindings);

    // Merge: recent (newest first) + historical (newest first)
    const histRows = historicalRows.rows ?? historicalRows;
    metaRows = [...recentRows, ...histRows];
  } else {
    // Custom range — single query with time filters
    const metaLimit = computeMetaLimit(options?.from, options?.to);

    let metaQuery = db('meta_results')
      .join('windows', 'meta_results.window_id', 'windows.id')
      .join('monitored_systems', 'windows.system_id', 'monitored_systems.id')
      .orderBy('meta_results.created_at', 'desc')
      .limit(metaLimit)
      .select(
        'monitored_systems.name as system_name',
        'windows.from_ts',
        'windows.to_ts',
        'meta_results.summary',
        'meta_results.findings',
        'meta_results.recommended_action',
      );

    if (options?.systemId) {
      metaQuery = metaQuery.where('windows.system_id', options.systemId);
    }
    if (options?.from) {
      metaQuery = metaQuery.where('windows.from_ts', '>=', options.from);
    }
    if (options?.to) {
      metaQuery = metaQuery.where('windows.to_ts', '<=', options.to);
    }

    metaRows = await metaQuery;
  }

  // For long time ranges with many windows, sample uniformly
  let sampledMetaRows = metaRows;
  const targetSummaries = 60; // Max summaries to include in the LLM prompt
  if (metaRows.length > targetSummaries) {
    // Use (length - 1) / (target - 1) to ensure both first and last rows are included
    const step = targetSummaries > 1 ? (metaRows.length - 1) / (targetSummaries - 1) : 1;
    sampledMetaRows = [];
    for (let i = 0; i < targetSummaries; i++) {
      sampledMetaRows.push(metaRows[Math.min(Math.floor(i * step), metaRows.length - 1)]);
    }
  }

  const summaryParts = sampledMetaRows.map((r: any) => {
    let findings: string[] = [];
    try {
      findings = typeof r.findings === 'string' ? JSON.parse(r.findings) : (r.findings ?? []);
    } catch { /* malformed JSON — ignore */ }

    return [
      `System: ${r.system_name} | Window: ${r.from_ts} – ${r.to_ts}`,
      `Summary: ${r.summary}`,
      findings.length > 0 ? `Findings: ${findings.join('; ')}` : '',
      r.recommended_action ? `Action: ${r.recommended_action}` : '',
    ].filter(Boolean).join('\n');
  });

  // ── 3. Assemble context ──
  const contextSections: string[] = [];

  if (findingsParts.length > 0) {
    contextSections.push('=== TRACKED FINDINGS ===');
    contextSections.push(findingsParts.join('\n---\n'));
  }

  if (summaryParts.length > 0) {
    contextSections.push('');
    contextSections.push(`=== ANALYSIS SUMMARIES (${sampledMetaRows.length} of ${metaRows.length} windows) ===`);
    contextSections.push(summaryParts.join('\n---\n'));
  }

  const context = contextSections.join('\n');
  const totalContextItems = findingsRows.length + sampledMetaRows.length;

  // Resolve custom RAG prompt (if configured by user), fall back to default
  const customPrompts = await resolveCustomPrompts(db);
  const systemPrompt = customPrompts.ragSystemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT;

  // Resolve per-task model override for RAG
  const taskModels = await resolveTaskModels(db);
  const effectiveModel = (taskModels.rag_model && taskModels.rag_model.trim()) ? taskModels.rag_model.trim() : model;

  // Place question in a clearly delimited block to reduce injection surface
  const userContent = `<context>\n${context}\n</context>\n\n<question>\n${sanitized}\n</question>`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
    });
  } catch (netErr: any) {
    console.error(`[${localTimestamp()}] RAG LLM network error: ${netErr.message}`);
    throw new Error('Failed to reach the AI service. Please check network and base URL configuration.');
  }

  if (!res.ok) {
    // Don't leak raw error details to the client
    const errorText = await res.text();
    console.error(`[${localTimestamp()}] RAG LLM error ${res.status}: ${errorText}`);
    throw new Error('Failed to process your question. Please try again later.');
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    console.error(`[${localTimestamp()}] RAG LLM returned invalid JSON`);
    throw new Error('Failed to process your question. Please try again later.');
  }
  const answer = data.choices?.[0]?.message?.content ?? 'Unable to generate an answer.';

  // ── O6: Track RAG LLM usage in llm_usage table ───────────
  try {
    const usageData = data.usage;
    const tokenInput = Number(usageData?.prompt_tokens ?? 0);
    const tokenOutput = Number(usageData?.completion_tokens ?? 0);
    const cost = estimateCost(tokenInput, tokenOutput, effectiveModel);
    await db('llm_usage').insert({
      id: uuidv4(),
      system_id: options?.systemId ?? null,
      run_type: 'rag',
      model: effectiveModel,
      token_input: tokenInput,
      token_output: tokenOutput,
      request_count: 1,
      cost_estimate: cost,
    });
  } catch (trackErr: any) {
    console.error(`[${localTimestamp()}] RAG usage tracking failed: ${trackErr.message}`);
    // Don't fail the request if tracking fails
  }

  console.log(
    `[${localTimestamp()}] RAG query answered ` +
    `(findings=${findingsRows.length}, summaries=${sampledMetaRows.length}/${metaRows.length}, model=${effectiveModel})`,
  );

  return { answer, context_used: totalContextItems };
}
