import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { type LlmAdapter, OpenAiAdapter } from '../llm/adapter.js';
import { resolveAiConfig } from '../llm/aiConfig.js';
import { runPerEventScoringJob } from './scoringJob.js';
import { createWindows } from './windowing.js';
import { metaAnalyzeWindow } from './metaAnalyze.js';
import { evaluateAlerts } from '../alerting/evaluator.js';

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
    // 1. Per-event scoring
    const scoringResult = await runPerEventScoringJob(db, llm, { limit: options?.scoringLimit ?? 500 });

    // 2. Create windows
    const windows = await createWindows(db, { windowMinutes: options?.windowMinutes });

    // 3. Meta-analyze each new window, track which succeed
    const analyzedWindows: typeof windows = [];
    for (const w of windows) {
      try {
        await metaAnalyzeWindow(db, llm, w.id, { wMeta: options?.wMeta });
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
  intervalMs: number = 5 * 60 * 1000, // default 5 minutes
): { stop: () => void } {
  let running = false;

  const timer = setInterval(async () => {
    if (running) {
      console.log(`[${localTimestamp()}] Pipeline: previous run still in progress, skipping.`);
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
    }
  }, intervalMs);

  console.log(`[${localTimestamp()}] Pipeline scheduler started (interval=${intervalMs}ms).`);

  return {
    stop: () => {
      clearInterval(timer);
      console.log(`[${localTimestamp()}] Pipeline scheduler stopped.`);
    },
  };
}
