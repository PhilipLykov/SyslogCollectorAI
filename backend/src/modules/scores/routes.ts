import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { CRITERIA } from '../../types/index.js';

/**
 * Scores API — exposes effective scores, event scores, and meta results.
 * Auth: read, dashboard, or admin scope. Parameterized queries (A03).
 */
export async function registerScoresRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── Effective scores per system (latest window) ────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/v1/scores/systems',
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
    async (request, reply) => {
      const { from, to } = request.query;

      // Get latest window per system
      let windowQuery = db('windows')
        .select('windows.*')
        .distinctOn('system_id')
        .orderBy('system_id')
        .orderBy('to_ts', 'desc');

      if (from) windowQuery = windowQuery.where('from_ts', '>=', from);
      if (to) windowQuery = windowQuery.where('to_ts', '<=', to);

      const latestWindows = await windowQuery;

      const results = [];

      for (const w of latestWindows) {
        const system = await db('monitored_systems').where({ id: w.system_id }).first();

        const scores = await db('effective_scores')
          .where({ window_id: w.id, system_id: w.system_id })
          .select('criterion_id', 'effective_value', 'meta_score', 'max_event_score');

        const scoreMap: Record<string, { effective: number; meta: number; max_event: number }> = {};
        for (const s of scores) {
          const criterion = CRITERIA.find((c) => c.id === s.criterion_id);
          if (criterion) {
            scoreMap[criterion.slug] = {
              effective: s.effective_value,
              meta: s.meta_score,
              max_event: s.max_event_score,
            };
          }
        }

        results.push({
          system_id: w.system_id,
          system_name: system?.name ?? 'Unknown',
          window_id: w.id,
          window_from: w.from_ts,
          window_to: w.to_ts,
          scores: scoreMap,
          updated_at: w.created_at,
        });
      }

      return reply.send(results);
    },
  );

  // ── Event scores for a specific event ──────────────────────
  app.get<{ Params: { eventId: string } }>(
    '/api/v1/events/:eventId/scores',
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
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

  // ── Meta result for a window ───────────────────────────────
  app.get<{ Params: { windowId: string } }>(
    '/api/v1/windows/:windowId/meta',
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
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
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
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

  /**
   * Pricing table for common OpenAI models (USD per 1 million tokens).
   * Used to compute cost estimates from token counts.
   */
  const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini':     { input: 0.15,  output: 0.60  },
    'gpt-4o':          { input: 2.50,  output: 10.00 },
    'gpt-4-turbo':     { input: 10.00, output: 30.00 },
    'gpt-4':           { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo':   { input: 0.50,  output: 1.50  },
    'o1':              { input: 15.00, output: 60.00 },
    'o1-mini':         { input: 3.00,  output: 12.00 },
    'o3-mini':         { input: 1.10,  output: 4.40  },
  };

  function estimateCost(
    tokenInput: number,
    tokenOutput: number,
    model: string,
  ): number | null {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return null;
    return (tokenInput * pricing.input + tokenOutput * pricing.output) / 1_000_000;
  }

  app.get<{ Querystring: { from?: string; to?: string; system_id?: string; limit?: string } }>(
    '/api/v1/llm-usage',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 1000) : 200;

      let query = db('llm_usage').orderBy('created_at', 'desc').limit(limit);

      if (request.query.from) query = query.where('created_at', '>=', request.query.from);
      if (request.query.to) query = query.where('created_at', '<=', request.query.to);
      if (request.query.system_id) query = query.where({ system_id: request.query.system_id });

      const usage = await query.select('*');

      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

      // Resolve system names for display
      const systemIds = [...new Set(usage.map((r: any) => r.system_id).filter(Boolean))];
      const systemNames: Record<string, string> = {};
      if (systemIds.length > 0) {
        const systems = await db('monitored_systems').whereIn('id', systemIds).select('id', 'name');
        for (const s of systems) {
          systemNames[s.id] = s.name;
        }
      }

      // Enrich each record with estimated cost and system name
      const enrichedRecords = usage.map((r: any) => ({
        ...r,
        model,
        system_name: r.system_id ? (systemNames[r.system_id] ?? 'Unknown') : null,
        cost_estimate: r.cost_estimate ?? estimateCost(r.token_input, r.token_output, model),
      }));

      // Totals — apply same filters so totals match the records
      let totalsQuery = db('llm_usage');
      if (request.query.from) totalsQuery = totalsQuery.where('created_at', '>=', request.query.from);
      if (request.query.to) totalsQuery = totalsQuery.where('created_at', '<=', request.query.to);
      if (request.query.system_id) totalsQuery = totalsQuery.where({ system_id: request.query.system_id });

      const rawTotals = await totalsQuery
        .sum('token_input as total_input')
        .sum('token_output as total_output')
        .sum('request_count as total_requests')
        .first();

      // PostgreSQL SUM returns bigint → pg driver serializes as string.
      // Normalize to numbers for a consistent JSON response contract.
      const totalInput = Number(rawTotals?.total_input ?? 0);
      const totalOutput = Number(rawTotals?.total_output ?? 0);
      const totalRequests = Number(rawTotals?.total_requests ?? 0);

      return reply.send({
        records: enrichedRecords,
        totals: {
          total_input: totalInput,
          total_output: totalOutput,
          total_requests: totalRequests,
          total_cost: estimateCost(totalInput, totalOutput, model),
        },
        model,
        pricing: MODEL_PRICING[model] ?? null,
      });
    },
  );
}
