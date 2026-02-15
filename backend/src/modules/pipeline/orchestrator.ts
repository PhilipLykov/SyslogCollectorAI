import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { type LlmAdapter, OpenAiAdapter } from '../llm/adapter.js';
import { resolveAiConfig } from '../llm/aiConfig.js';
import { runPerEventScoringJob } from './scoringJob.js';
import { createWindows } from './windowing.js';
import { metaAnalyzeWindow } from './metaAnalyze.js';
import { evaluateAlerts } from '../alerting/evaluator.js';

/** Load pipeline config from app_config, falling back to defaults. */
async function loadPipelineConfig(db: Knex): Promise<{
  pipeline_interval_minutes: number;
  window_minutes: number;
  scoring_limit_per_run: number;
  effective_score_meta_weight: number;
}> {
  const DEFAULTS = {
    pipeline_interval_minutes: 5,
    window_minutes: 5,
    scoring_limit_per_run: 500,
    effective_score_meta_weight: 0.7,
  };
  try {
    const row = await db('app_config').where({ key: 'pipeline_config' }).first('value');
    if (!row) return DEFAULTS;
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    if (raw && typeof raw === 'object') {
      return { ...DEFAULTS, ...(raw as Partial<typeof DEFAULTS>) };
    }
    return DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/**
 * Sync the adapter's config from the DB (app_config table), falling
 * back to environment variables. Called before each pipeline run so
 * changes made via the UI take effect without a restart.
 */
async function syncAdapterConfig(db: Knex, llm: OpenAiAdapter): Promise<void> {
  const cfg = await resolveAiConfig(db);
  llm.updateConfig({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl });
}

/**
 * Pipeline orchestrator: runs the full scoring pipeline periodically.
 *
 * 1. Per-event scoring (dedup + LLM)
 * 2. Create windows
 * 3. Meta-analyze each new window
 * 4. Evaluate alerts only for windows that were successfully meta-analyzed
 *
 * Call this on a schedule (e.g. every 5 minutes) or after ingest.
 */
export async function runPipeline(
  db: Knex,
  llm: LlmAdapter,
  options?: { windowMinutes?: number; wMeta?: number; scoringLimit?: number },
): Promise<void> {
  const start = Date.now();
  console.log(`[${localTimestamp()}] Pipeline run started.`);

  try {
    // Load pipeline config from DB (runtime-configurable via UI)
    const pipeCfg = await loadPipelineConfig(db);

    // 1. Per-event scoring
    const scoringResult = await runPerEventScoringJob(db, llm, {
      limit: options?.scoringLimit ?? pipeCfg.scoring_limit_per_run,
    });

    // 2. Create windows
    const windows = await createWindows(db, {
      windowMinutes: options?.windowMinutes ?? pipeCfg.window_minutes,
    });

    // 3. Meta-analyze each new window, track which succeed
    const analyzedWindows: typeof windows = [];
    for (const w of windows) {
      try {
        await metaAnalyzeWindow(db, llm, w.id, {
          wMeta: options?.wMeta ?? pipeCfg.effective_score_meta_weight,
        });
        analyzedWindows.push(w);
      } catch (err) {
        console.error(`[${localTimestamp()}] Meta-analyze failed for window ${w.id}:`, err);
        // Don't evaluate alerts for failed windows (would cause false resolutions)
      }
    }

    // 4. Evaluate alerting rules ONLY for successfully analyzed windows
    for (const w of analyzedWindows) {
      try {
        await evaluateAlerts(db, w.id);
      } catch (err) {
        console.error(`[${localTimestamp()}] Alert evaluation failed for window ${w.id}:`, err);
      }
    }

    const elapsed = Date.now() - start;
    console.log(
      `[${localTimestamp()}] Pipeline run complete in ${elapsed}ms. Scored=${scoringResult.scored}, Windows=${windows.length}, Analyzed=${analyzedWindows.length}`,
    );
  } catch (err) {
    console.error(`[${localTimestamp()}] Pipeline run failed:`, err);
  }
}

/**
 * Start a periodic pipeline runner.
 * Syncs AI config from DB before each run and skips if no API key.
 * Returns a cleanup function to stop the interval.
 */
export function startPipelineScheduler(
  db: Knex,
  llm: OpenAiAdapter,
  intervalMs: number = 5 * 60 * 1000, // initial default 5 minutes
): { stop: () => void } {
  let running = false;
  let stopped = false;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (stopped) return;
    if (running) {
      console.log(`[${localTimestamp()}] Pipeline: previous run still in progress, skipping.`);
      scheduleNext();
      return;
    }
    running = true;
    try {
      // Sync config from DB before each run (picks up UI changes)
      await syncAdapterConfig(db, llm);

      if (!llm.isConfigured()) {
        // No API key from any source — skip silently
        return;
      }

      await runPipeline(db, llm);
    } finally {
      running = false;
      scheduleNext();
    }
  }

  async function scheduleNext() {
    if (stopped) return;
    // Read the latest pipeline interval from DB (supports runtime changes via UI)
    let nextMs = intervalMs;
    try {
      const cfg = await loadPipelineConfig(db);
      const cfgMs = cfg.pipeline_interval_minutes * 60 * 1000;
      if (cfgMs >= 60_000 && cfgMs <= 3_600_000) nextMs = cfgMs;
    } catch { /* use default */ }
    currentTimer = setTimeout(tick, nextMs);
  }

  console.log(`[${localTimestamp()}] Pipeline scheduler started (initial interval=${intervalMs}ms, reads from DB).`);
  // Start the first tick after the initial interval
  currentTimer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (currentTimer) clearTimeout(currentTimer);
      console.log(`[${localTimestamp()}] Pipeline scheduler stopped.`);
    },
  };
}
