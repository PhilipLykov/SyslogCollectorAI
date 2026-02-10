import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { invalidateAiConfigCache } from '../llm/aiConfig.js';
import { writeAuditLog } from '../../middleware/audit.js';

/** Escape LIKE/ILIKE wildcards in user input to prevent pattern injection. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/** Allowed sort columns — prevents SQL injection via sort_by param. */
const ALLOWED_SORT_COLUMNS = new Set([
  'timestamp',
  'severity',
  'host',
  'source_ip',
  'program',
  'service',
]);

/** Max rows per search page. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

/** Max rows for facets (distinct values). */
const FACET_LIMIT = 200;

/**
 * Event search, facet, and trace endpoints.
 */
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── Search events (global, cross-system) ──────────────────
  app.get<{
    Querystring: {
      q?: string;
      q_mode?: string;
      system_id?: string;
      severity?: string;
      host?: string;
      source_ip?: string;
      program?: string;
      service?: string;
      trace_id?: string;
      from?: string;
      to?: string;
      sort_by?: string;
      sort_dir?: string;
      page?: string;
      limit?: string;
    };
  }>(
    '/api/v1/events/search',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const {
        q,
        q_mode,
        system_id,
        severity,
        host,
        source_ip,
        program,
        service,
        trace_id,
        from,
        to,
        sort_by,
        sort_dir,
      } = request.query;

      const rawPage = Number(request.query.page ?? 1);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
      const rawLimit = Number(request.query.limit ?? DEFAULT_LIMIT);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
      const offset = (page - 1) * limit;

      // Validate sort
      const sortColumn = ALLOWED_SORT_COLUMNS.has(sort_by ?? '') ? sort_by! : 'timestamp';
      const sortDirection = sort_dir === 'asc' ? 'asc' : 'desc';

      // Build base query
      const baseQuery = db('events')
        .join('monitored_systems', 'events.system_id', 'monitored_systems.id');

      // Apply filters
      if (system_id) {
        baseQuery.where('events.system_id', system_id);
      }
      if (severity) {
        const severities = severity
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
        if (severities.length > 0) {
          baseQuery.whereRaw(
            `LOWER(events.severity) IN (${severities.map(() => '?').join(', ')})`,
            severities,
          );
        }
      }
      if (host) {
        baseQuery.where('events.host', host);
      }
      if (source_ip) {
        baseQuery.where('events.source_ip', source_ip);
      }
      if (program) {
        baseQuery.where('events.program', program);
      }
      if (service) {
        baseQuery.where('events.service', service);
      }
      if (trace_id) {
        baseQuery.where('events.trace_id', trace_id);
      }
      if (from) {
        if (!isNaN(Date.parse(from))) {
          baseQuery.where('events.timestamp', '>=', from);
        }
      }
      if (to) {
        if (!isNaN(Date.parse(to))) {
          baseQuery.where('events.timestamp', '<=', to);
        }
      }

      // Full-text search or ILIKE substring
      if (q && q.trim().length > 0) {
        const trimmed = q.trim();
        if (q_mode === 'contains') {
          // ILIKE substring search (slower, but exact match)
          baseQuery.where('events.message', 'ILIKE', `%${escapeLike(trimmed)}%`);
        } else {
          // PostgreSQL full-text search using websearch_to_tsquery
          // websearch_to_tsquery supports natural language: "error OR warning", "connection refused", etc.
          baseQuery.whereRaw(
            `to_tsvector('english', events.message) @@ websearch_to_tsquery('english', ?)`,
            [trimmed],
          );
        }
      }

      try {
        // Count total (clone before applying sort/limit/offset)
        const countResult = await baseQuery
          .clone()
          .clearSelect()
          .clearOrder()
          .count('events.id as total')
          .first();
        const total = Number(countResult?.total ?? 0);

        // Fetch page
        const events = await baseQuery
          .clone()
          .select(
            'events.id',
            'events.system_id',
            'monitored_systems.name as system_name',
            'events.log_source_id',
            'events.timestamp',
            'events.received_at',
            'events.message',
            'events.severity',
            'events.host',
            'events.source_ip',
            'events.service',
            'events.program',
            'events.facility',
            'events.trace_id',
            'events.span_id',
            'events.external_id',
            'events.raw',
            'events.acknowledged_at',
          )
          .orderBy(`events.${sortColumn}`, sortDirection)
          // Secondary sort for deterministic ordering when primary sort has ties
          .orderBy('events.id', 'asc')
          .limit(limit)
          .offset(offset);

        // Parse raw JSON safely
        const result = events.map((e: any) => {
          let raw = e.raw;
          if (raw && typeof raw === 'string') {
            try {
              raw = JSON.parse(raw);
            } catch {
              /* keep as string */
            }
          }
          return { ...e, raw };
        });

        return reply.send({
          events: result,
          total,
          page,
          limit,
          has_more: offset + limit < total,
        });
      } catch (err: any) {
        // websearch_to_tsquery can throw on severely malformed input
        app.log.error(`[${localTimestamp()}] Event search error: ${err.message}`);
        return reply.code(400).send({
          error: 'Search failed. Check your query syntax.',
        });
      }
    },
  );

  // ── Facets: distinct values for filter dropdowns ───────────
  app.get<{
    Querystring: { system_id?: string; days?: string };
  }>(
    '/api/v1/events/facets',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { system_id } = request.query;
      const rawDays = Number(request.query.days ?? 7);
      const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // Build base condition
      const baseWhere = (col: string) => {
        const q = db('events')
          .where('events.timestamp', '>=', since)
          .whereNotNull(col)
          .where(col, '!=', '');
        if (system_id) q.where('events.system_id', system_id);
        return q;
      };

      const [severities, hosts, sourceIps, programs, systems] = await Promise.all([
        baseWhere('events.severity')
          .distinct('events.severity as value')
          .orderBy('value')
          .limit(FACET_LIMIT),
        baseWhere('events.host')
          .distinct('events.host as value')
          .orderBy('value')
          .limit(FACET_LIMIT),
        baseWhere('events.source_ip')
          .distinct('events.source_ip as value')
          .orderBy('value')
          .limit(FACET_LIMIT),
        baseWhere('events.program')
          .distinct('events.program as value')
          .orderBy('value')
          .limit(FACET_LIMIT),
        db('monitored_systems')
          .select('id', 'name')
          .orderBy('name'),
      ]);

      return reply.send({
        severities: severities.map((r: any) => r.value),
        hosts: hosts.map((r: any) => r.value),
        source_ips: sourceIps.map((r: any) => r.value),
        programs: programs.map((r: any) => r.value),
        systems: systems.map((r: any) => ({ id: r.id, name: r.name })),
      });
    },
  );

  // ── Trace: find correlated events across systems ──────────
  app.get<{
    Querystring: {
      value: string;
      field?: string;
      anchor_time?: string;
      window_hours?: string;
      limit?: string;
    };
  }>(
    '/api/v1/events/trace',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { value, field, anchor_time } = request.query;

      if (!value || value.trim().length === 0) {
        return reply.code(400).send({ error: '"value" query parameter is required.' });
      }

      const trimmedValue = value.trim();
      const rawWindowHours = Number(request.query.window_hours ?? 24);
      const windowHours = Number.isFinite(rawWindowHours) && rawWindowHours > 0
        ? Math.min(rawWindowHours, 168)  // max 7 days
        : 24;
      const rawLimit = Number(request.query.limit ?? 500);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 1000) : 500;

      // Calculate time window around anchor
      const anchorDate = anchor_time && !isNaN(Date.parse(anchor_time))
        ? new Date(anchor_time)
        : new Date();
      const windowMs = windowHours * 60 * 60 * 1000;
      const fromTs = new Date(anchorDate.getTime() - windowMs).toISOString();
      const toTs = new Date(anchorDate.getTime() + windowMs).toISOString();

      const query = db('events')
        .join('monitored_systems', 'events.system_id', 'monitored_systems.id')
        .where('events.timestamp', '>=', fromTs)
        .where('events.timestamp', '<=', toTs);

      const searchField = field || 'all';

      if (searchField === 'trace_id') {
        query.where('events.trace_id', trimmedValue);
      } else if (searchField === 'message') {
        // Use ILIKE for message tracing (exact substring match is more useful for correlation IDs)
        query.where('events.message', 'ILIKE', `%${escapeLike(trimmedValue)}%`);
      } else {
        // 'all': search trace_id OR in message
        query.where(function () {
          this.where('events.trace_id', trimmedValue)
            .orWhere('events.span_id', trimmedValue)
            .orWhere('events.message', 'ILIKE', `%${escapeLike(trimmedValue)}%`);
        });
      }

      try {
        const events = await query
          .select(
            'events.id',
            'events.system_id',
            'monitored_systems.name as system_name',
            'events.timestamp',
            'events.message',
            'events.severity',
            'events.host',
            'events.source_ip',
            'events.program',
            'events.service',
            'events.trace_id',
            'events.span_id',
            'events.external_id',
            'events.raw',
          )
          .orderBy('events.timestamp', 'asc')
          .limit(limit);

        // Parse raw JSON safely
        const result = events.map((e: any) => {
          let raw = e.raw;
          if (raw && typeof raw === 'string') {
            try {
              raw = JSON.parse(raw);
            } catch {
              /* keep as string */
            }
          }
          return { ...e, raw };
        });

        // Group by system for the frontend timeline
        const bySystem: Record<string, { system_id: string; system_name: string; events: any[] }> = {};
        for (const evt of result) {
          if (!bySystem[evt.system_id]) {
            bySystem[evt.system_id] = {
              system_id: evt.system_id,
              system_name: evt.system_name,
              events: [],
            };
          }
          bySystem[evt.system_id].events.push(evt);
        }

        return reply.send({
          value: trimmedValue,
          field: searchField,
          window: { from: fromTs, to: toTs },
          total: result.length,
          systems: Object.values(bySystem),
          events: result,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Event trace error: ${err.message}`);
        return reply.code(500).send({ error: 'Trace query failed.' });
      }
    },
  );

  // ── Acknowledge events (bulk) ─────────────────────────────

  /**
   * POST /api/v1/events/acknowledge
   *
   * Bulk-acknowledge events in a time range (optionally filtered by system).
   * Acknowledged events are skipped by the LLM scoring job.
   */
  app.post(
    '/api/v1/events/acknowledge',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { system_id, from, to } = body;

      // Validate dates before parsing
      if (from && isNaN(Date.parse(from))) {
        return reply.code(400).send({ error: '"from" must be a valid ISO date string.' });
      }
      if (to && isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: '"to" must be a valid ISO date string.' });
      }

      const toTs = to ? new Date(to).toISOString() : new Date().toISOString();
      const fromTs = from ? new Date(from).toISOString() : null;

      try {
        let query = db('events')
          .whereNull('acknowledged_at')
          .where('timestamp', '<=', toTs);

        if (fromTs) {
          query = query.where('timestamp', '>=', fromTs);
        }

        if (system_id) {
          query = query.where('system_id', system_id);
        }

        // Count first
        const countResult = await query.clone().count('id as cnt').first();
        const count = Number(countResult?.cnt ?? 0);

        if (count === 0) {
          return reply.send({ acknowledged: 0, message: 'No events to acknowledge in the given range.' });
        }

        // Batch update to avoid locking the entire table for too long
        const BATCH_SIZE = 5000;
        let totalAcked = 0;
        const ackTs = new Date().toISOString();

        while (totalAcked < count) {
          // Get a batch of IDs to update
          let batchQuery = db('events')
            .whereNull('acknowledged_at')
            .where('timestamp', '<=', toTs);
          if (fromTs) batchQuery = batchQuery.where('timestamp', '>=', fromTs);
          if (system_id) batchQuery = batchQuery.where('system_id', system_id);

          const ids = await batchQuery.select('id').limit(BATCH_SIZE);
          if (ids.length === 0) break;

          await db('events')
            .whereIn('id', ids.map((r: any) => r.id))
            .update({ acknowledged_at: ackTs });

          totalAcked += ids.length;
        }

        app.log.info(
          `[${localTimestamp()}] Bulk event acknowledgement: ${totalAcked} events` +
          `${system_id ? ` (system=${system_id})` : ''}, range=${fromTs ?? 'beginning'}..${toTs}`,
        );

        await writeAuditLog(db, {
          action: 'event_acknowledge',
          resource_type: 'events',
          details: { system_id, from: fromTs, to: toTs, count: totalAcked },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          acknowledged: totalAcked,
          message: `${totalAcked} event${totalAcked !== 1 ? 's' : ''} acknowledged.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Event acknowledge error: ${err.message}`);
        return reply.code(500).send({ error: 'Event acknowledgement failed.' });
      }
    },
  );

  /**
   * POST /api/v1/events/unacknowledge
   *
   * Bulk-unacknowledge events (undo), same filters as acknowledge.
   */
  app.post(
    '/api/v1/events/unacknowledge',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { system_id, from, to } = body;

      if (from && isNaN(Date.parse(from))) {
        return reply.code(400).send({ error: '"from" must be a valid ISO date string.' });
      }
      if (to && isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: '"to" must be a valid ISO date string.' });
      }

      const toTs = to ? new Date(to).toISOString() : new Date().toISOString();
      const fromTs = from ? new Date(from).toISOString() : null;

      try {
        let query = db('events')
          .whereNotNull('acknowledged_at')
          .where('timestamp', '<=', toTs);
        if (fromTs) query = query.where('timestamp', '>=', fromTs);
        if (system_id) query = query.where('system_id', system_id);

        const result = await query.update({ acknowledged_at: null });

        app.log.info(`[${localTimestamp()}] Bulk event un-acknowledge: ${result} events`);

        await writeAuditLog(db, {
          action: 'event_unacknowledge',
          resource_type: 'events',
          details: { count: result },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          unacknowledged: result,
          message: `${result} event${result !== 1 ? 's' : ''} un-acknowledged.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Event un-acknowledge error: ${err.message}`);
        return reply.code(500).send({ error: 'Event un-acknowledgement failed.' });
      }
    },
  );

  // ── Acknowledge config (mode + prompt) ─────────────────────

  /** Default ack prompt for context_only mode. */
  const DEFAULT_ACK_PROMPT =
    'Previously acknowledged by user — use only for pattern recognition context. ' +
    'Do not score, do not raise new findings for these events.';

  app.get(
    '/api/v1/events/ack-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      const rows = await db('app_config')
        .whereIn('key', ['event_ack_mode', 'event_ack_prompt'])
        .select('key', 'value');

      const vals: Record<string, string> = {};
      for (const row of rows) {
        let v = row.value;
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { /* use as-is */ }
        }
        if (typeof v === 'string') vals[row.key] = v;
      }

      return reply.send({
        mode: vals['event_ack_mode'] || 'context_only',
        prompt: vals['event_ack_prompt'] || DEFAULT_ACK_PROMPT,
        default_prompt: DEFAULT_ACK_PROMPT,
      });
    },
  );

  app.put(
    '/api/v1/events/ack-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { mode, prompt } = body;

      if (mode !== undefined) {
        if (!['skip', 'context_only'].includes(mode)) {
          return reply.code(400).send({ error: 'mode must be "skip" or "context_only".' });
        }
        await db.raw(`
          INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, ['event_ack_mode', JSON.stringify(mode)]);
      }

      if (prompt !== undefined) {
        if (typeof prompt !== 'string') {
          return reply.code(400).send({ error: 'prompt must be a string.' });
        }
        if (prompt.length > 2000) {
          return reply.code(400).send({ error: 'prompt must be 2000 characters or fewer.' });
        }
        if (!prompt.trim()) {
          // Reset to default
          await db('app_config').where({ key: 'event_ack_prompt' }).del();
        } else {
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, ['event_ack_prompt', JSON.stringify(prompt)]);
        }
      }

      invalidateAiConfigCache();

      await writeAuditLog(db, {
        action: 'config_update',
        resource_type: 'ack_config',
        details: { mode, prompt },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      // Return current state
      const rows = await db('app_config')
        .whereIn('key', ['event_ack_mode', 'event_ack_prompt'])
        .select('key', 'value');
      const vals: Record<string, string> = {};
      for (const row of rows) {
        let v = row.value;
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { /* use as-is */ }
        }
        if (typeof v === 'string') vals[row.key] = v;
      }

      return reply.send({
        mode: vals['event_ack_mode'] || 'context_only',
        prompt: vals['event_ack_prompt'] || DEFAULT_ACK_PROMPT,
        default_prompt: DEFAULT_ACK_PROMPT,
      });
    },
  );
}
