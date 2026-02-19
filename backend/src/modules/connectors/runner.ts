import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { logger } from '../../config/logger.js';
import { localTimestamp } from '../../config/index.js';
import { getConnectorAdapter } from './registry.js';
import { normalizeEntry, computeNormalizedHash } from '../ingest/normalize.js';
import { redactEvent } from '../ingest/redact.js';
import { matchSource } from '../ingest/sourceMatch.js';
import { validateUrl } from './urlValidation.js';

/**
 * Connector runner: periodically polls all enabled pull connectors,
 * fetches logs, normalizes, and ingests them into the events table.
 */
export async function runConnectorPoll(db: Knex): Promise<void> {
  const connectors = await db('connectors').where({ enabled: true });

  for (const conn of connectors) {
    // Skip push-type connectors (they use the ingest API directly)
    if (conn.type === 'webhook' || conn.type === 'syslog') continue;

    const adapter = getConnectorAdapter(conn.type);
    if (!adapter) {
      logger.warn(`[${localTimestamp()}] No adapter for connector type "${conn.type}" (${conn.id})`);
      continue;
    }

    try {
      const config = typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config;

      // Validate URL at poll time (defense-in-depth, in case config changed in DB)
      if (config.url) {
        try {
          validateUrl(config.url);
        } catch (err) {
          logger.error(`[${localTimestamp()}] Connector "${conn.name}" URL validation failed:`, err);
          continue;
        }
      }

      // Get cursor
      const cursorRow = await db('connector_cursors').where({ connector_id: conn.id }).first();
      const cursor = cursorRow?.cursor_value ?? null;

      // Fetch logs
      const { events, newCursor } = await adapter.fetchLogs(config, cursor);

      if (events.length === 0) {
        // Update cursor even if no events (move forward in time)
        if (newCursor) {
          await upsertCursor(db, conn.id, newCursor);
        }
        continue;
      }

      // Normalize, redact, source match, persist
      const receivedAt = new Date().toISOString();
      const rows: any[] = [];

      for (const rawEvent of events) {
        const normalized = normalizeEntry({
          ...rawEvent,
          connector_id: conn.id,
        } as any);
        if (!normalized) continue;

        const sourceMatch = await matchSource(db, normalized);
        if (!sourceMatch) continue;

        const redacted = redactEvent(normalized);
        const hash = computeNormalizedHash(redacted);

        rows.push({
          id: uuidv4(),
          system_id: sourceMatch.system_id,
          log_source_id: sourceMatch.log_source_id,
          connector_id: conn.id,
          received_at: receivedAt,
          timestamp: redacted.timestamp,
          message: redacted.message,
          severity: redacted.severity ?? null,
          host: redacted.host ?? null,
          service: redacted.service ?? null,
          facility: redacted.facility ?? null,
          program: redacted.program ?? null,
          trace_id: redacted.trace_id ?? null,
          span_id: redacted.span_id ?? null,
          raw: redacted.raw ? JSON.stringify(redacted.raw) : null,
          normalized_hash: hash,
          external_id: redacted.external_id ?? null,
        });
      }

      // Batch insert + cursor update inside a transaction (atomicity)
      if (rows.length > 0) {
        await db.transaction(async (trx) => {
          for (let i = 0; i < rows.length; i += 100) {
            await trx('events').insert(rows.slice(i, i + 100));
          }
          if (newCursor) {
            await upsertCursorTrx(trx, conn.id, newCursor);
          }
        });
      } else if (newCursor) {
        await upsertCursor(db, conn.id, newCursor);
      }

      logger.debug(
        `[${localTimestamp()}] Connector "${conn.name}" (${conn.type}): fetched=${events.length}, ingested=${rows.length}`,
      );
    } catch (err) {
      logger.error(`[${localTimestamp()}] Connector "${conn.name}" (${conn.id}) error:`, err);
      // Cursor is NOT advanced on error, so next poll retries the same window.
      // This is intentional to avoid data loss, but may cause duplicates
      // if partial processing occurred before the error.
    }
  }
}

async function upsertCursor(db: Knex, connectorId: string, value: string): Promise<void> {
  await upsertCursorTrx(db, connectorId, value);
}

async function upsertCursorTrx(db: Knex, connectorId: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db.raw(`
    INSERT INTO connector_cursors (connector_id, cursor_key, cursor_value, updated_at)
    VALUES (?, 'last_timestamp', ?, ?)
    ON CONFLICT (connector_id)
    DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = EXCLUDED.updated_at
  `, [connectorId, value, now]);
}

/**
 * Start a periodic connector poll scheduler.
 * Returns a cleanup function.
 */
export function startConnectorScheduler(
  db: Knex,
  intervalMs: number = 60_000,
): { stop: () => void } {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runConnectorPoll(db);
    } finally {
      running = false;
    }
  }, intervalMs);

  logger.info(`[${localTimestamp()}] Connector scheduler started (interval=${intervalMs}ms).`);

  return {
    stop: () => {
      clearInterval(timer);
      logger.info(`[${localTimestamp()}] Connector scheduler stopped.`);
    },
  };
}
