import { config, localTimestamp } from './config/index.js';
import { initDb, closeDb } from './db/index.js';
import { ensureAdminKey } from './middleware/apiKeys.js';
import { getDb } from './db/index.js';
import { buildApp } from './app.js';
import { OpenAiAdapter } from './modules/llm/adapter.js';
import { startPipelineScheduler } from './modules/pipeline/orchestrator.js';
import { startConnectorScheduler } from './modules/connectors/runner.js';

/**
 * Parse a millisecond interval from an env var, with safe default.
 * Returns fallback if env is empty, non-numeric, or negative.
 */
function envIntervalMs(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  console.log(`[${localTimestamp()}] Starting SyslogCollectorAI backend…`);

  // 1. Initialize database (run migrations + seeds)
  await initDb();

  // 2. Ensure at least one admin API key exists
  const db = getDb();
  await ensureAdminKey(db, config.adminApiKey || undefined);

  // 3. Build and start Fastify app
  const app = await buildApp();

  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`[${localTimestamp()}] Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to start server:`, err);
    process.exit(1);
  }

  // 4. Start pipeline scheduler — always starts, checks AI config dynamically
  //    (API key may come from env or DB, and can be set/changed via UI at runtime)
  const llm = new OpenAiAdapter();
  const intervalMs = envIntervalMs(process.env.PIPELINE_INTERVAL_MS, 5 * 60 * 1000);
  const pipelineScheduler = startPipelineScheduler(db, llm, intervalMs);

  // 5. Start connector poll scheduler
  const connectorIntervalMs = envIntervalMs(process.env.CONNECTOR_POLL_INTERVAL_MS, 60_000);
  const connectorScheduler = startConnectorScheduler(db, connectorIntervalMs);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[${localTimestamp()}] Received ${signal}, shutting down…`);
    connectorScheduler.stop();
    pipelineScheduler?.stop();
    try {
      await app.close();
      await closeDb();
    } catch (err) {
      console.error(`[${localTimestamp()}] Error during shutdown:`, err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
}

main().catch((err) => {
  console.error(`[${localTimestamp()}] Fatal error:`, err);
  process.exit(1);
});
