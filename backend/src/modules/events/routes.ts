import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { invalidateAiConfigCache } from '../llm/aiConfig.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { getDefaultEventSource, getEventSource } from '../../services/eventSourceFactory.js';
import { recalcEffectiveScores } from './recalcScores.js';

/**
 * Transition open findings to 'acknowledged' status when their text
 * significantly overlaps with acknowledged event messages.
 */
async function transitionFindingsOnAck(
  db: ReturnType<typeof getDb>,
  systemId: string | null,
  ackedMessages: string[],
): Promise<number> {
  if (ackedMessages.length === 0) return 0;

  // Find open findings for the system
  const findingsQuery = db('findings').where('status', 'open');
  if (systemId) findingsQuery.where('system_id', systemId);
  const openFindings = await findingsQuery.select('id', 'text');

  let transitioned = 0;
  for (const finding of openFindings) {
    const findingText = (finding.text || '').toLowerCase();
    // Check if any acknowledged message text significantly matches
    const match = ackedMessages.some((msg) => {
      const m = msg.toLowerCase();
      // Simple keyword overlap: if ≥50% of significant words (4+ chars) overlap, transition
      const msgWords = m.split(/\s+/).filter((w: string) => w.length >= 4);
      if (msgWords.length === 0) return false;
      let overlap = 0;
      for (const w of msgWords) {
        if (findingText.includes(w)) overlap++;
      }
      return msgWords.length > 0 && overlap / msgWords.length >= 0.5;
    });

    if (match) {
      await db('findings').where('id', finding.id).update({
        status: 'acknowledged',
        updated_at: new Date().toISOString(),
      });
      transitioned++;
    }
  }
  return transitioned;
}

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

        // Recalculate effective_scores so dashboard reflects the change immediately
        let updatedWindows = 0;
        try {
          updatedWindows = await recalcEffectiveScores(db, system_id || null);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Effective score recalc after ack failed: ${err.message}`);
        }

        // Transition related open findings to 'acknowledged' status
        let transitionedFindings = 0;
        try {
          // Get the messages of the acknowledged events for matching
          // PG events: query events table directly
          let msgQuery = db('events')
            .whereNotNull('acknowledged_at')
            .where('timestamp', '<=', toTs);
          if (fromTs) msgQuery = msgQuery.where('timestamp', '>=', fromTs);
          if (system_id) msgQuery = msgQuery.where('system_id', system_id);
          const ackedRows = await msgQuery.distinct('message').limit(500);
          const ackedMsgs = ackedRows.map((r: any) => String(r.message || ''));

          // ES events: also fetch messages from Elasticsearch for ES-backed systems
          if (system_id) {
            const sys = await db('monitored_systems').where({ id: system_id }).first();
            if (sys?.event_source === 'elasticsearch') {
              try {
                const esSource = getEventSource(sys, db);
                const esAckedIds = await db('es_event_metadata')
                  .where({ system_id })
                  .whereNotNull('acknowledged_at')
                  .select('es_event_id')
                  .limit(200);
                if (esAckedIds.length > 0) {
                  const esEvents = await esSource.getSystemEvents(system_id, {
                    limit: Math.min(esAckedIds.length, 200),
                    event_ids: esAckedIds.map((r: any) => r.es_event_id),
                  });
                  for (const evt of esEvents) {
                    if (evt.message) ackedMsgs.push(String(evt.message));
                  }
                }
              } catch { /* ES unavailable — skip */ }
            }
          }

          transitionedFindings = await transitionFindingsOnAck(db, system_id || null, ackedMsgs);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Finding transition after ack failed: ${err.message}`);
        }

        app.log.info(
          `[${localTimestamp()}] Bulk event acknowledgement: ${totalAcked} events` +
          `${system_id ? ` (system=${system_id})` : ''}, range=${fromTs ?? 'beginning'}..${toTs}` +
          `, ${updatedWindows} windows recalculated, ${transitionedFindings} findings transitioned`,
        );

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'event_acknowledge',
          resource_type: 'events',
          details: { system_id, from: fromTs, to: toTs, count: totalAcked, updatedWindows, transitionedFindings },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          acknowledged: totalAcked,
          updated_windows: updatedWindows,
          transitioned_findings: transitionedFindings,
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

        // Recalculate effective_scores (scores were deleted, will be re-scored by pipeline)
        let updatedWindows = 0;
        try {
          updatedWindows = await recalcEffectiveScores(db, system_id || null);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Effective score recalc after unack failed: ${err.message}`);
        }

        app.log.info(
          `[${localTimestamp()}] Bulk event un-acknowledge: ${result} events, ${updatedWindows} windows recalculated`,
        );

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'event_unacknowledge',
          resource_type: 'events',
          details: { count: result, updatedWindows },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          unacknowledged: result,
          updated_windows: updatedWindows,
          message: `${result} event${result !== 1 ? 's' : ''} un-acknowledged.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Event un-acknowledge error: ${err.message}`);
        return reply.code(500).send({ error: 'Event un-acknowledgement failed.' });
      }
    },
  );

  // ── Acknowledge event group (per-template) ──────────────────
  /**
   * POST /api/v1/events/acknowledge-group
   *
   * Acknowledge all events matching a template group (by group_key / template_id)
   * within a system.  Deletes their event_scores, recalculates effective scores,
   * and transitions related open findings to 'acknowledged'.
   *
   * Supports both PG-backed and ES-backed systems.
   *
   * Body: { system_id: string, group_key: string }
   */
  app.post(
    '/api/v1/events/acknowledge-group',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { system_id, group_key } = body;

      if (!system_id || typeof system_id !== 'string') {
        return reply.code(400).send({ error: '"system_id" is required.' });
      }
      if (!group_key || typeof group_key !== 'string') {
        return reply.code(400).send({ error: '"group_key" is required.' });
      }

      try {
        const ackTs = new Date().toISOString();
        const system = await db('monitored_systems').where({ id: system_id }).first();
        const isEs = system?.event_source === 'elasticsearch';

        let ackResult = 0;
        let idStrings: string[] = [];
        let ackedMsgs: string[] = [];

        if (isEs) {
          // ES-backed: acknowledge via es_event_metadata, get messages from ES
          const metaRows = await db('es_event_metadata')
            .where({ system_id })
            .whereNull('acknowledged_at')
            .where(function (this: any) {
              this.where('template_id', group_key)
                .orWhere('es_event_id', group_key);
            })
            .select('es_event_id');

          if (metaRows.length === 0) {
            return reply.send({ acknowledged: 0, message: 'No matching events to acknowledge.' });
          }

          idStrings = metaRows.map((r: any) => r.es_event_id);
          ackResult = idStrings.length;

          // Update es_event_metadata
          const CHUNK = 5000;
          for (let i = 0; i < idStrings.length; i += CHUNK) {
            const chunk = idStrings.slice(i, i + CHUNK);
            await db('es_event_metadata')
              .where({ system_id })
              .whereIn('es_event_id', chunk)
              .update({ acknowledged_at: ackTs });
          }

          // Delete event_scores
          for (let i = 0; i < idStrings.length; i += CHUNK) {
            await db('event_scores')
              .whereIn('event_id', idStrings.slice(i, i + CHUNK))
              .del();
          }

          // Fetch messages from ES for finding transition (best-effort)
          try {
            const eventSource = getEventSource(system!, db);
            const esEvents = await eventSource.getSystemEvents(system_id, {
              limit: Math.min(idStrings.length, 100),
              event_ids: idStrings.slice(0, 100),
            });
            ackedMsgs = esEvents.map((e: any) => String(e.message || '')).filter(Boolean);
          } catch { /* ES unavailable — skip finding transition */ }

        } else {
          // PG-backed: single UPDATE ... RETURNING to get IDs and messages
          const ackedRows = await db.raw(`
            UPDATE events SET acknowledged_at = ?
            WHERE system_id = ?
              AND acknowledged_at IS NULL
              AND (template_id = ? OR id::text = ?)
            RETURNING id::text AS id, message
          `, [ackTs, system_id, group_key, group_key]);

          const rows = ackedRows.rows ?? [];
          ackResult = rows.length;

          if (ackResult === 0) {
            return reply.send({ acknowledged: 0, message: 'No matching events to acknowledge.' });
          }

          idStrings = rows.map((r: any) => r.id);
          ackedMsgs = [...new Set(rows.map((r: any) => String(r.message || '')).filter(Boolean))].slice(0, 100);

          // Delete event_scores for acked events
          if (idStrings.length > 0) {
            const CHUNK = 5000;
            for (let i = 0; i < idStrings.length; i += CHUNK) {
              await db('event_scores')
                .whereIn('event_id', idStrings.slice(i, i + CHUNK))
                .del();
            }
          }
        }

        // Recalculate effective_scores
        let updatedWindows = 0;
        try {
          updatedWindows = await recalcEffectiveScores(db, system_id);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Effective score recalc after group ack failed: ${err.message}`);
        }

        // Transition related open findings to 'acknowledged'
        let transitionedFindings = 0;
        try {
          transitionedFindings = await transitionFindingsOnAck(db, system_id, ackedMsgs);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Finding transition after group ack failed: ${err.message}`);
        }

        app.log.info(
          `[${localTimestamp()}] Group ack: ${ackResult} events (group=${group_key}, system=${system_id}), ` +
          `${updatedWindows} windows recalculated, ${transitionedFindings} findings transitioned`,
        );

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'event_acknowledge_group',
          resource_type: 'events',
          details: { system_id, group_key, count: ackResult, updatedWindows, transitionedFindings },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          acknowledged: ackResult,
          updated_windows: updatedWindows,
          transitioned_findings: transitionedFindings,
          message: `${ackResult} event${ackResult !== 1 ? 's' : ''} in group acknowledged.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Group event acknowledge error: ${err.message}`);
        return reply.code(500).send({ error: 'Group event acknowledgement failed.' });
      }
    },
  );

  // ── Unacknowledge event group (per-template) ─────────────────
  /**
   * POST /api/v1/events/unacknowledge-group
   *
   * Un-acknowledge all events matching a template group within a system.
   * Deletes their event_scores so the pipeline can re-score them.
   *
   * Supports both PG-backed and ES-backed systems.
   */
  app.post(
    '/api/v1/events/unacknowledge-group',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { system_id, group_key } = body;

      if (!system_id || typeof system_id !== 'string') {
        return reply.code(400).send({ error: '"system_id" is required.' });
      }
      if (!group_key || typeof group_key !== 'string') {
        return reply.code(400).send({ error: '"group_key" is required.' });
      }

      try {
        const system = await db('monitored_systems').where({ id: system_id }).first();
        const isEs = system?.event_source === 'elasticsearch';
        const CHUNK = 5000;
        let unackCount = 0;
        let idStrings: string[] = [];

        if (isEs) {
          // ES-backed: find acknowledged events in es_event_metadata
          const metaRows = await db('es_event_metadata')
            .where({ system_id })
            .whereNotNull('acknowledged_at')
            .where(function (this: any) {
              this.where('template_id', group_key)
                .orWhere('es_event_id', group_key);
            })
            .select('es_event_id');

          if (metaRows.length === 0) {
            return reply.send({ unacknowledged: 0, message: 'No matching acknowledged events.' });
          }

          idStrings = metaRows.map((r: any) => r.es_event_id);
          unackCount = idStrings.length;

          // Clear acknowledged_at and scored_at so the pipeline re-scores them
          for (let i = 0; i < idStrings.length; i += CHUNK) {
            await db('es_event_metadata')
              .where({ system_id })
              .whereIn('es_event_id', idStrings.slice(i, i + CHUNK))
              .update({ acknowledged_at: null, scored_at: null });
          }

          // Delete event_scores so pipeline re-scores them
          for (let i = 0; i < idStrings.length; i += CHUNK) {
            await db('event_scores')
              .whereIn('event_id', idStrings.slice(i, i + CHUNK))
              .del();
          }
        } else {
          // PG-backed: find events in events table (original path)
          const rows = await db('events')
            .where('system_id', system_id)
            .whereNotNull('acknowledged_at')
            .where(function (this: any) {
              this.where('template_id', group_key)
                .orWhere(db.raw('id::text = ?', [group_key]));
            })
            .select(db.raw('id::text as id'));

          if (rows.length === 0) {
            return reply.send({ unacknowledged: 0, message: 'No matching acknowledged events.' });
          }

          idStrings = rows.map((r: any) => r.id);
          unackCount = idStrings.length;

          // Clear acknowledged_at and scored_at so the pipeline re-scores them
          await db('events')
            .where('system_id', system_id)
            .whereNotNull('acknowledged_at')
            .where(function (this: any) {
              this.where('template_id', group_key)
                .orWhere(db.raw('id::text = ?', [group_key]));
            })
            .update({ acknowledged_at: null, scored_at: null });

          // Delete scores so pipeline re-scores them
          for (let i = 0; i < idStrings.length; i += CHUNK) {
            await db('event_scores')
              .whereIn('event_id', idStrings.slice(i, i + CHUNK))
              .del();
          }
        }

        // Recalculate effective_scores
        let updatedWindows = 0;
        try {
          updatedWindows = await recalcEffectiveScores(db, system_id);
        } catch (err: any) {
          app.log.error(`[${localTimestamp()}] Effective score recalc after group unack failed: ${err.message}`);
        }

        app.log.info(
          `[${localTimestamp()}] Group unack: ${unackCount} events (group=${group_key}, system=${system_id}), ` +
          `${updatedWindows} windows recalculated`,
        );

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'event_unacknowledge_group',
          resource_type: 'events',
          details: { system_id, group_key, count: unackCount, updatedWindows },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          unacknowledged: unackCount,
          updated_windows: updatedWindows,
          message: `${unackCount} event${unackCount !== 1 ? 's' : ''} in group un-acknowledged.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Group event un-acknowledge error: ${err.message}`);
        return reply.code(500).send({ error: 'Group event un-acknowledgement failed.' });
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
        actor_name: getActorName(request),
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

  // ── Fetch events by IDs (for "Show Events" on findings) ────
  /**
   * POST /api/v1/events/by-ids
   *
   * Returns events matching the provided IDs (max 50).
   * Body: { ids: string[] }
   */
  app.post(
    '/api/v1/events/by-ids',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { ids } = body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: '"ids" must be a non-empty array.' });
      }
      if (ids.length > 50) {
        return reply.code(400).send({ error: 'Maximum 50 event IDs per request.' });
      }

      // Validate each ID is a string matching UUID or alphanumeric format
      const safeIdRegex = /^[0-9a-zA-Z_-]{1,128}$/;
      const validIds = ids.filter((id: unknown) => typeof id === 'string' && safeIdRegex.test(id));
      if (validIds.length === 0) {
        return reply.code(400).send({ error: 'No valid event IDs provided.' });
      }

      try {
        // Separate UUIDs (PG events) from non-UUIDs (ES event IDs)
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const pgIds = validIds.filter((id: string) => UUID_REGEX.test(id));
        const esIds = validIds.filter((id: string) => !UUID_REGEX.test(id));

        // PG events
        const pgEvents = pgIds.length > 0
          ? await db('events')
              .whereIn('id', pgIds)
              .select('id', 'timestamp', 'host', 'source_ip', 'severity', 'program', 'message', 'system_id', 'acknowledged_at')
              .orderBy('timestamp', 'desc')
          : [];

        // ES events: look up system via es_event_metadata, then fetch from ES
        let esEvents: any[] = [];
        if (esIds.length > 0) {
          try {
            const metaRows = await db('es_event_metadata')
              .whereIn('es_event_id', esIds)
              .select('es_event_id', 'system_id', 'acknowledged_at');
            if (metaRows.length > 0) {
              // Group by system_id for batch fetching
              const bySystem = new Map<string, string[]>();
              const metaMap = new Map<string, any>();
              for (const row of metaRows) {
                let list = bySystem.get(row.system_id);
                if (!list) { list = []; bySystem.set(row.system_id, list); }
                list.push(row.es_event_id);
                metaMap.set(row.es_event_id, row);
              }
              for (const [sysId, eids] of bySystem) {
                const sys = await db('monitored_systems').where({ id: sysId }).first();
                if (!sys) continue;
                const src = getEventSource(sys, db);
                const fetched = await src.getSystemEvents(sysId, { limit: eids.length, event_ids: eids });
                for (const evt of fetched) {
                  const meta = metaMap.get(evt.id);
                  esEvents.push({
                    id: evt.id,
                    timestamp: evt.timestamp,
                    host: evt.host ?? null,
                    source_ip: evt.source_ip ?? null,
                    severity: evt.severity ?? null,
                    program: evt.program ?? null,
                    message: evt.message ?? null,
                    system_id: sysId,
                    acknowledged_at: meta?.acknowledged_at ?? null,
                  });
                }
              }
            }
          } catch (esErr: any) {
            app.log.warn(`[${localTimestamp()}] ES event fetch for by-ids failed (non-critical): ${esErr.message}`);
          }
        }

        const events = [...pgEvents, ...esEvents].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );

        return reply.send({ events });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Fetch events by IDs error: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch events.' });
      }
    },
  );
}
