import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { localTimestamp } from '../../config/index.js';

/** Allowed sort columns — prevents SQL injection via sort_by param. */
const ALLOWED_SORT_COLUMNS = new Set([
  'timestamp',
  'severity',
  'host',
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
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
    async (request, reply) => {
      const {
        q,
        q_mode,
        system_id,
        severity,
        host,
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
          baseQuery.where('events.message', 'ILIKE', `%${trimmed}%`);
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
            'events.service',
            'events.program',
            'events.facility',
            'events.trace_id',
            'events.span_id',
            'events.external_id',
            'events.raw',
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
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
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

      const [severities, hosts, programs, systems] = await Promise.all([
        baseWhere('events.severity')
          .distinct('events.severity as value')
          .orderBy('value')
          .limit(FACET_LIMIT),
        baseWhere('events.host')
          .distinct('events.host as value')
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
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
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
        query.where('events.message', 'ILIKE', `%${trimmedValue}%`);
      } else {
        // 'all': search trace_id OR in message
        query.where(function () {
          this.where('events.trace_id', trimmedValue)
            .orWhere('events.span_id', trimmedValue)
            .orWhere('events.message', 'ILIKE', `%${trimmedValue}%`);
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
}
