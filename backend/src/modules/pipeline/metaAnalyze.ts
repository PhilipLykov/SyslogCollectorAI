import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import {
  type LlmAdapter,
  type ScoreResult,
  type MetaAnalysisContext,
} from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';
import { CRITERIA } from '../../types/index.js';
import { resolveCustomPrompts } from '../llm/aiConfig.js';

const DEFAULT_W_META = 0.7;
/** Number of previous window summaries to include as context. */
const CONTEXT_WINDOW_SIZE = 5;

/**
 * Meta-analyze a window: gather events + scores, build historical context,
 * call LLM, store meta_results + findings, compute effective scores.
 *
 * The "sliding context window" approach:
 *   - Last N window summaries are included so the LLM can spot trends.
 *   - Currently open (unacknowledged, unresolved) findings are sent so the
 *     LLM can decide which are still relevant and which should be resolved.
 *   - New findings are persisted individually in the `findings` table.
 */
export async function metaAnalyzeWindow(
  db: Knex,
  llm: LlmAdapter,
  windowId: string,
  options?: { wMeta?: number },
): Promise<void> {
  const wMeta = options?.wMeta ?? DEFAULT_W_META;

  const window = await db('windows').where({ id: windowId }).first();
  if (!window) throw new Error(`Window ${windowId} not found`);

  const system = await db('monitored_systems').where({ id: window.system_id }).first();
  if (!system) throw new Error(`System ${window.system_id} not found`);

  const sources = await db('log_sources').where({ system_id: system.id }).select('label');
  const sourceLabels = sources.map((s: any) => s.label);

  // Resolve custom system prompt (if configured by user)
  const customPrompts = await resolveCustomPrompts(db);

  // ── Resolve event ack config ────────────────────────────
  const ackRows = await db('app_config')
    .whereIn('key', ['event_ack_mode', 'event_ack_prompt'])
    .select('key', 'value');
  const ackCfg: Record<string, string> = {};
  for (const row of ackRows) {
    let v = row.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* ok */ } }
    if (typeof v === 'string') ackCfg[row.key] = v;
  }
  const ackMode = ackCfg['event_ack_mode'] || 'context_only';
  const ackPrompt = ackCfg['event_ack_prompt'] ||
    'Previously acknowledged by user — use only for pattern recognition context. ' +
    'Do not score, do not raise new findings for these events.';

  // ── Gather events in window ─────────────────────────────
  let eventQuery = db('events')
    .where({ system_id: system.id })
    .where('timestamp', '>=', window.from_ts)
    .where('timestamp', '<', window.to_ts)
    .select('id', 'message', 'severity', 'template_id', 'acknowledged_at')
    .orderBy('timestamp', 'asc')
    .limit(200); // Cap for LLM context

  // In "skip" mode, exclude acknowledged events entirely
  if (ackMode === 'skip') {
    eventQuery = eventQuery.whereNull('acknowledged_at');
  }

  const events = await eventQuery;

  if (events.length === 0) {
    console.log(`[${localTimestamp()}] Meta-analyze: no events in window ${windowId}`);
    return;
  }

  // ── Gather per-event scores ─────────────────────────────
  const eventIds = events.map((e: any) => e.id);
  const allScores: any[] = [];
  for (let i = 0; i < eventIds.length; i += 100) {
    const chunk = eventIds.slice(i, i + 100);
    const rows = await db('event_scores')
      .whereIn('event_id', chunk)
      .select('event_id', 'criterion_id', 'score');
    allScores.push(...rows);
  }

  // Build score map: event_id → ScoreResult
  const scoreMap = new Map<string, ScoreResult>();
  for (const row of allScores) {
    if (!scoreMap.has(row.event_id)) {
      scoreMap.set(row.event_id, {
        it_security: 0, performance_degradation: 0, failure_prediction: 0,
        anomaly: 0, compliance_audit: 0, operational_risk: 0,
      });
    }
    const criterion = CRITERIA.find((c) => c.id === Number(row.criterion_id));
    if (criterion) {
      (scoreMap.get(row.event_id)! as any)[criterion.slug] = Number(row.score);
    }
  }

  // Deduplicate by template for LLM input
  const templateGroups = new Map<string, {
    message: string; severity?: string; count: number;
    scores?: ScoreResult; acknowledged: boolean;
  }>();
  for (const event of events) {
    const key = event.template_id ?? event.id;
    if (!templateGroups.has(key)) {
      templateGroups.set(key, {
        message: event.message,
        severity: event.severity,
        count: 0,
        scores: scoreMap.get(event.id),
        acknowledged: !!event.acknowledged_at,
      });
    }
    templateGroups.get(key)!.count++;
  }

  const eventsForLlm = Array.from(templateGroups.values()).map((g) => {
    // In context_only mode, annotate acknowledged events with the ack prompt
    if (g.acknowledged && ackMode === 'context_only') {
      return {
        message: `[ACK] ${g.message} — ${ackPrompt}`,
        severity: g.severity,
        scores: g.scores,
        occurrenceCount: g.count,
      };
    }
    return {
      message: g.message,
      severity: g.severity,
      scores: g.scores,
      occurrenceCount: g.count,
    };
  });

  // ── Build historical context (sliding window) ───────────
  const context = await buildMetaContext(db, system.id, windowId);

  // ── Call LLM for meta-analysis ──────────────────────────
  const { result, usage } = await llm.metaAnalyze(
    eventsForLlm,
    system.description ?? '',
    sourceLabels,
    context,
    { systemPrompt: customPrompts.metaSystemPrompt },
  );

  // ── Persist everything in a transaction ─────────────────
  await db.transaction(async (trx) => {
    // Store meta_result (findings field kept for backward compat / fallback display)
    const metaId = uuidv4();
    await trx('meta_results').insert({
      id: metaId,
      window_id: windowId,
      meta_scores: JSON.stringify(result.meta_scores),
      summary: result.summary,
      findings: JSON.stringify(result.findingsFlat),
      recommended_action: result.recommended_action ?? null,
      key_event_ids: result.key_event_ids ? JSON.stringify(result.key_event_ids) : null,
    });

    // ── Persist structured findings ─────────────────────
    for (const finding of result.findings) {
      await trx('findings').insert({
        id: uuidv4(),
        system_id: system.id,
        meta_result_id: metaId,
        text: finding.text,
        severity: finding.severity,
        criterion_slug: finding.criterion ?? null,
        status: 'open',
      });
    }

    // ── Mark resolved findings ──────────────────────────
    if (result.resolvedFindingIndices.length > 0 && context.openFindings.length > 0) {
      const resolvedNow = new Date().toISOString();
      for (const idx of result.resolvedFindingIndices) {
        const openFinding = context.openFindings.find((f) => f.index === idx);
        if (!openFinding) continue;
        // The _dbId was stored when we built the context
        const dbId = (openFinding as any)._dbId;
        if (!dbId) continue;
        await trx('findings')
          .where({ id: dbId, status: 'open' })
          .update({
            status: 'resolved',
            resolved_at: resolvedNow,
            resolved_by_meta_id: metaId,
          });
      }
    }

    // ── Compute effective scores per criterion ──────────
    const now = new Date().toISOString();
    for (const criterion of CRITERIA) {
      const metaScore = (result.meta_scores as any)[criterion.slug] ?? 0;

      const maxEventRow = await trx('event_scores')
        .whereIn('event_id', eventIds)
        .where({ criterion_id: criterion.id })
        .max('score as max_score')
        .first();

      const maxEventScore = Number(maxEventRow?.max_score ?? 0);
      const effectiveValue = wMeta * metaScore + (1 - wMeta) * maxEventScore;

      await trx.raw(`
        INSERT INTO effective_scores (window_id, system_id, criterion_id, effective_value, meta_score, max_event_score, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (window_id, system_id, criterion_id)
        DO UPDATE SET effective_value = EXCLUDED.effective_value,
                      meta_score = EXCLUDED.meta_score,
                      max_event_score = EXCLUDED.max_event_score,
                      updated_at = EXCLUDED.updated_at
      `, [windowId, system.id, criterion.id, effectiveValue, metaScore, maxEventScore, now]);
    }

    // ── Track LLM usage ─────────────────────────────────
    await trx('llm_usage').insert({
      id: uuidv4(),
      run_type: 'meta',
      model: usage.model || null,
      system_id: system.id,
      window_id: windowId,
      event_count: events.length,
      token_input: usage.token_input,
      token_output: usage.token_output,
      request_count: usage.request_count,
      cost_estimate: usage.model ? estimateCost(usage.token_input, usage.token_output, usage.model) : null,
    });
  });

  console.log(
    `[${localTimestamp()}] Meta-analyze window ${windowId}: ` +
    `${events.length} events, ${eventsForLlm.length} templates, ` +
    `${result.findings.length} new findings, ${result.resolvedFindingIndices.length} resolved, ` +
    `tokens=${usage.token_input + usage.token_output}`,
  );
}

