import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { extractTemplatesAndDedup } from './dedup.js';
import { type LlmAdapter, type ScoreResult } from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';
import { CRITERIA } from '../../types/index.js';
import { resolveCustomPrompts } from '../llm/aiConfig.js';

const SCORING_BATCH_SIZE = 20; // Max events per LLM call

/**
 * Per-event scoring job.
 *
 * 1. Fetch unscored events from the database.
 * 2. Run dedup/template extraction.
 * 3. For each template representative, call LLM for 6-criteria scores.
 * 4. Write scores ONLY for unscored events (avoid duplicates).
 * 5. Track LLM usage.
 */
export async function runPerEventScoringJob(
  db: Knex,
  llm: LlmAdapter,
  options?: { limit?: number; systemId?: string },
): Promise<{ scored: number; templates: number; errors: number }> {
  const limit = options?.limit ?? 500;

  console.log(`[${localTimestamp()}] Per-event scoring job started (limit=${limit})`);

  // Resolve custom system prompt (if configured by user)
  const customPrompts = await resolveCustomPrompts(db);

  // 1. Fetch unscored events (events without any event_scores entry)
  //    Skip acknowledged events — they are excluded from LLM scoring entirely.
  let query = db('events')
    .leftJoin('event_scores', 'events.id', 'event_scores.event_id')
    .whereNull('event_scores.id')
    .whereNull('events.acknowledged_at')
    .select('events.id', 'events.system_id', 'events.message', 'events.severity',
            'events.host', 'events.program', 'events.log_source_id')
    .limit(limit);

  if (options?.systemId) {
    query = query.where('events.system_id', options.systemId);
  }

  const unscoredEvents = await query;

  if (unscoredEvents.length === 0) {
    console.log(`[${localTimestamp()}] Per-event scoring: no unscored events found.`);
    return { scored: 0, templates: 0, errors: 0 };
  }

  // Track which event IDs from this batch are unscored (to avoid re-scoring)
  const unscoredEventIds = new Set(unscoredEvents.map((e: any) => e.id));

  // 2. Dedup and template extraction
  const representatives = await extractTemplatesAndDedup(db, unscoredEvents);

  let scored = 0;
  let errors = 0;
  let totalTokenInput = 0;
  let totalTokenOutput = 0;
  let totalRequests = 0;
  let usedModel = ''; // Captured from the first LLM response

  // 3. Score in batches
  for (let i = 0; i < representatives.length; i += SCORING_BATCH_SIZE) {
    const batch = representatives.slice(i, i + SCORING_BATCH_SIZE);

    // Get system context for the batch
    const systemIds = [...new Set(
      batch.map((r) => r.systemId).filter((id): id is string => id !== null && id !== undefined && id !== ''),
    )];

    for (const systemId of systemIds) {
      const systemBatch = batch.filter((r) => r.systemId === systemId);
      if (systemBatch.length === 0) continue;

      try {
        const system = await db('monitored_systems').where({ id: systemId }).first();
        const sources = await db('log_sources').where({ system_id: systemId }).select('label');
        const sourceLabels = sources.map((s: any) => s.label);

        // Build lookup map for O(1) event access (avoids O(n*m) linear scan)
        const eventMap = new Map(unscoredEvents.map((e: any) => [e.id, e]));
        const eventsForLlm = systemBatch.map((r) => {
          const event = eventMap.get(r.representativeEventId);
          return {
            message: r.representativeMessage,
            severity: event?.severity,
            host: event?.host,
            program: event?.program,
          };
        });

        // Call LLM
        const { scores, usage } = await llm.scoreEvents(
          eventsForLlm,
          system?.description ?? '',
          sourceLabels,
          { systemPrompt: customPrompts.scoringSystemPrompt },
        );

        totalTokenInput += usage.token_input;
        totalTokenOutput += usage.token_output;
        totalRequests += usage.request_count;
        if (!usedModel && usage.model) usedModel = usage.model;

        // 4. Write scores only for unscored events in this batch
        for (let j = 0; j < systemBatch.length; j++) {
          const rep = systemBatch[j];
          const scoreResult = scores[j];

          if (!scoreResult) {
            console.warn(
              `[${localTimestamp()}] LLM returned ${scores.length} scores for ${systemBatch.length} templates. Template ${j} has no score.`,
            );
            errors++;
            continue;
          }

          // Only score events from our current unscored batch (not all events linked to template)
          const linkedEvents = await db('events')
            .where({ template_id: rep.templateId })
            .whereIn('id', Array.from(unscoredEventIds))
            .select('id');

          // Write scores inside a transaction
          await db.transaction(async (trx) => {
            for (const linkedEvent of linkedEvents) {
              await writeEventScores(trx, linkedEvent.id, scoreResult);
            }
          });

          scored += linkedEvents.length;
        }
      } catch (err) {
        console.error(`[${localTimestamp()}] Per-event scoring error for system ${systemId}:`, err);
        errors += systemBatch.length;
      }
    }
  }

  // 5. Track LLM usage (model + cost locked in at insert time)
  if (totalRequests > 0) {
    await db('llm_usage').insert({
      id: uuidv4(),
      run_type: 'per_event',
      model: usedModel || null,
      system_id: options?.systemId ?? null,
      event_count: scored,
      token_input: totalTokenInput,
      token_output: totalTokenOutput,
      request_count: totalRequests,
      cost_estimate: usedModel ? estimateCost(totalTokenInput, totalTokenOutput, usedModel) : null,
    });
  }

  console.log(
    `[${localTimestamp()}] Per-event scoring complete: scored=${scored}, templates=${representatives.length}, errors=${errors}, tokens=${totalTokenInput + totalTokenOutput}`,
  );

  return { scored, templates: representatives.length, errors };
}

async function writeEventScores(db: Knex, eventId: string, scores: ScoreResult): Promise<void> {
  const rows = CRITERIA.map((c) => ({
    id: uuidv4(),
    event_id: eventId,
    criterion_id: c.id,
    score: (scores as any)[c.slug] ?? 0,
    score_type: 'event',
  }));

  // Batch all 6 criteria into a single multi-row INSERT for performance
  // (reduces 6 round-trips to 1 per event, and avoids prolonged lock contention)
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const values = rows.flatMap((r) => [r.id, r.event_id, r.criterion_id, r.score, r.score_type]);

  await db.raw(`
    INSERT INTO event_scores (id, event_id, criterion_id, score, score_type)
    VALUES ${placeholders}
    ON CONFLICT (event_id, criterion_id, score_type) DO NOTHING
  `, values);
}
