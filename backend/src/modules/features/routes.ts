import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { localTimestamp } from '../../config/index.js';
import { generateComplianceExport, type ExportParams } from './exportCompliance.js';
import { askQuestion } from './rag.js';
import { resolveAiConfig, resolveCustomPrompts, invalidateAiConfigCache } from '../llm/aiConfig.js';
import { DEFAULT_SCORE_SYSTEM_PROMPT, DEFAULT_META_SYSTEM_PROMPT, DEFAULT_RAG_SYSTEM_PROMPT } from '../llm/adapter.js';

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

      // Validate system_id format if provided (OWASP A03 — injection prevention)
      if (system_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(system_id)) {
        return reply.code(400).send({ error: 'system_id must be a valid UUID.' });
      }

      try {
        const result = await askQuestion(db, question, { systemId: system_id, from, to });

        // Persist Q&A to rag_history
        try {
          let systemName: string | null = null;
          if (system_id) {
            const sys = await db('monitored_systems').where({ id: system_id }).first('name');
            systemName = sys?.name ?? null;
          }
          await db('rag_history').insert({
            question: question.replace(/[\x00-\x1f]/g, '').slice(0, 500),
            answer: result.answer,
            system_id: system_id || null,
            system_name: systemName,
            from_filter: from || null,
            to_filter: to || null,
            context_used: result.context_used,
          });
        } catch (saveErr: any) {
          // Non-critical — log but don't fail the response
          app.log.warn(`[${localTimestamp()}] Failed to save RAG history: ${saveErr.message}`);
        }

        return reply.send(result);
      } catch (err: any) {
        // askQuestion already sanitizes the error message for the client
        return reply.code(500).send({ error: err.message ?? 'Internal error processing question.' });
      }
    },
  );

  // ── RAG history ──────────────────────────────────────────────

  // UUID v4 format regex for input validation
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** GET /api/v1/ask/history — list persisted Q&A entries */
  app.get<{ Querystring: { system_id?: string; limit?: string } }>(
    '/api/v1/ask/history',
    { preHandler: requireAuth('admin', 'read', 'dashboard') },
    async (request, reply) => {
      const { system_id } = request.query;
      const rawLimit = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;

      if (system_id && !UUID_RE.test(system_id)) {
        return reply.code(400).send({ error: 'system_id must be a valid UUID.' });
      }

      try {
        let query = db('rag_history')
          .orderBy('created_at', 'desc')
          .limit(limit)
          .select('*');

        if (system_id) {
          query = query.where({ system_id });
        }

        const rows = await query;
        return reply.send(rows);
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch RAG history: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch history.' });
      }
    },
  );

  /** DELETE /api/v1/ask/history — clear all or system-scoped history */
  app.delete<{ Querystring: { system_id?: string } }>(
    '/api/v1/ask/history',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const { system_id } = request.query;

      if (system_id && !UUID_RE.test(system_id)) {
        return reply.code(400).send({ error: 'system_id must be a valid UUID.' });
      }

      try {
        let query = db('rag_history');
        if (system_id) {
          query = query.where({ system_id });
        }
        const deleted = await query.del();
        app.log.info(`[${localTimestamp()}] RAG history cleared: ${deleted} entries${system_id ? ` (system ${system_id})` : ''}`);
        return reply.send({ deleted });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to clear RAG history: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to clear history.' });
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

  // ── System prompts (LLM instructions) ──────────────────────

  /**
   * GET /api/v1/ai-prompts — returns current scoring & meta prompts
   * with info about whether they are custom or defaults.
   */
  app.get(
    '/api/v1/ai-prompts',
    { preHandler: requireAuth('admin') },
    async (_req, reply) => {
      const custom = await resolveCustomPrompts(db);

      return reply.send({
        scoring_system_prompt: custom.scoringSystemPrompt ?? null,
        meta_system_prompt: custom.metaSystemPrompt ?? null,
        rag_system_prompt: custom.ragSystemPrompt ?? null,
        scoring_is_custom: !!custom.scoringSystemPrompt,
        meta_is_custom: !!custom.metaSystemPrompt,
        rag_is_custom: !!custom.ragSystemPrompt,
        default_scoring_system_prompt: DEFAULT_SCORE_SYSTEM_PROMPT,
        default_meta_system_prompt: DEFAULT_META_SYSTEM_PROMPT,
        default_rag_system_prompt: DEFAULT_RAG_SYSTEM_PROMPT,
      });
    },
  );

  /**
   * PUT /api/v1/ai-prompts — update system prompts.
   * Send null or empty string to reset a prompt back to the built-in default.
   */
  app.put(
    '/api/v1/ai-prompts',
    { preHandler: requireAuth('admin') },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { scoring_system_prompt, meta_system_prompt, rag_system_prompt } = body;

      if (scoring_system_prompt === undefined && meta_system_prompt === undefined && rag_system_prompt === undefined) {
        return reply.code(400).send({ error: 'Provide at least one of: scoring_system_prompt, meta_system_prompt, rag_system_prompt.' });
      }

      // Validate — prompts must be strings, max 10 000 chars each
      const MAX_PROMPT_LEN = 10_000;

      const promptFields = [
        { key: 'scoring_system_prompt', val: scoring_system_prompt },
        { key: 'meta_system_prompt', val: meta_system_prompt },
        { key: 'rag_system_prompt', val: rag_system_prompt },
      ];

      for (const { key, val } of promptFields) {
        if (val !== undefined && val !== null && val !== '') {
          if (typeof val !== 'string') {
            return reply.code(400).send({ error: `${key} must be a string.` });
          }
          if (val.length > MAX_PROMPT_LEN) {
            return reply.code(400).send({ error: `${key} exceeds maximum length (${MAX_PROMPT_LEN} chars).` });
          }
        }
      }

      // Upsert or delete each prompt
      for (const { key, val } of promptFields) {
        if (val === undefined) continue;
        if (!val || (typeof val === 'string' && val.trim() === '')) {
          // Reset to default — delete from app_config
          await db('app_config').where({ key }).del();
        } else {
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, [key, JSON.stringify(val)]);
        }
      }

      // Flush cache
      invalidateAiConfigCache();

      app.log.info(`[${localTimestamp()}] AI system prompts updated`);

      // Return updated state
      const custom = await resolveCustomPrompts(db);
      return reply.send({
        scoring_system_prompt: custom.scoringSystemPrompt ?? null,
        meta_system_prompt: custom.metaSystemPrompt ?? null,
        rag_system_prompt: custom.ragSystemPrompt ?? null,
        scoring_is_custom: !!custom.scoringSystemPrompt,
        meta_is_custom: !!custom.metaSystemPrompt,
        rag_is_custom: !!custom.ragSystemPrompt,
        default_scoring_system_prompt: DEFAULT_SCORE_SYSTEM_PROMPT,
        default_meta_system_prompt: DEFAULT_META_SYSTEM_PROMPT,
        default_rag_system_prompt: DEFAULT_RAG_SYSTEM_PROMPT,
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
