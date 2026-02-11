import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { invalidateAiConfigCache } from '../llm/aiConfig.js';
import { writeAuditLog } from '../../middleware/audit.js';
import { getDefaultEventSource, getEventSource } from '../../services/eventSourceFactory.js';

/**
 * Event search, facet, and trace endpoints.
 *
 * When a system_id filter is present, the request is dispatched to the
 * correct EventSource (PG or ES) for that system.  Cross-system queries
 * (no system_id) use the default PgEventSource.
 */
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const defaultEventSource = getDefaultEventSource(db);

  /** Resolve the EventSource for a given system_id, or fall back to default. */
  async function resolveEventSource(systemId?: string) {
    if (!systemId) return defaultEventSource;
    const system = await db('monitored_systems').where({ id: systemId }).first();
    if (!system) return defaultEventSource;
    return getEventSource(system, db);
  }

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
      try {
        const eventSource = await resolveEventSource(request.query.system_id);
        const result = await eventSource.searchEvents({
          q: request.query.q,
          q_mode: request.query.q_mode as 'fulltext' | 'contains' | undefined,
          system_id: request.query.system_id,
          severity: request.query.severity,
          host: request.query.host,
          source_ip: request.query.source_ip,
          program: request.query.program,
          service: request.query.service,
          trace_id: request.query.trace_id,
          from: request.query.from,
          to: request.query.to,
          sort_by: request.query.sort_by,
          sort_dir: request.query.sort_dir as 'asc' | 'desc' | undefined,
          page: Number(request.query.page ?? 1),
          limit: Number(request.query.limit ?? 100),
        });
        return reply.send(result);
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Event search error: ${err.message}`);
        return reply.code(400).send({ error: 'Search failed. Check your query syntax.' });
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

      const eventSource = await resolveEventSource(system_id);
      const facets = await eventSource.getFacets(system_id, days);

      // Systems list is always from PG (not event-source dependent)
      const systems = await db('monitored_systems').select('id', 'name').orderBy('name');

      return reply.send({
        ...facets,
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
        ? Math.min(rawWindowHours, 168)
        : 24;
      const rawLimit = Number(request.query.limit ?? 500);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 1000) : 500;

      const anchorDate = anchor_time && !isNaN(Date.parse(anchor_time))
        ? new Date(anchor_time)
        : new Date();
      const windowMs = windowHours * 60 * 60 * 1000;
      const fromTs = new Date(anchorDate.getTime() - windowMs).toISOString();
      const toTs = new Date(anchorDate.getTime() + windowMs).toISOString();

      const searchField = (field || 'all') as 'trace_id' | 'message' | 'all';

      try {
        // Trace searches across the default PG source (cross-system)
        const traceResult = await defaultEventSource.traceEvents(trimmedValue, searchField, fromTs, toTs, limit);

        // Group by system for the frontend timeline
        const bySystem: Record<string, { system_id: string; system_name: string; events: any[] }> = {};
        for (const evt of traceResult.events) {
          if (!bySystem[evt.system_id]) {
            bySystem[evt.system_id] = {
              system_id: evt.system_id,
              system_name: evt.system_name ?? '',
              events: [],
            };
          }
          bySystem[evt.system_id].events.push(evt);
        }

        return reply.send({
          value: trimmedValue,
          field: searchField,
          window: { from: fromTs, to: toTs },
          total: traceResult.total,
          systems: Object.values(bySystem),
          events: traceResult.events,
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

      if (from && isNaN(Date.parse(from))) {
        return reply.code(400).send({ error: '"from" must be a valid ISO date string.' });
      }
      if (to && isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: '"to" must be a valid ISO date string.' });
      }

      const toTs = to ? new Date(to).toISOString() : new Date().toISOString();
      const fromTs = from ? new Date(from).toISOString() : null;

      try {
        const eventSource = await resolveEventSource(system_id);
        const totalAcked = await eventSource.acknowledgeEvents({
          system_id,
          from: fromTs,
          to: toTs,
        });

        if (totalAcked === 0) {
          return reply.send({ acknowledged: 0, message: 'No events to acknowledge in the given range.' });
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
        const eventSource = await resolveEventSource(system_id);
        const result = await eventSource.unacknowledgeEvents({
          system_id,
          from: fromTs,
          to: toTs,
        });

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
