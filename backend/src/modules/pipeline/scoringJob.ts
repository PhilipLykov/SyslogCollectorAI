import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { extractTemplatesAndDedup, type TemplateRepresentative } from './dedup.js';
import { type LlmAdapter, type ScoreResult } from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';
import { CRITERIA } from '../../types/index.js';
import { resolveCustomPrompts, resolveCriterionGuidelines, resolveTaskModels } from '../llm/aiConfig.js';
import { buildScoringPrompt } from '../llm/adapter.js';
import { loadPrivacyFilterConfig, filterEventForLlm } from '../llm/llmPrivacyFilter.js';
import { getDefaultEventSource, getEventSource } from '../../services/eventSourceFactory.js';
import { loadNormalBehaviorTemplates, filterNormalBehaviorEvents } from './normalBehavior.js';

// ── Token Optimization config type ──────────────────────────
export interface TokenOptimizationConfig {
  score_cache_enabled: boolean;
  score_cache_ttl_minutes: number;
  severity_filter_enabled: boolean;
  severity_skip_levels: string[];
  severity_default_score: number;
  message_max_length: number;
  scoring_batch_size: number;
  low_score_auto_skip_enabled: boolean;
  low_score_threshold: number;
  low_score_min_scorings: number;
  meta_max_events: number;
  meta_prioritize_high_scores: boolean;
  /** O1: Skip meta-analysis LLM call when all events in window scored 0. */
  skip_zero_score_meta: boolean;
  /** O2: Filter zero-score events from meta-analysis prompt to save tokens. */
  filter_zero_score_meta_events: boolean;
}

const DEFAULT_TOKEN_OPT: TokenOptimizationConfig = {
  score_cache_enabled: true,
  score_cache_ttl_minutes: 360,
  severity_filter_enabled: false,
  severity_skip_levels: ['debug'],
  severity_default_score: 0,
  message_max_length: 512,
  scoring_batch_size: 20,
  low_score_auto_skip_enabled: false,
  low_score_threshold: 0.05,
  low_score_min_scorings: 5,
  meta_max_events: 200,
  meta_prioritize_high_scores: true,
  skip_zero_score_meta: true,
  filter_zero_score_meta_events: true,
};

