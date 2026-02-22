import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { normalizeEntry, computeNormalizedHash, flattenECS, cleanTransportAddress, applyTimezoneOffset, applyTimezoneByName, clampFutureTimestamp } from './normalize.js';
import { redactEvent } from './redact.js';
import { matchSource } from './sourceMatch.js';
import { reassembleMultilineEntries } from './multiline.js';
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
    { preHandler: requireAuth(PERMISSIONS.INGEST) },
    async (request, reply) => {
      const rawEntries = extractEntries(request.body);

      if (!rawEntries) {
        return reply.code(400).send({
          error: 'Request body must be: {"events":[...]}, a JSON array [...], or a single event object.',
        });
      }

      if (rawEntries.length > MAX_BATCH_SIZE) {
        return reply.code(400).send({
          error: `Batch too large. Maximum ${MAX_BATCH_SIZE} events per request.`,
        });
      }

      const db = getDb();

      // ── Load pipeline config ────────────────────────────────────
      let pipelineCfg: Record<string, unknown> = {};
      try {
        const cfgRow = await db('app_config').where({ key: 'pipeline_config' }).first('value');
        pipelineCfg = cfgRow?.value
          ? (typeof cfgRow.value === 'string' ? JSON.parse(cfgRow.value) : cfgRow.value) ?? {}
          : {};
      } catch (err) {
        app.log.warn(`[${localTimestamp()}] Pipeline config read failed, using defaults: ${err}`);
      }

      // ── Multiline reassembly (e.g. PostgreSQL continuation lines) ──
      // Merges related multi-line log entries into a single event before
      // normalisation.  Controlled by pipeline_config.multiline_reassembly.
      let entries = rawEntries;
      const multilineEnabled = pipelineCfg.multiline_reassembly !== false; // default: enabled
      if (multilineEnabled) {
        const before = entries.length;
        entries = reassembleMultilineEntries(entries);
        if (entries.length < before) {
          app.log.debug(
            `[${localTimestamp()}] Multiline reassembly: ${before} → ${entries.length} entries (merged ${before - entries.length})`,
          );
        }
      }

      // ── Timestamp correction settings ──────────────────────────
      const maxFutureDriftSeconds = typeof pipelineCfg.max_future_drift_seconds === 'number'
        ? pipelineCfg.max_future_drift_seconds
        : 300; // default: 5 minutes

      const maxEventMsgLen = typeof pipelineCfg.max_event_message_length === 'number'
        ? pipelineCfg.max_event_message_length
        : 8192;

      // Pre-load per-system timezone settings (one lightweight query per batch)
      const tzOffsetMap = new Map<string, number>();
      const tzNameMap = new Map<string, string>();
      try {
        const systems = await db('monitored_systems')
          .where(function() {
            this.whereNotNull('tz_offset_minutes').orWhereNotNull('tz_name');
          })
          .select('id', 'tz_offset_minutes', 'tz_name');
        for (const sys of systems) {
          if (sys.tz_name && typeof sys.tz_name === 'string') {
            tzNameMap.set(sys.id, sys.tz_name);
          } else if (typeof sys.tz_offset_minutes === 'number' && sys.tz_offset_minutes !== 0) {
            tzOffsetMap.set(sys.id, sys.tz_offset_minutes);
          }
        }
      } catch {
        // Non-critical — proceed without timezone correction
      }

      // ── Discovery buffer for unmatched events ────────────────
      let discoveryEnabled = false;
      try {
        const discRow = await db('app_config').where({ key: 'discovery_config' }).first('value');
        if (discRow) {
          const discCfg = typeof discRow.value === 'string' ? JSON.parse(discRow.value) : discRow.value;
          discoveryEnabled = discCfg?.enabled !== false;
        } else {
          discoveryEnabled = true; // default: enabled
        }
      } catch { /* non-critical */ }
      const discoveryRows: Array<{
        host: string | null; source_ip: string | null; program: string | null;
        facility: string | null; severity: string | null;
        message_sample: string; received_at: string;
      }> = [];

      let accepted = 0;
      let rejected = 0;
      let futureClamped = 0;
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

        // 1. Flatten ECS nested fields (e.g. from OTel/Beats agents), then normalize
        flattenECS(entry as Record<string, unknown>);
        const normalized = normalizeEntry(entry as IngestEntry);
        if (!normalized) {
          rejected++;
          errors.push(`Entry ${i}: missing or empty "message" field.`);
          continue;
        }

        if (normalized.message.length > maxEventMsgLen) {
          normalized.message = normalized.message.slice(0, maxEventMsgLen) + ' [...truncated]';
        }

        // 1b. Source-IP resolution: ensure source_ip reflects the REAL origin.
        //
        //  Problem: Docker NATs UDP packets, so Fluent Bit's source_address_key
        //  produces the Docker bridge gateway IP (e.g. 172.17.0.1) instead of the
        //  actual device IP. The syslog header's `host` field survives NAT because
        //  it's inside the payload.
        //
        //  Strategy:
        //   a) If source_ip is missing entirely, fall back to request.ip.
        //   b) If source_ip is a Docker/container-internal IP but the syslog
        //      `host` field contains what looks like a real (non-internal) IP,
        //      prefer `host` — it came from the syslog header and is reliable.
        if (!normalized.source_ip && request.ip) {
          normalized.source_ip = cleanTransportAddress(request.ip) ?? request.ip;
        } else if (
          normalized.source_ip &&
          normalized.host &&
          normalized.source_ip !== normalized.host &&
          isDockerInternalIp(normalized.source_ip) &&
          isIpv4Address(normalized.host) &&
          !isDockerInternalIp(normalized.host)
        ) {
          // The syslog host header has a real device IP; source_ip is NATted.
          app.log.debug(
            `[${localTimestamp()}] Docker NAT detected: source_ip=${normalized.source_ip} → using syslog host=${normalized.host}`,
          );
          normalized.source_ip = normalized.host;
        }
        // Also back-fill host if it was left empty (normalizer falls back host→source_ip,
        // but that runs before this fallback).
        if (!normalized.host && normalized.source_ip) {
          normalized.host = normalized.source_ip;
        }

        // 2. Source match
        const match = await matchSource(db, normalized);
        if (!match) {
          rejected++;
          errors.push(`Entry ${i}: no matching log source found.`);

          // Buffer unmatched event for auto-discovery (non-blocking)
          if (discoveryEnabled) {
            discoveryRows.push({
              host: normalized.host || null,
              source_ip: normalized.source_ip || null,
              program: normalized.program || null,
              facility: normalized.facility || null,
              severity: normalized.severity || null,
              message_sample: (normalized.message || '').slice(0, 512),
              received_at: normalized.timestamp || new Date().toISOString(),
            });
          }

          continue;
        }

        // 2b. Apply per-system timezone correction (corrects RFC 3164 TZ mismatch)
        const tzName = tzNameMap.get(match.system_id);
        if (tzName) {
          normalized.timestamp = applyTimezoneByName(normalized.timestamp, tzName);
        } else {
          const tzOffset = tzOffsetMap.get(match.system_id);
          if (tzOffset) {
            normalized.timestamp = applyTimezoneOffset(normalized.timestamp, tzOffset);
          }
        }

        // 2c. Future-timestamp guard: clamp to now if too far ahead
        if (maxFutureDriftSeconds > 0) {
          const { timestamp: clampedTs, clamped } = clampFutureTimestamp(
            normalized.timestamp,
            maxFutureDriftSeconds,
          );
          if (clamped) {
            futureClamped++;
            app.log.warn(
              `[${localTimestamp()}] Future timestamp clamped: ${normalized.timestamp} → ${clampedTs} ` +
              `(system=${match.system_id}, host=${normalized.host ?? '?'})`,
            );
            normalized.timestamp = clampedTs;
          }
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
              await trx('events')
                .insert(rows.slice(i, i + CHUNK_SIZE))
                .onConflict(['normalized_hash', 'timestamp'])
                .ignore();
            }
          });
        } catch (err) {
          app.log.error(`[${localTimestamp()}] Ingest batch insert failed: ${err}`);
          return reply.code(500).send({ error: 'Failed to persist events.' });
        }
      }

      // Flush discovery buffer (non-blocking, fire-and-forget)
      if (discoveryRows.length > 0) {
        db('discovery_buffer')
          .insert(discoveryRows)
          .catch((err: any) => {
            app.log.debug(`[${localTimestamp()}] Discovery buffer insert failed: ${err.message}`);
          });
      }

      app.log.debug(
        { accepted, rejected, futureClamped, ip: request.ip },
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

// ── Docker NAT helpers ──────────────────────────────────────────

/**
 * Check if an IP belongs to Docker/container-internal ranges.
 *
 * Conservative: only 172.16.0.0/12 (Docker's default) and loopback.
 * Does NOT include 10.0.0.0/8 or 192.168.0.0/16 because those are
 * commonly used in real enterprise networks and should not be treated
 * as "Docker internal."
 */
function isDockerInternalIp(ip: string): boolean {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
         ip === '127.0.0.1' ||
         ip === '::1';
}

/** Check if a string looks like a dotted IPv4 address. */
function isIpv4Address(value: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}
