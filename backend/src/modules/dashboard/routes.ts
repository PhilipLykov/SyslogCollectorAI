import { v4 as uuidv4 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { CRITERIA } from '../../types/index.js';
import { localTimestamp } from '../../config/index.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { getEventSource, getDefaultEventSource } from '../../services/eventSourceFactory.js';
import { OpenAiAdapter } from '../llm/adapter.js';
import { resolveAiConfig } from '../llm/aiConfig.js';
import { metaAnalyzeWindow } from '../pipeline/metaAnalyze.js';
import { recalcEffectiveScores } from '../events/recalcScores.js';
import { runPerEventScoringJob } from '../pipeline/scoringJob.js';

/**
 * Dashboard-oriented API routes: system overview, drill-down, SSE stream.
 */
export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const eventSource = getDefaultEventSource(db);

  /** Load the dashboard config from app_config. */
  async function loadDashboardConfig(): Promise<{
    score_display_window_days: number;
    reeval_window_days: number;
    reeval_max_events: number;
  }> {
    const DEFAULTS = { score_display_window_days: 7, reeval_window_days: 7, reeval_max_events: 500 };
    try {
      const row = await db('app_config').where({ key: 'dashboard_config' }).first('value');
      if (!row) return DEFAULTS;
      const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (raw && typeof raw === 'object') {
        const days = Number((raw as any).score_display_window_days);
        const reevalDays = Number((raw as any).reeval_window_days);
        const reevalMax = Number((raw as any).reeval_max_events);
        return {
          score_display_window_days:
            Number.isFinite(days) && days >= 1 && days <= 90 ? days : DEFAULTS.score_display_window_days,
          reeval_window_days:
            Number.isFinite(reevalDays) && reevalDays >= 1 && reevalDays <= 90 ? reevalDays : DEFAULTS.reeval_window_days,
          reeval_max_events:
            Number.isFinite(reevalMax) && reevalMax >= 50 && reevalMax <= 10000 ? reevalMax : DEFAULTS.reeval_max_events,
        };
      }
      return DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  }

  // ── Dashboard overview: systems with latest effective scores ─
  app.get(
    '/api/v1/dashboard/systems',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (_request, reply) => {
      const systems = await db('monitored_systems').orderBy('name').select('*');
      const dashCfg = await loadDashboardConfig();
      const sinceWindow = new Date(Date.now() - dashCfg.score_display_window_days * 24 * 60 * 60 * 1000).toISOString();

      // ── Bulk queries (reduce N+1 per-system loops) ──────────

      // 1. Latest window per system (single query)
      const latestWindows = await db.raw(`
        SELECT DISTINCT ON (system_id) id, system_id, from_ts, to_ts
        FROM windows
        ORDER BY system_id, to_ts DESC
      `);
      const windowMap = new Map<string, any>();
      for (const w of latestWindows.rows ?? []) windowMap.set(w.system_id, w);

      // 2. Effective scores: MAX across display window, grouped by system + criterion
      const allScoreRows = await db('effective_scores')
        .join('windows', 'effective_scores.window_id', 'windows.id')
        .where('windows.to_ts', '>=', sinceWindow)
        .groupBy('effective_scores.system_id', 'effective_scores.criterion_id')
        .select(
          'effective_scores.system_id',
          'effective_scores.criterion_id',
          db.raw('MAX(effective_scores.effective_value) as effective_value'),
          db.raw('MAX(effective_scores.meta_score) as meta_score'),
          db.raw('MAX(effective_scores.max_event_score) as max_event_score'),
        );
      const scoreMap = new Map<string, Record<string, { effective: number; meta: number; max_event: number }>>();
      for (const row of allScoreRows) {
        const criterion = CRITERIA.find((c) => c.id === row.criterion_id);
        if (!criterion) continue;
        let sysScores = scoreMap.get(row.system_id);
        if (!sysScores) { sysScores = {}; scoreMap.set(row.system_id, sysScores); }
        sysScores[criterion.slug] = {
          effective: Number(row.effective_value) || 0,
          meta: Number(row.meta_score) || 0,
          max_event: Number(row.max_event_score) || 0,
        };
      }

      // 2b. Fallback: for systems with no effective_scores, compute live MAX from event_scores
      const systemIdsWithScores = new Set(scoreMap.keys());
      const systemsNeedingFallback = systems.filter((s: any) => !systemIdsWithScores.has(s.id));
      if (systemsNeedingFallback.length > 0) {
        const fallbackIds = systemsNeedingFallback.map((s: any) => s.id);
        const fallbackRows = await db.raw(
          `
            SELECT e.system_id, es.criterion_id, MAX(es.score) as max_score
            FROM event_scores es
            JOIN events e ON e.id::text = es.event_id
            WHERE e.system_id = ANY(?)
              AND e.timestamp >= ?
              AND es.score_type = 'event'
              AND e.acknowledged_at IS NULL
            GROUP BY e.system_id, es.criterion_id
          `,
          [fallbackIds, sinceWindow],
        );
        for (const row of fallbackRows.rows ?? []) {
          const criterion = CRITERIA.find((c: any) => c.id === row.criterion_id);
          if (!criterion) continue;
          let sysScores = scoreMap.get(row.system_id);
          if (!sysScores) {
            sysScores = {};
            scoreMap.set(row.system_id, sysScores);
          }
          if (!sysScores[criterion.slug]) {
            const maxScore = Number(row.max_score) || 0;
            sysScores[criterion.slug] = {
              effective: maxScore,
              meta: 0,
              max_event: maxScore,
            };
          }
        }
      }

      // 3. Source counts per system (single query)
      const sourceCounts = await db('log_sources')
        .groupBy('system_id')
        .select('system_id', db.raw('COUNT(id)::int as cnt'));
      const sourceCountMap = new Map<string, number>();
      for (const r of sourceCounts) sourceCountMap.set(r.system_id, r.cnt);

      // 4. Event counts (within score display window) per system
      const pgEventCounts = await db('events')
        .where('timestamp', '>=', sinceWindow)
        .groupBy('system_id')
        .select('system_id', db.raw('COUNT(id)::int as cnt'));
      const eventCountMap = new Map<string, number>();
      for (const r of pgEventCounts) eventCountMap.set(r.system_id, r.cnt);

      // For ES-backed systems, query individually (rare, can't aggregate cross-backend)
      for (const system of systems) {
        if (system.event_source === 'elasticsearch' && !eventCountMap.has(system.id)) {
          const sysEventSource = getEventSource(system, db);
          const cnt = await sysEventSource.countSystemEvents(system.id, sinceWindow);
          eventCountMap.set(system.id, cnt);
        }
      }

      // 5. Open findings per system (only unhandled — acknowledged are excluded)
      const findingCountRows = await db('findings')
        .where('status', 'open')
        .groupBy('system_id', 'severity')
        .select('system_id', 'severity', db.raw('COUNT(*)::int as cnt'));
      const findingMap = new Map<string, Record<string, number>>();
      for (const row of findingCountRows) {
        let entry = findingMap.get(row.system_id);
        if (!entry) { entry = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }; findingMap.set(row.system_id, entry); }
        const count = Number(row.cnt) || 0;
        const sev = (row.severity as string).toLowerCase();
        if (sev in entry) entry[sev] = count;
        entry.total += count;
      }

      // ── Assemble response ───────────────────────────────────
      const result = systems.map((system: any) => {
        const latestWindow = windowMap.get(system.id);
        return {
          id: system.id,
          name: system.name,
          description: system.description,
          source_count: sourceCountMap.get(system.id) ?? 0,
          event_count: eventCountMap.get(system.id) ?? 0,
          latest_window: latestWindow
            ? { id: latestWindow.id, from: latestWindow.from_ts, to: latestWindow.to_ts }
            : null,
          scores: scoreMap.get(system.id) ?? {},
          active_findings: findingMap.has(system.id) ? findingMap.get(system.id) : undefined,
          updated_at: system.updated_at,
        };
      });

      return reply.send(result);
    },
  );

  // ── Drill-down: events for a system ────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: {
      from?: string; to?: string; limit?: string;
      severity?: string; host?: string; program?: string;
      service?: string; facility?: string;
      event_ids?: string;
    };
  }>(
    '/api/v1/systems/:id/events',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_VIEW) },
    async (request, reply) => {
      const { id } = request.params;
      const { from, to } = request.query;
      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 100;

      // Parse comma-separated multi-value filter params into arrays
      const parseFilter = (val?: string): string[] | undefined => {
        if (!val) return undefined;
        const items = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        return items.length > 0 ? items : undefined;
      };

      // Load system to determine event source
      const system = await db('monitored_systems').where({ id }).first();
      const sysEventSource = system ? getEventSource(system, db) : eventSource;
      // Validate event_ids — accept UUIDs (PostgreSQL) and alphanumeric IDs
      // (Elasticsearch _id). Reject anything with SQL/NoSQL-significant chars.
      const rawEventIds = parseFilter(request.query.event_ids);
      const safeIdRegex = /^[0-9a-zA-Z_-]{1,128}$/;
      const event_ids = rawEventIds?.filter((id) => safeIdRegex.test(id));

      const events = await sysEventSource.getSystemEvents(id, {
        from, to, limit,
        severity: parseFilter(request.query.severity),
        host: parseFilter(request.query.host),
        program: parseFilter(request.query.program),
        service: parseFilter(request.query.service),
        facility: parseFilter(request.query.facility),
        event_ids: event_ids?.length ? event_ids : undefined,
      });
      return reply.send(events);
    },
  );

  // ── Drill-down: meta for a system (specific window) ────────
  app.get<{ Params: { id: string }; Querystring: { window_id?: string } }>(
    '/api/v1/systems/:id/meta',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      const { id } = request.params;

      let windowId = request.query.window_id;

      if (!windowId) {
        // Get latest window for this system
        const latestWindow = await db('windows')
          .where({ system_id: id })
          .orderBy('to_ts', 'desc')
          .first();
        windowId = latestWindow?.id;
      }

      if (!windowId) {
        return reply.code(404).send({ error: 'No windows found for this system' });
      }

      const meta = await db('meta_results').where({ window_id: windowId }).first();
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

  // ── Findings: persistent, per-system findings with acknowledge ──

  // List findings for a system, filterable by status
  app.get<{
    Params: { id: string };
    Querystring: { status?: string; limit?: string };
  }>(
    '/api/v1/systems/:id/findings',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      const { id } = request.params;
      const statusFilter = request.query.status; // 'open', 'acknowledged', 'resolved', or 'active' (open+acknowledged)
      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 100;

      let query = db('findings')
        .where({ system_id: id })
        .orderBy('created_at', 'desc')
        .limit(limit);

      if (statusFilter === 'active') {
        // Active = open + acknowledged (not resolved)
        query = query.whereIn('status', ['open', 'acknowledged']);
      } else if (statusFilter && ['open', 'acknowledged', 'resolved'].includes(statusFilter)) {
        query = query.where({ status: statusFilter });
      }

      const rows = await query.select('*');
      return reply.send(rows);
    },
  );

  // Acknowledge a finding
  app.put<{ Params: { findingId: string } }>(
    '/api/v1/findings/:findingId/acknowledge',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { findingId } = request.params;

      const finding = await db('findings').where({ id: findingId }).first();
      if (!finding) {
        return reply.code(404).send({ error: 'Finding not found' });
      }
      if (finding.status === 'resolved') {
        return reply.code(400).send({ error: 'Cannot acknowledge a resolved finding' });
      }

      const now = new Date().toISOString();
      await db('findings')
        .where({ id: findingId })
        .update({
          status: 'acknowledged',
          acknowledged_at: now,
          acknowledged_by: request.currentUser?.username ?? request.apiKey?.name ?? 'system',
        });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'finding_acknowledge',
        resource_type: 'finding',
        resource_id: findingId,
        details: { previous_status: finding.status },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('findings').where({ id: findingId }).first();
      return reply.send(updated);
    },
  );

  // Re-open an acknowledged finding (undo)
  app.put<{ Params: { findingId: string } }>(
    '/api/v1/findings/:findingId/reopen',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { findingId } = request.params;

      const finding = await db('findings').where({ id: findingId }).first();
      if (!finding) {
        return reply.code(404).send({ error: 'Finding not found' });
      }
      if (finding.status !== 'acknowledged') {
        return reply.code(400).send({ error: 'Only acknowledged findings can be reopened' });
      }

      await db('findings')
        .where({ id: findingId })
        .update({
          status: 'open',
          acknowledged_at: null,
          acknowledged_by: null,
        });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'finding_reopen',
        resource_type: 'finding',
        resource_id: findingId,
        details: {},
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('findings').where({ id: findingId }).first();
      return reply.send(updated);
    },
  );

  // ── SSE: score updates stream ──────────────────────────────
  app.get(
    '/api/v1/scores/stream',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      // Hijack the reply so Fastify does not try to manage the response
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial data
      try {
        const systems = await db('monitored_systems').select('id', 'name');
        reply.raw.write(`data: ${JSON.stringify({ type: 'init', systems })}\n\n`);
      } catch (err) {
        app.log.error(`[${localTimestamp()}] SSE init error: ${err}`);
      }

      // Poll for updates every 15s
      let intervalCleared = false;
      const interval = setInterval(async () => {
        if (intervalCleared) return;
        try {
          if (request.raw.destroyed) {
            intervalCleared = true;
            clearInterval(interval);
            return;
          }

          const since = new Date(Date.now() - 30_000).toISOString();

          const recentMeta = await db('meta_results')
            .where('created_at', '>=', since)
            .join('windows', 'meta_results.window_id', 'windows.id')
            .select('windows.system_id', 'meta_results.window_id', 'meta_results.meta_scores', 'meta_results.summary');

          // Re-check after async DB query (client may have disconnected during query)
          if (request.raw.destroyed) {
            intervalCleared = true;
            clearInterval(interval);
            return;
          }

          if (recentMeta.length > 0) {
            const sseJsonParse = (val: unknown) => {
              if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
              return val;
            };
            const payload = recentMeta.map((m: any) => ({
              system_id: m.system_id,
              window_id: m.window_id,
              meta_scores: sseJsonParse(m.meta_scores),
              summary: m.summary,
            }));
            reply.raw.write(`data: ${JSON.stringify({ type: 'update', results: payload })}\n\n`);
          } else {
            // Heartbeat
            reply.raw.write(`: heartbeat\n\n`);
          }
        } catch (err) {
          // Client may have disconnected or DB error
          if (request.raw.destroyed) {
            intervalCleared = true;
            clearInterval(interval);
          } else {
            app.log.error(`[${localTimestamp()}] SSE poll error: ${err}`);
          }
        }
      }, 15_000);

      request.raw.on('close', () => {
        intervalCleared = true;
        clearInterval(interval);
      });
    },
  );

  // ── Recalculate effective scores for a system ──────────────
  app.post<{ Params: { systemId: string } }>(
    '/api/v1/systems/:systemId/recalculate-scores',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      const { systemId } = request.params;
      const system = await db('monitored_systems').where({ id: systemId }).first();
      if (!system) return reply.code(404).send({ error: 'System not found.' });

      const updated = await recalcEffectiveScores(db, systemId);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'recalculate_scores',
        resource_type: 'system',
        resource_id: systemId,
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({ ok: true, updated_rows: updated });
    },
  );

  // ── Re-evaluate meta-analysis for a system ─────────────────
  // Creates a fresh window and runs a full meta-analysis (LLM call).
  // Normal-behavior events are automatically excluded by metaAnalyzeWindow.
  // Acknowledged events are always excluded during re-evaluate so the fresh
  // summary does not reference events the user has already acknowledged.
  app.post<{ Params: { systemId: string } }>(
    '/api/v1/systems/:systemId/re-evaluate',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { systemId } = request.params;

      const system = await db('monitored_systems').where({ id: systemId }).first();
      if (!system) return reply.code(404).send({ error: 'System not found' });

      // Resolve AI config and verify it's usable
      const aiCfg = await resolveAiConfig(db);
      if (!aiCfg.apiKey) {
        return reply.code(400).send({ error: 'AI is not configured — set an API key in Settings.' });
      }

      const llm = new OpenAiAdapter();
      llm.updateConfig({ apiKey: aiCfg.apiKey, model: aiCfg.model, baseUrl: aiCfg.baseUrl });

      // Load dashboard config to get re-eval parameters
      const dashCfgReeval = await loadDashboardConfig();
      const reevalWindowDays = dashCfgReeval.reeval_window_days;
      const reevalMaxEvents = dashCfgReeval.reeval_max_events;

      // Create a window covering reeval_window_days back from now
      const to_ts = new Date().toISOString();
      const from_ts = new Date(Date.now() - reevalWindowDays * 24 * 60 * 60 * 1000).toISOString();

      const sysEventSource = getEventSource(system, db);
      const eventCount = await sysEventSource.countEventsInTimeRange(systemId, from_ts, to_ts);
      if (eventCount === 0) {
        return reply.code(200).send({
          message: `No events in the last ${reevalWindowDays} day(s) to analyze.`,
          window_id: null,
          event_count: 0,
        });
      }

      // Load pipeline config for SQL normalization setting
      let normalizeSql = false;
      try {
        const pipeRow = await db('app_config').where({ key: 'pipeline_config' }).first('value');
        if (pipeRow?.value) {
          const pipeParsed = typeof pipeRow.value === 'string' ? JSON.parse(pipeRow.value) : pipeRow.value;
          normalizeSql = !!pipeParsed?.normalize_sql_statements;
        }
      } catch { /* use default */ }

      // Score any unscored events for this system first so that
      // the meta-analysis operates on fully scored data.
      try {
        const scoringResult = await runPerEventScoringJob(db, llm, {
          systemId,
          limit: reevalMaxEvents,
          normalizeSql,
        });
        if (scoringResult.scored > 0) {
          app.log.info(`[${localTimestamp()}] Re-evaluate: scored ${scoringResult.scored} events for system ${systemId}`);
        }
      } catch (err: any) {
        app.log.warn(`[${localTimestamp()}] Pre-reeval per-event scoring failed: ${err.message}`);
      }

      // Recalculate effective scores BEFORE LLM call
      try {
        await recalcEffectiveScores(db, systemId);
      } catch (err: any) {
        app.log.warn(`[${localTimestamp()}] Pre-reeval recalc failed: ${err.message}`);
      }

      const windowId = uuidv4();
      await db('windows').insert({
        id: windowId,
        system_id: systemId,
        from_ts,
        to_ts,
        trigger: 'manual',
      });

      app.log.debug(
        `[${localTimestamp()}] Re-evaluate triggered for system "${system.name}" (${systemId}), window ${windowId} [${from_ts} — ${to_ts}], ${eventCount} events`,
      );

      try {
        await metaAnalyzeWindow(db, llm, windowId, {
          excludeAcknowledged: true,
          resetContext: true,
          maxEvents: reevalMaxEvents,
        });
      } catch (err) {
        app.log.error(
          `[${localTimestamp()}] Re-evaluate meta-analysis failed for window ${windowId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.code(500).send({
          error: 'Meta-analysis failed. Check AI configuration and try again.',
        });
      }

      // Recalculate effective scores AFTER LLM call
      try {
        await recalcEffectiveScores(db, systemId);
      } catch (err: any) {
        app.log.warn(`[${localTimestamp()}] Post-reeval recalc failed: ${err.message}`);
      }

      // Fetch the new effective scores to return to the caller
      const newScores: Record<string, { effective: number; meta: number; max_event: number }> = {};
      const effRows = await db('effective_scores').where({ window_id: windowId, system_id: systemId });
      for (const row of effRows) {
        const criterion = CRITERIA.find((c) => c.id === row.criterion_id);
        if (criterion) {
          newScores[criterion.slug] = {
            effective: Number(row.effective_value) || 0,
            meta: Number(row.meta_score) || 0,
            max_event: Number(row.max_event_score) || 0,
          };
        }
      }

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'system_re_evaluate',
        resource_type: 'monitored_system',
        resource_id: systemId,
        details: { window_id: windowId, event_count: eventCount },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({
        message: `Meta-analysis completed for ${eventCount} events.`,
        window_id: windowId,
        event_count: eventCount,
        scores: newScores,
      });
    },
  );
}