/** Load token optimization config from app_config, with defaults. */
export async function loadTokenOptConfig(db: Knex): Promise<TokenOptimizationConfig> {
  try {
    const row = await db('app_config').where({ key: 'token_optimization' }).first('value');
    if (!row) return { ...DEFAULT_TOKEN_OPT };
    let parsed = row.value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return { ...DEFAULT_TOKEN_OPT }; }
    }
    // Merge with defaults so any new keys added in future migrations are present
    return { ...DEFAULT_TOKEN_OPT, ...(parsed as Partial<TokenOptimizationConfig>) };
  } catch {
    return { ...DEFAULT_TOKEN_OPT };
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Build an empty (zero) ScoreResult. */
function emptyScoreResult(defaultVal = 0): ScoreResult {
  return {
    it_security: defaultVal,
    performance_degradation: defaultVal,
    failure_prediction: defaultVal,
    anomaly: defaultVal,
    compliance_audit: defaultVal,
    operational_risk: defaultVal,
  };
}

/** Compute the max criterion value from a ScoreResult. */
function maxScore(s: ScoreResult): number {
  return Math.max(
    s.it_security, s.performance_degradation, s.failure_prediction,
    s.anomaly, s.compliance_audit, s.operational_risk,
  );
}

/** Truncate a message to maxLen, appending a marker if truncated. */
function truncateMessage(msg: string, maxLen: number): string {
  if (maxLen <= 0 || msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen) + ' [...truncated]';
}

/**
 * Per-event scoring job with token optimisation.
 *
 * Pipeline:
 * 1. Fetch unscored events.
 * 2. Run dedup / template extraction.
 * 3. Partition templates: severity-skip → cache-hit → low-score-skip → needs LLM.
 * 4. Score remaining via LLM (batched, messages truncated).
 * 5. Write event_scores for ALL templates (cached + LLM).
 * 6. Update template cache columns.
 * 7. Track LLM usage with optimisation stats.
 */
export async function runPerEventScoringJob(
  db: Knex,
  llm: LlmAdapter,
  options?: { limit?: number; systemId?: string },
): Promise<{ scored: number; templates: number; errors: number }> {
  const limit = options?.limit ?? 500;

  console.log(`[${localTimestamp()}] Per-event scoring job started (limit=${limit})`);

  // ── Load configs ─────────────────────────────────────────
  const customPrompts = await resolveCustomPrompts(db);
  const criterionGuidelines = await resolveCriterionGuidelines(db);
  const opt = await loadTokenOptConfig(db);

  // Assemble the effective scoring prompt:
  // If the user set a full custom scoring prompt override, use it as-is.
  // Otherwise, build the prompt from the base template + per-criterion guidelines.
  const effectiveScoringPrompt = customPrompts.scoringSystemPrompt
    ?? buildScoringPrompt(Object.keys(criterionGuidelines).length > 0 ? criterionGuidelines : undefined);

  const batchSize = Math.max(1, Math.min(opt.scoring_batch_size, 100));

  // 1. Fetch unscored, unacknowledged events — via EventSource abstraction
  //    Dispatch to each system's event source to support ES-backed systems.
  let unscoredEvents: any[];
  if (options?.systemId) {
    // Single system — use its specific event source
    const system = await db('monitored_systems').where({ id: options.systemId }).first();
    const es = system ? getEventSource(system, db) : getDefaultEventSource(db);
    unscoredEvents = await es.getUnscoredEvents(options.systemId, limit);
  } else {
    // All systems — collect unscored events from each system's event source
    const systems = await db('monitored_systems').select('*');
    unscoredEvents = [];
    const perSystemLimit = Math.max(10, Math.floor(limit / Math.max(systems.length, 1)));
    for (const sys of systems) {
      const es = getEventSource(sys, db);
      const batch = await es.getUnscoredEvents(sys.id, perSystemLimit);
      unscoredEvents.push(...batch);
      if (unscoredEvents.length >= limit) break;
    }
    unscoredEvents = unscoredEvents.slice(0, limit);
  }

  if (unscoredEvents.length === 0) {
    console.log(`[${localTimestamp()}] Per-event scoring: no unscored events found.`);
    return { scored: 0, templates: 0, errors: 0 };
  }

  // ── 1b. Exclude normal-behavior events ─────────────────────
  // Load templates once, then filter. Excluded events get zero scores
  // so they won't be re-fetched as "unscored" on the next run.
  const normalTemplates = await loadNormalBehaviorTemplates(db, options?.systemId);
  if (normalTemplates.length > 0) {
    const { filtered, excluded, excludedCount } = filterNormalBehaviorEvents(unscoredEvents, normalTemplates);
    if (excludedCount > 0) {
      console.log(
        `[${localTimestamp()}] Per-event scoring: ${excludedCount} events excluded as normal behavior`,
      );
      // Write zero scores for excluded events so they are marked as "scored"
      for (const evt of excluded) {
        const zeroScores: ScoreResult = {} as any;
        for (const c of CRITERIA) {
          (zeroScores as any)[c.slug] = 0;
        }
        await writeEventScores(db, evt.id, zeroScores);
      }
      unscoredEvents = filtered;
    }
  }

  if (unscoredEvents.length === 0) {
    console.log(`[${localTimestamp()}] Per-event scoring: all events matched normal behavior templates.`);
    return { scored: 0, templates: 0, errors: 0 };
  }

  const unscoredEventIds = new Set(unscoredEvents.map((e: any) => e.id));

  // 2. Dedup / template extraction
  const representatives = await extractTemplatesAndDedup(db, unscoredEvents);

  // Build event lookup map
  const eventMap = new Map(unscoredEvents.map((e: any) => [e.id, e]));

  // ── 3. Partition templates by optimisation strategy ──────

  // Pre-load template metadata for cache/low-score checks
  const templateIds = representatives.map((r) => r.templateId);
  const templateMeta = new Map<string, {
    last_scored_at: string | null;
    cached_scores: any;
    score_count: number;
    avg_max_score: number | null;
  }>();

  if (templateIds.length > 0) {
    for (let i = 0; i < templateIds.length; i += 200) {
      const chunk = templateIds.slice(i, i + 200);
      const rows = await db('message_templates')
        .whereIn('id', chunk)
        .select('id', 'last_scored_at', 'cached_scores', 'score_count', 'avg_max_score');
      for (const r of rows) {
        templateMeta.set(r.id, {
          last_scored_at: r.last_scored_at,
          cached_scores: r.cached_scores,
          score_count: Number(r.score_count) || 0,
          avg_max_score: r.avg_max_score != null ? Number(r.avg_max_score) : null,
        });
      }
    }
  }

  const now = Date.now();
  const cacheTtlMs = opt.score_cache_ttl_minutes * 60 * 1000;
  const skipSeverities = new Set(
    (opt.severity_skip_levels ?? []).map((s: string) => s.toLowerCase()),
  );

  const severitySkipped: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
  const cacheHits: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
  const lowScoreSkipped: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
  const needsScoring: TemplateRepresentative[] = [];

  for (const rep of representatives) {
    const event = eventMap.get(rep.representativeEventId);
    const severity = (event?.severity ?? '').toLowerCase();

    // Strategy 1: Severity pre-filter
    if (opt.severity_filter_enabled && severity && skipSeverities.has(severity)) {
      severitySkipped.push({ rep, score: emptyScoreResult(opt.severity_default_score) });
      continue;
    }

    // Strategy 2: Score cache
    if (opt.score_cache_enabled) {
      const meta = templateMeta.get(rep.templateId);
      if (meta?.last_scored_at && meta.cached_scores) {
        const scoredAt = new Date(meta.last_scored_at).getTime();
        if (now - scoredAt < cacheTtlMs) {
          // Cache hit — parse the cached scores
          let cached = meta.cached_scores;
          if (typeof cached === 'string') {
            try { cached = JSON.parse(cached); } catch { cached = null; }
          }
          if (cached && typeof cached === 'object') {
            const scoreResult: ScoreResult = {
              it_security: Number(cached.it_security) || 0,
              performance_degradation: Number(cached.performance_degradation) || 0,
              failure_prediction: Number(cached.failure_prediction) || 0,
              anomaly: Number(cached.anomaly) || 0,
              compliance_audit: Number(cached.compliance_audit) || 0,
              operational_risk: Number(cached.operational_risk) || 0,
            };
            cacheHits.push({ rep, score: scoreResult });
            continue;
          }
        }
      }
    }

    // Strategy 3: Low-score auto-skip
    if (opt.low_score_auto_skip_enabled) {
      const meta = templateMeta.get(rep.templateId);
      if (
        meta &&
        meta.score_count >= opt.low_score_min_scorings &&
        meta.avg_max_score !== null &&
        meta.avg_max_score < opt.low_score_threshold
      ) {
        lowScoreSkipped.push({ rep, score: emptyScoreResult(0) });
        continue;
      }
    }

    needsScoring.push(rep);
  }

  console.log(
    `[${localTimestamp()}] Token optimisation: ${representatives.length} templates → ` +
    `${severitySkipped.length} severity-skipped, ${cacheHits.length} cache-hits, ` +
    `${lowScoreSkipped.length} low-score-skipped, ${needsScoring.length} need LLM`,
  );

  // ── 4. Write scores for skipped/cached templates ────────

  let scored = 0;
  let errors = 0;
  let totalTokenInput = 0;
  let totalTokenOutput = 0;
  let totalRequests = 0;
  let usedModel = '';

  const allSkipped = [...severitySkipped, ...cacheHits, ...lowScoreSkipped];
  for (const { rep, score } of allSkipped) {
    try {
      const linkedEvents = await db('events')
        .where({ template_id: rep.templateId })
        .whereIn('id', Array.from(unscoredEventIds))
        .select('id');

      if (linkedEvents.length > 0) {
        await db.transaction(async (trx) => {
          for (const le of linkedEvents) {
            await writeEventScores(trx, le.id, score);
          }
        });
        scored += linkedEvents.length;
      }
    } catch (err) {
      console.error(`[${localTimestamp()}] Error writing cached/skipped scores for template ${rep.templateId}:`, err);
      errors++;
    }
  }

  // ── 5. Score remaining templates via LLM ────────────────

  // Map from templateId → ScoreResult (used to update cache after all batches)
  const freshScores = new Map<string, ScoreResult>();

  for (let i = 0; i < needsScoring.length; i += batchSize) {
    const batch = needsScoring.slice(i, i + batchSize);

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

        // Build events for LLM with message truncation (Strategy 4) and privacy filtering
        const privacyConfig = await loadPrivacyFilterConfig(db);
        const eventsForLlm = systemBatch.map((r) => {
          const event = eventMap.get(r.representativeEventId);
          const raw = {
            message: truncateMessage(r.representativeMessage, opt.message_max_length),
            severity: event?.severity,
            host: event?.host,
            source_ip: event?.source_ip,
            program: event?.program,
          };
          return filterEventForLlm(raw, privacyConfig);
        });

        // Resolve per-task model override for scoring
        const taskModels = await resolveTaskModels(db);

        // Call LLM
        const { scores, usage } = await llm.scoreEvents(
          eventsForLlm,
          system?.description ?? '',
          sourceLabels,
          {
            systemPrompt: effectiveScoringPrompt,
            modelOverride: taskModels.scoring_model || undefined,
          },
        );

        totalTokenInput += usage.token_input;
        totalTokenOutput += usage.token_output;
        totalRequests += usage.request_count;
        if (!usedModel && usage.model) usedModel = usage.model;

        // Write scores for each template
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

          freshScores.set(rep.templateId, scoreResult);

          const linkedEvents = await db('events')
            .where({ template_id: rep.templateId })
            .whereIn('id', Array.from(unscoredEventIds))
            .select('id');

          await db.transaction(async (trx) => {
            for (const le of linkedEvents) {
              await writeEventScores(trx, le.id, scoreResult);
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

  // ── 6. Update template cache columns ────────────────────

  if (freshScores.size > 0) {
    const nowIso = new Date().toISOString();
    for (const [templateId, scoreResult] of freshScores) {
      try {
        const ms = maxScore(scoreResult);
        const meta = templateMeta.get(templateId);
        const prevCount = meta?.score_count ?? 0;
        const prevAvg = meta?.avg_max_score ?? 0;
        // Incremental average: avg_new = (avg_old * count + new_val) / (count + 1)
        const newCount = prevCount + 1;
        const newAvg = (prevAvg * prevCount + ms) / newCount;

        await db('message_templates').where({ id: templateId }).update({
          last_scored_at: nowIso,
          cached_scores: JSON.stringify(scoreResult),
          score_count: newCount,
          avg_max_score: Number(newAvg.toFixed(4)),
        });
      } catch (err) {
        // Non-critical — cache update failure shouldn't fail the job
        console.warn(`[${localTimestamp()}] Failed to update template cache for ${templateId}:`, err);
      }
    }
  }

  // ── 7. Track LLM usage ──────────────────────────────────

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

  const llmScoredCount = needsScoring.length;
  const savedCount = allSkipped.length;
  console.log(
    `[${localTimestamp()}] Per-event scoring complete: scored=${scored}, templates=${representatives.length}, ` +
    `LLM-scored=${llmScoredCount}, cache/skip-saved=${savedCount}, errors=${errors}, ` +
    `tokens=${totalTokenInput + totalTokenOutput}`,
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

  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const values = rows.flatMap((r) => [r.id, r.event_id, r.criterion_id, r.score, r.score_type]);

  await db.raw(`
    INSERT INTO event_scores (id, event_id, criterion_id, score, score_type)
    VALUES ${placeholders}
    ON CONFLICT (event_id, criterion_id, score_type) DO NOTHING
  `, values);
}
