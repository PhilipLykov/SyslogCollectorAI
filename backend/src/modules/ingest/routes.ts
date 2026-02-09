import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { localTimestamp } from '../../config/index.js';
import { normalizeEntry, computeNormalizedHash } from './normalize.js';
import { redactEvent } from './redact.js';
import { matchSource } from './sourceMatch.js';
import type { IngestEntry, IngestResponse } from '../../types/index.js';

const MAX_BATCH_SIZE = 1000;

/**
 * Extract the entries array from the request body.
 *
 * Accepts three formats for maximum log-shipper compatibility:
 *   1. { "events": [ ... ] }           — canonical format
 *   2. [ { ... }, { ... } ]            — bare JSON array (rsyslog omhttp, Fluent Bit batch)
 *   3. { "message": "...", ... }       — single event object (one-at-a-time shippers)
 */
function extractEntries(body: unknown): unknown[] | null {
  if (!body) return null;

  // Format 2: bare JSON array
  if (Array.isArray(body)) {
    return body.length > 0 ? body : null;
  }

  if (typeof body === 'object') {
    const obj = body as Record<string, unknown>;

    // Format 1: { events: [...] }
    if (Array.isArray(obj.events)) {
      return (obj.events as unknown[]).length > 0 ? (obj.events as unknown[]) : null;
    }

    // Format 3: single event object (must have "message" to be a valid event)
    if (typeof obj.message === 'string' || typeof obj.msg === 'string') {
      return [obj];
    }
  }

  return null;
}

/**
 * POST /api/v1/ingest
 *
 * Accept a batch of log entries, normalize, redact, match source, persist.
 * Auth: API key with scope 'ingest' or 'admin'.
 * OWASP: A01 (auth), A03 (parameterized queries via Knex).
 */
export async function registerIngestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/ingest',
    { preHandler: requireAuth('ingest', 'admin') },
    async (request, reply) => {
      const entries = extractEntries(request.body);

      if (!entries) {
        return reply.code(400).send({
          error: 'Request body must be: {"events":[...]}, a JSON array [...], or a single event object.',
        });
      }

      if (entries.length > MAX_BATCH_SIZE) {
        return reply.code(400).send({
          error: `Batch too large. Maximum ${MAX_BATCH_SIZE} events per request.`,
        });
      }

      const db = getDb();
      let accepted = 0;
      let rejected = 0;
      const errors: string[] = [];
      const receivedAt = new Date().toISOString(); // Single timestamp for entire batch

      // Collect rows for batch insert
      const rows: any[] = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        // Guard: skip null/undefined/non-object entries
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          rejected++;
          errors.push(`Entry ${i}: must be a non-null object.`);
          continue;
        }

        // 1. Normalize
        const normalized = normalizeEntry(entry as IngestEntry);
        if (!normalized) {
          rejected++;
          errors.push(`Entry ${i}: missing or empty "message" field.`);
          continue;
        }

        // 2. Source match
        const match = await matchSource(db, normalized);
        if (!match) {
          rejected++;
          errors.push(`Entry ${i}: no matching log source found.`);
          continue;
        }

        // 3. Redact (if enabled)
        const redacted = redactEvent(normalized);

        // 4. Compute normalized hash (on redacted content)
        const normalizedHash = computeNormalizedHash(redacted);

        // 5. Build row
        rows.push({
          id: uuidv4(),
          system_id: match.system_id,
          log_source_id: match.log_source_id,
          connector_id: redacted.connector_id ?? null,
          received_at: receivedAt,
          timestamp: redacted.timestamp,
          message: redacted.message,
          severity: redacted.severity ?? null,
          host: redacted.host ?? null,
          source_ip: redacted.source_ip ?? null,
          service: redacted.service ?? null,
          facility: redacted.facility ?? null,
          program: redacted.program ?? null,
          trace_id: redacted.trace_id ?? null,
          span_id: redacted.span_id ?? null,
          raw: redacted.raw ? JSON.stringify(redacted.raw) : null,
          normalized_hash: normalizedHash,
          external_id: redacted.external_id ?? null,
        });

        accepted++;
      }

      // Batch insert inside a transaction (all-or-nothing)
      if (rows.length > 0) {
        try {
          await db.transaction(async (trx) => {
            const CHUNK_SIZE = 100;
            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
              await trx('events').insert(rows.slice(i, i + CHUNK_SIZE));
            }
          });
        } catch (err) {
          app.log.error(`[${localTimestamp()}] Ingest batch insert failed: ${err}`);
          return reply.code(500).send({ error: 'Failed to persist events.' });
        }
      }

      app.log.info(
        { accepted, rejected, ip: request.ip },
        `[${localTimestamp()}] Ingest complete`,
      );

      const response: IngestResponse = { accepted, rejected };
      if (errors.length > 0) {
        response.errors = errors;
      }

      return reply.code(accepted > 0 ? 200 : 400).send(response);
    },
  );
}