// ────────────────────────────────────────────────────────────────
// Context builder — gathers historical data for the LLM's
// "sliding context window".
// ────────────────────────────────────────────────────────────────

async function buildMetaContext(
  db: Knex,
  systemId: string,
  currentWindowId: string,
): Promise<MetaAnalysisContext & { openFindings: Array<{ index: number; text: string; severity: string; criterion?: string; _dbId: string }> }> {
  // 1. Previous window summaries (last N, excluding the current window)
  const prevMetas = await db('meta_results')
    .join('windows', 'meta_results.window_id', 'windows.id')
    .where('windows.system_id', systemId)
    .whereNot('windows.id', currentWindowId)
    .orderBy('windows.to_ts', 'desc')
    .limit(CONTEXT_WINDOW_SIZE)
    .select('meta_results.summary', 'windows.from_ts', 'windows.to_ts');

  const previousSummaries = prevMetas.map((m: any) => ({
    windowTime: `${formatShort(m.from_ts)} – ${formatShort(m.to_ts)}`,
    summary: m.summary,
  }));

  // 2. Currently open findings for this system (not acknowledged, not resolved)
  const openRows = await db('findings')
    .where({ system_id: systemId, status: 'open' })
    .orderBy('created_at', 'desc')
    .limit(30) // Cap to avoid huge prompts
    .select('id', 'text', 'severity', 'criterion_slug');

  const openFindings = openRows.map((f: any, i: number) => ({
    index: i,
    text: f.text,
    severity: f.severity,
    criterion: f.criterion_slug ?? undefined,
    _dbId: f.id, // internal: used to resolve by DB ID later
  }));

  return { previousSummaries, openFindings };
}

/** Format a timestamp concisely for the LLM context. */
function formatShort(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return ts;
  }
}
