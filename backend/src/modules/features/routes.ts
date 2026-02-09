import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { localTimestamp } from '../../config/index.js';
import { generateComplianceExport, type ExportParams } from './exportCompliance.js';
import { askQuestion } from './rag.js';
import { resolveAiConfig, invalidateAiConfigCache } from '../llm/aiConfig.js';

/**
 * Phase 7 feature routes: compliance export, RAG query, app config,
 * AI configuration, cost visibility.
 */
export async function registerFeaturesRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── Compliance export ──────────────────────────────────────
  app.post<{ Body: ExportParams }>(
    '/api/v1/export/compliance',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const { type, system_ids, from, to } = request.body ?? {} as any;

      if (!from || !to) {
        return reply.code(400).send({ error: '"from" and "to" are required.' });
      }

      // Validate date strings
      if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: '"from" and "to" must be valid ISO date strings.' });
      }

      const validTypes = ['csv', 'json'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` });
      }

      const { data, filename } = await generateComplianceExport(db, {
        type,
        system_ids,
        from,
        to,
      });

      const contentType = type === 'json' ? 'application/json' : 'text/csv';
      return reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(data);
    },
  );

  // ── RAG query ──────────────────────────────────────────────
  app.post<{ Body: { question: string; system_id?: string; from?: string; to?: string } }>(
    '/api/v1/ask',
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
    async (request, reply) => {
      const { question, system_id, from, to } = request.body ?? {} as any;

      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return reply.code(400).send({ error: '"question" is required.' });
      }

      try {
        const result = await askQuestion(db, question, { systemId: system_id, from, to });
        return reply.send(result);
      } catch (err: any) {
        // askQuestion already sanitizes the error message for the client
        return reply.code(500).send({ error: err.message ?? 'Internal error processing question.' });
      }
    },
  );

  // ── App config (get/set) ───────────────────────────────────
  app.get(
    '/api/v1/config',
    { preHandler: requireAuth('admin') },
    async (_req, reply) => {
      const rows = await db('app_config').select('*');
      const config: Record<string, unknown> = {};
      for (const row of rows) {
        if (typeof row.value === 'string') {
          try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
        } else {
          config[row.key] = row.value;
        }
      }
      return reply.send(config);
    },
  );

  app.put<{ Body: { key: string; value: unknown } }>(
    '/api/v1/config',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const { key, value } = request.body ?? {} as any;

      if (!key || value === undefined) {
        return reply.code(400).send({ error: '"key" and "value" are required.' });
      }

      await db.raw(`
        INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [key, JSON.stringify(value)]);

      return reply.send({ key, value });
    },
  );

  // ── AI configuration (model, base URL, API key) ────────────
  app.get(
    '/api/v1/ai-config',
    { preHandler: requireAuth('admin') },
    async (_req, reply) => {
      const cfg = await resolveAiConfig(db);

      // Determine source per field
      const dbRows = await db('app_config')
        .whereIn('key', ['openai_api_key', 'openai_model', 'openai_base_url'])
        .select('key', 'value');
      const dbKeys = new Set(dbRows.filter(r => {
        let v = r.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* ok */ } }
        return typeof v === 'string' && v.trim() !== '';
      }).map(r => r.key));

      let apiKeySource: 'database' | 'environment' | 'none' = 'none';
      if (dbKeys.has('openai_api_key')) apiKeySource = 'database';
      else if (process.env.OPENAI_API_KEY) apiKeySource = 'environment';

      const keySet = cfg.apiKey.length > 0;
      const hint = keySet
        ? `${cfg.apiKey.slice(0, 3)}${'*'.repeat(Math.max(0, cfg.apiKey.length - 7))}${cfg.apiKey.slice(-4)}`
        : '';

      return reply.send({
        model: cfg.model,
        base_url: cfg.baseUrl,
        api_key_set: keySet,
        api_key_hint: hint,
        api_key_source: apiKeySource,
      });
    },
  );

  app.put(
    '/api/v1/ai-config',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { model, base_url, api_key } = body;

      if (!model && !base_url && api_key === undefined) {
        return reply.code(400).send({ error: 'Provide at least one of: model, base_url, api_key.' });
      }

      // Validate model name (alphanumeric, dashes, dots, up to 64 chars)
      if (model !== undefined) {
        if (typeof model !== 'string' || model.trim() === '' || model.length > 64) {
          return reply.code(400).send({ error: 'model must be a non-empty string (max 64 chars).' });
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
          return reply.code(400).send({ error: 'model contains invalid characters.' });
        }
      }

      // Validate base_url
      if (base_url !== undefined) {
        if (typeof base_url !== 'string' || base_url.trim() === '') {
          return reply.code(400).send({ error: 'base_url must be a non-empty string.' });
        }
        try {
          const u = new URL(base_url);
          if (!['http:', 'https:'].includes(u.protocol)) {
            return reply.code(400).send({ error: 'base_url must use http or https.' });
          }
        } catch {
          return reply.code(400).send({ error: 'base_url is not a valid URL.' });
        }
      }

      // Validate api_key
      if (api_key !== undefined && api_key !== null) {
        if (typeof api_key !== 'string') {
          return reply.code(400).send({ error: 'api_key must be a string.' });
        }
        // Allow empty string to clear the key
      }

      // Upsert each provided field into app_config
      const updates: Array<{ key: string; value: string }> = [];
      if (model !== undefined) updates.push({ key: 'openai_model', value: JSON.stringify(model) });
      if (base_url !== undefined) updates.push({ key: 'openai_base_url', value: JSON.stringify(base_url) });
      if (api_key !== undefined) {
        if (api_key === '' || api_key === null) {
          // Clear DB key — fall back to env var
          await db('app_config').where({ key: 'openai_api_key' }).del();
        } else {
          updates.push({ key: 'openai_api_key', value: JSON.stringify(api_key) });
        }
      }

      for (const { key, value } of updates) {
        await db.raw(`
          INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [key, value]);
      }

      // Flush cache so next pipeline run picks up new values
      invalidateAiConfigCache();

      app.log.info(`[${localTimestamp()}] AI config updated (fields: ${updates.map(u => u.key).join(', ')})`);

      // Return the updated config (safe summary)
      const cfg = await resolveAiConfig(db);
      const keySet = cfg.apiKey.length > 0;
      const hint = keySet
        ? `${cfg.apiKey.slice(0, 3)}${'*'.repeat(Math.max(0, cfg.apiKey.length - 7))}${cfg.apiKey.slice(-4)}`
        : '';

      return reply.send({
        model: cfg.model,
        base_url: cfg.baseUrl,
        api_key_set: keySet,
        api_key_hint: hint,
      });
    },
  );

  // ── Cost visibility ────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string; system_id?: string; group_by?: string } }>(
    '/api/v1/costs',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const { from, to, system_id, group_by } = request.query;

      // Aggregate costs
      let query = db('llm_usage');
      if (from) query = query.where('created_at', '>=', from);
      if (to) query = query.where('created_at', '<=', to);
      if (system_id) query = query.where({ system_id });

      const totals = await query
        .select(db.raw("COALESCE(run_type, 'all') as run_type"))
        .sum('token_input as total_input')
        .sum('token_output as total_output')
        .sum('request_count as total_requests')
        .sum('event_count as total_events')
        .count('id as record_count')
        .groupBy('run_type');

      // Per-day breakdown if requested
      let daily: any[] = [];
      if (group_by === 'day') {
        let dayQuery = db('llm_usage')
          .select(db.raw("DATE(created_at) as day"))
          .sum('token_input as input')
          .sum('token_output as output')
          .sum('request_count as requests')
          .groupBy(db.raw("DATE(created_at)"))
          .orderBy('day', 'desc')
          .limit(30);

        if (from) dayQuery = dayQuery.where('created_at', '>=', from);
        if (to) dayQuery = dayQuery.where('created_at', '<=', to);
        if (system_id) dayQuery = dayQuery.where({ system_id });

        daily = await dayQuery;
      }

      return reply.send({ totals, daily });
    },
  );
}
