import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { CRITERIA } from '../../types/index.js';
import { estimateCost, MODEL_PRICING } from '../llm/pricing.js';
import { resolveAiConfig } from '../llm/aiConfig.js';
import { getEventSource } from '../../services/eventSourceFactory.js';

/**
 * Scores API — exposes effective scores, event scores, and meta results.
 * Auth: read, dashboard, or admin scope. Parameterized queries (A03).
 */
export async function registerScoresRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── Effective scores per system (rolling max across recent windows) ──
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/v1/scores/systems',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      const { from, to } = request.query;

      // Default to last 24 hours if no time range specified
      const since = from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const until = to ?? new Date().toISOString();

      const systems = await db('monitored_systems').select('*');
      const results = [];

      for (const system of systems) {
        // Latest window for metadata — use the same time bounds as the scores query
        const latestWindow = await db('windows')
          .where({ system_id: system.id })
          .where('to_ts', '>=', since)
          .where('to_ts', '<=', until)
          .orderBy('to_ts', 'desc')
          .first();

        if (!latestWindow) continue;

        // Rolling max across all windows in the time range
        const scores = await db('effective_scores')
          .join('windows', 'effective_scores.window_id', 'windows.id')
          .where('effective_scores.system_id', system.id)
          .where('windows.to_ts', '>=', since)
          .where('windows.to_ts', '<=', until)
          .groupBy('effective_scores.criterion_id')
          .select(
            'effective_scores.criterion_id',
            db.raw('MAX(effective_scores.effective_value) as effective_value'),
            db.raw('MAX(effective_scores.meta_score) as meta_score'),
            db.raw('MAX(effective_scores.max_event_score) as max_event_score'),
          );

        const scoreMap: Record<string, { effective: number; meta: number; max_event: number }> = {};
        for (const s of scores) {
          const criterion = CRITERIA.find((c) => c.id === s.criterion_id);
          if (criterion) {
            scoreMap[criterion.slug] = {
              effective: Number(s.effective_value) || 0,
              meta: Number(s.meta_score) || 0,
              max_event: Number(s.max_event_score) || 0,
            };
          }
        }

        results.push({
          system_id: system.id,
          system_name: system.name ?? 'Unknown',
          window_id: latestWindow.id,
          window_from: latestWindow.from_ts,
          window_to: latestWindow.to_ts,
          scores: scoreMap,
          updated_at: latestWindow.created_at,
        });
      }

      return reply.send(results);
    },
  );

  // ── Event scores for a specific event ──────────────────────
  app.get<{ Params: { eventId: string } }>(
    '/api/v1/events/:eventId/scores',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const scores = await db('event_scores')
        .where({ event_id: request.params.eventId })
        .join('criteria', 'event_scores.criterion_id', 'criteria.id')
        .select(
          'criteria.slug',
          'criteria.name',
          'event_scores.score',
          'event_scores.score_type',
          'event_scores.severity_label',
          'event_scores.reason_codes',
        );

      if (scores.length === 0) {
        return reply.code(404).send({ error: 'No scores found for this event' });
      }

      return reply.send(scores);
    },
  );

  // ── Events with scores for a system, optionally filtered by criterion ──
  //    Returns events sorted by score (highest first) for a given system.
  //    Used by the criterion drill-down UI.
  app.get<{
    Params: { systemId: string };
    Querystring: { criterion_id?: string; limit?: string; min_score?: string };
  }>(
    '/api/v1/systems/:systemId/event-scores',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { systemId } = request.params;
      const criterionId = request.query.criterion_id;
      const rawLimit = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
      const minScore = Number(request.query.min_score ?? 0);

      // Check if this is an ES-backed or PG-backed system
      const system = await db('monitored_systems').where({ id: systemId }).first();
      const isEsBacked = system?.event_source === 'elasticsearch';

      let rows: any[];

      if (isEsBacked) {
        // For ES-backed systems, event_scores.event_id contains ES _id strings
        // which don't exist in the PG events table.  Join with es_event_metadata
        // to filter by system_id (event_scores has no system_id column).
        let scoreQuery = db('event_scores')
          .join('es_event_metadata', function () {
            this.on('event_scores.event_id', '=', 'es_event_metadata.es_event_id')
              .andOn('es_event_metadata.system_id', '=', db.raw('?', [systemId]));
          })
          .join('criteria', 'event_scores.criterion_id', 'criteria.id')
          .where('event_scores.score_type', 'event')
          .whereNull('es_event_metadata.acknowledged_at')
          .orderBy('event_scores.score', 'desc')
          .limit(limit)
          .select(
            'event_scores.event_id',
            'criteria.slug as criterion_slug',
            'criteria.name as criterion_name',
            'event_scores.score',
            'event_scores.severity_label',
            'event_scores.reason_codes',
          );

        if (criterionId) {
          scoreQuery = scoreQuery.where('event_scores.criterion_id', Number(criterionId));
        }
        if (minScore > 0) {
          scoreQuery = scoreQuery.where('event_scores.score', '>=', minScore);
        }

        const scoreRows = await scoreQuery;

        // Hydrate event fields from ES (best-effort; if ES is down, return scores without event data)
        try {
          const eventSource = getEventSource(system, db);
          const eventIds = [...new Set(scoreRows.map((r: any) => r.event_id))];
          if (eventIds.length > 0) {
            // Fetch specific events by ID from ES
            const esEvents = await eventSource.getSystemEvents(systemId, {
              limit: eventIds.length,
              event_ids: eventIds,
            });
            const eventMap = new Map(esEvents.map((e: any) => [e.id, e]));

            rows = scoreRows.map((r: any) => {
              const evt = eventMap.get(r.event_id);
              return {
                ...r,
                timestamp: evt?.timestamp ?? null,
                message: evt?.message ?? null,
                severity: evt?.severity ?? null,
                host: evt?.host ?? null,
                source_ip: evt?.source_ip ?? null,
                program: evt?.program ?? null,
              };
            });
          } else {
            rows = scoreRows;
          }
        } catch {
          // ES unavailable — return scores without event details
          rows = scoreRows;
        }
      } else {
        // PG-backed system: use the efficient JOIN
        let query = db('event_scores')
          .joinRaw('JOIN events ON event_scores.event_id = events.id::text')
          .join('criteria', 'event_scores.criterion_id', 'criteria.id')
          .where('events.system_id', systemId)
          .where('event_scores.score_type', 'event')
          .orderBy('event_scores.score', 'desc')
          .limit(limit)
          .select(
            'events.id as event_id',
            'events.timestamp',
            'events.message',
            'events.severity',
            'events.host',
            'events.source_ip',
            'events.program',
            'criteria.slug as criterion_slug',
            'criteria.name as criterion_name',
            'event_scores.score',
            'event_scores.severity_label',
            'event_scores.reason_codes',
          );

        if (criterionId) {
          query = query.where('event_scores.criterion_id', Number(criterionId));
        }
        // Filter out low-score events (only return events that actually
        // contributed to the criterion score)
        if (minScore > 0) {
          query = query.where('event_scores.score', '>=', minScore);
        }

        rows = await query;
      }

      // Parse reason_codes JSON safely
      const results = rows.map((r: any) => {
        let reasons = r.reason_codes;
        if (typeof reasons === 'string') {
          try { reasons = JSON.parse(reasons); } catch { /* keep as string */ }
        }
        return { ...r, reason_codes: reasons };
      });

      return reply.send(results);
    },
  );

  // ── Grouped event scores (by template) for a system ──────────
  //    Returns unique event patterns with occurrence counts, time ranges,
  //    and affected hosts.  Used by the criterion drill-down to avoid
  //    showing a wall of duplicate events.
  app.get<{
    Params: { systemId: string };
    Querystring: { criterion_id?: string; limit?: string; min_score?: string; show_acknowledged?: string };
  }>(
    '/api/v1/systems/:systemId/event-scores/grouped',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { systemId } = request.params;
      const criterionId = request.query.criterion_id;
      const rawLimit = Number(request.query.limit ?? 30);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 30;
      const minScore = Number(request.query.min_score ?? 0);
      const showAcknowledged = request.query.show_acknowledged === 'true';

      const system = await db('monitored_systems').where({ id: systemId }).first();
      if (!system) return reply.code(404).send({ error: 'System not found' });

      const isEsBacked = system.event_source === 'elasticsearch';

      if (isEsBacked) {
        // For ES-backed systems, fall back to the ungrouped endpoint behaviour
        // (grouping requires template_id which is a PG-only column).
        return reply.redirect(
          `/api/v1/systems/${systemId}/event-scores?` +
          `criterion_id=${criterionId ?? ''}&limit=${limit}&min_score=${minScore}`,
        );
      }

      // PG-backed system: group by template_id (or by event_id for singleton events).
      // Score, severity_label, reason_codes are NOT in GROUP BY — they use aggregates
      // so that all events of the same template are combined into one group regardless
      // of minor score variations across scoring runs.

      // Load dashboard config for time window (enables partition pruning on events table)
      let scoreWindowDays = 7;
      try {
        const dashCfg = await db('app_config').where({ key: 'dashboard_config' }).first('value');
        if (dashCfg?.value) {
          const parsed = typeof dashCfg.value === 'string' ? JSON.parse(dashCfg.value) : dashCfg.value;
          const d = Number(parsed.score_display_window_days);
          if (d > 0 && d <= 90) scoreWindowDays = d;
        }
      } catch { /* use default */ }
      const scoreSince = new Date(Date.now() - scoreWindowDays * 86_400_000).toISOString();

      const groupQuery = db('event_scores')
        .joinRaw('JOIN events ON event_scores.event_id = events.id::text')
        .join('criteria', 'event_scores.criterion_id', 'criteria.id')
        .where('events.system_id', systemId)
        .where('events.timestamp', '>=', scoreSince)
        .where('event_scores.score_type', 'event');

      // By default hide acknowledged events; show them only when toggled on
      if (!showAcknowledged) {
        groupQuery.whereNull('events.acknowledged_at');
      }

      groupQuery
        .groupByRaw(`
          COALESCE(events.template_id::text, events.id::text),
          events.message,
          events.severity,
          events.program,
          criteria.slug,
          criteria.name
        `)
        .orderByRaw('MAX(event_scores.score) DESC')
        .limit(limit)
        .select(
          db.raw(`COALESCE(events.template_id::text, events.id::text) as group_key`),
          'events.message',
          'events.severity',
          'events.program',
          'criteria.slug as criterion_slug',
          'criteria.name as criterion_name',
          db.raw('MAX(event_scores.score) as score'),
          db.raw(`(ARRAY_AGG(event_scores.severity_label ORDER BY event_scores.score DESC))[1] as severity_label`),
          db.raw(`(ARRAY_AGG(event_scores.reason_codes ORDER BY event_scores.score DESC))[1] as reason_codes`),
          db.raw('COUNT(*)::int as occurrence_count'),
          db.raw('MIN(events.timestamp) as first_seen'),
          db.raw('MAX(events.timestamp) as last_seen'),
          db.raw(`ARRAY_AGG(DISTINCT events.host) FILTER (WHERE events.host IS NOT NULL) as hosts`),
          db.raw(`ARRAY_AGG(DISTINCT events.source_ip) FILTER (WHERE events.source_ip IS NOT NULL) as source_ips`),
        );

      if (criterionId) {
        groupQuery.where('event_scores.criterion_id', Number(criterionId));
      }
      if (minScore > 0) {
        groupQuery.havingRaw('MAX(event_scores.score) >= ?', [minScore]);
      }

      // When showing acknowledged events, add a flag to each group
      if (showAcknowledged) {
        groupQuery.select(
          db.raw('BOOL_OR(events.acknowledged_at IS NOT NULL) as acknowledged'),
        );
      }

      const rows = await groupQuery;

      // Parse reason_codes JSON safely
      const results = rows.map((r: any) => {
        let reasons = r.reason_codes;
        if (typeof reasons === 'string') {
          try { reasons = JSON.parse(reasons); } catch { /* keep as string */ }
        }
        return {
          group_key: r.group_key,
          message: r.message,
          severity: r.severity,
          program: r.program,
          criterion_slug: r.criterion_slug,
          criterion_name: r.criterion_name,
          score: r.score,
          severity_label: r.severity_label,
          reason_codes: reasons,
          occurrence_count: Number(r.occurrence_count) || 1,
          first_seen: r.first_seen,
          last_seen: r.last_seen,
          hosts: Array.isArray(r.hosts) ? r.hosts.filter(Boolean) : [],
          source_ips: Array.isArray(r.source_ips) ? r.source_ips.filter(Boolean) : [],
          ...(showAcknowledged ? { acknowledged: !!r.acknowledged } : {}),
        };
      });

      return reply.send(results);
    },
  );

  // ── Individual events for a group (expand a grouped row) ─────
  //    Returns all individual events within a template group for a criterion.
  app.get<{
    Params: { systemId: string; groupKey: string };
    Querystring: { criterion_id?: string; limit?: string };
  }>(
    '/api/v1/systems/:systemId/event-scores/grouped/:groupKey/events',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { systemId, groupKey } = request.params;
      const criterionId = request.query.criterion_id;
      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 100;

      // groupKey is either a template_id (UUID) or an event id (for singletons)
      let query = db('event_scores')
        .joinRaw('JOIN events ON event_scores.event_id = events.id::text')
        .join('criteria', 'event_scores.criterion_id', 'criteria.id')
        .where('events.system_id', systemId)
        .where('event_scores.score_type', 'event')
        .where(function () {
          this.whereRaw('events.template_id::text = ?', [groupKey])
            .orWhereRaw('events.id::text = ?', [groupKey]);
        })
        .orderBy('events.timestamp', 'desc')
        .limit(limit)
        .select(
          'events.id as event_id',
          'events.timestamp',
          'events.message',
          'events.severity',
          'events.host',
          'events.source_ip',
          'events.program',
          'criteria.slug as criterion_slug',
          'criteria.name as criterion_name',
          'event_scores.score',
          'event_scores.severity_label',
          'event_scores.reason_codes',
        );

      if (criterionId) {
        query = query.where('event_scores.criterion_id', Number(criterionId));
      }

      const rows = await query;

      const results = rows.map((r: any) => {
        let reasons = r.reason_codes;
        if (typeof reasons === 'string') {
          try { reasons = JSON.parse(reasons); } catch { /* keep as string */ }
        }
        return { ...r, reason_codes: reasons };
      });

      return reply.send(results);
    },
  );

  // ── Meta result for a window ───────────────────────────────
  app.get<{ Params: { windowId: string } }>(
    '/api/v1/windows/:windowId/meta',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      const meta = await db('meta_results')
        .where({ window_id: request.params.windowId })
        .first();

      if (!meta) {
        return reply.code(404).send({ error: 'No meta result for this window' });
      }

      // Parse JSON fields safely (corrupted data shouldn't crash the endpoint)
      const safeJsonParse = (val: unknown) => {
        if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
        return val;
      };
      return reply.send({
        ...meta,
        meta_scores: safeJsonParse(meta.meta_scores),
        findings: safeJsonParse(meta.findings),
        key_event_ids: meta.key_event_ids ? safeJsonParse(meta.key_event_ids) : null,
      });
    },
  );

  // ── Windows for a system ───────────────────────────────────
  app.get<{ Querystring: { system_id?: string; from?: string; to?: string; limit?: string } }>(
    '/api/v1/windows',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      let query = db('windows').orderBy('to_ts', 'desc');

      if (request.query.system_id) query = query.where({ system_id: request.query.system_id });
      if (request.query.from) query = query.where('from_ts', '>=', request.query.from);
      if (request.query.to) query = query.where('to_ts', '<=', request.query.to);

      const rawLimit = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
      query = query.limit(limit);

      const windows = await query.select('*');
      return reply.send(windows);
    },
  );

  // ── LLM usage stats ───────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; system_id?: string; limit?: string } }>(
    '/api/v1/llm-usage',
    { preHandler: requireAuth(PERMISSIONS.AI_USAGE_VIEW) },
    async (request, reply) => {
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 1000) : 200;

      let query = db('llm_usage').orderBy('created_at', 'desc').limit(limit);

      if (request.query.from) query = query.where('created_at', '>=', request.query.from);
      if (request.query.to) query = query.where('created_at', '<=', request.query.to);
      if (request.query.system_id) query = query.where({ system_id: request.query.system_id });

      const usage = await query.select('*');

      // Current model from DB/env (used only as fallback for legacy records
      // that were inserted before migration 008 added the model column).
      const aiCfg = await resolveAiConfig(db);
      const currentModel = aiCfg.model;

      // Resolve system names for display
      const systemIds = [...new Set(usage.map((r: any) => r.system_id).filter(Boolean))];
      const systemNames: Record<string, string> = {};
      if (systemIds.length > 0) {
        const systems = await db('monitored_systems').whereIn('id', systemIds).select('id', 'name');
        for (const s of systems) {
          systemNames[s.id] = s.name;
        }
      }

      // Enrich each record:
      // - model: use stored model, fall back to current env for legacy records
      // - cost_estimate: use stored cost (locked at insert time), fall back
      //   to computing from the record's model for legacy records
      const enrichedRecords = usage.map((r: any) => {
        const recordModel = r.model || currentModel;
        // PostgreSQL integer/bigint/decimal can arrive as strings — normalize
        const tokenInput = Number(r.token_input) || 0;
        const tokenOutput = Number(r.token_output) || 0;
        const storedCost = r.cost_estimate != null ? Number(r.cost_estimate) : null;
        const finalCost = (storedCost !== null && Number.isFinite(storedCost))
          ? storedCost
          : estimateCost(tokenInput, tokenOutput, recordModel);
        return {
          ...r,
          token_input: tokenInput,
          token_output: tokenOutput,
          model: recordModel,
          system_name: r.system_id ? (systemNames[r.system_id] ?? 'Unknown') : null,
          cost_estimate: finalCost,
        };
      });

      // Totals — apply same filters, computed over the FULL dataset (not
      // limited by pagination) so summary cards are always accurate.
      let totalsQuery = db('llm_usage');
      if (request.query.from) totalsQuery = totalsQuery.where('created_at', '>=', request.query.from);
      if (request.query.to) totalsQuery = totalsQuery.where('created_at', '<=', request.query.to);
      if (request.query.system_id) totalsQuery = totalsQuery.where({ system_id: request.query.system_id });

      const rawTotals = await totalsQuery
        .sum('token_input as total_input')
        .sum('token_output as total_output')
        .sum('request_count as total_requests')
        .sum('cost_estimate as total_stored_cost')
        .first();

      // PostgreSQL SUM returns bigint/numeric → pg driver serializes as string.
      // Normalize to numbers for a consistent JSON response contract.
      const totalInput = Number(rawTotals?.total_input ?? 0);
      const totalOutput = Number(rawTotals?.total_output ?? 0);
      const totalRequests = Number(rawTotals?.total_requests ?? 0);
      const totalStoredCost = rawTotals?.total_stored_cost != null
        ? Number(rawTotals.total_stored_cost)
        : null;

      return reply.send({
        records: enrichedRecords,
        totals: {
          total_input: totalInput,
          total_output: totalOutput,
          total_requests: totalRequests,
          // Use DB-level SUM of cost_estimate when available (accurate for
          // post-migration records with per-record model tracking).
          // For legacy records where cost_estimate was NULL, the SUM excludes
          // them — which is more honest than guessing with a single model.
          total_cost: totalStoredCost,
        },
        current_model: currentModel,
        pricing: MODEL_PRICING[currentModel] ?? null,
      });
    },
  );
}
