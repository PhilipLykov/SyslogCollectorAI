import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { resolveAiConfig, resolveCustomPrompts } from '../llm/aiConfig.js';
import { DEFAULT_RAG_SYSTEM_PROMPT } from '../llm/adapter.js';

/**
 * RAG-style natural language query endpoint.
 *
 * Builds context from stored meta summaries, findings, and event snippets.
 * Calls LLM with a RAG-style prompt. Returns a short answer.
 *
 * OWASP A03: Sanitize question to reduce prompt injection.
 * Note: Full prompt injection prevention for LLM is an evolving challenge.
 * The question is placed inside a clearly delimited block.
 */
export interface RagResult {
  answer: string;
  context_used: number;
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

  // Build context from recent meta results
  let metaQuery = db('meta_results')
    .join('windows', 'meta_results.window_id', 'windows.id')
    .join('monitored_systems', 'windows.system_id', 'monitored_systems.id')
    .orderBy('meta_results.created_at', 'desc')
    .limit(20)
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

  const metaRows = await metaQuery;

  const contextParts = metaRows.map((r: any) => {
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

  const context = contextParts.join('\n---\n');

  // Resolve custom RAG prompt (if configured by user), fall back to default
  const customPrompts = await resolveCustomPrompts(db);
  const systemPrompt = customPrompts.ragSystemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT;

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
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 500,
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

  console.log(`[${localTimestamp()}] RAG query answered (context=${metaRows.length} windows)`);

  return { answer, context_used: metaRows.length };
}
