import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { generateComplianceExport, type ExportParams } from './exportCompliance.js';
import { askQuestion } from './rag.js';
import { resolveAiConfig, resolveCustomPrompts, resolveCriterionGuidelines, invalidateAiConfigCache, invalidateCriterionGuidelinesCache } from '../llm/aiConfig.js';
import { DEFAULT_SCORE_SYSTEM_PROMPT, DEFAULT_META_SYSTEM_PROMPT, DEFAULT_RAG_SYSTEM_PROMPT, DEFAULT_CRITERION_GUIDELINES, buildScoringPrompt } from '../llm/adapter.js';
import { runMaintenance, loadMaintenanceConfig } from '../maintenance/maintenanceJob.js';
import {
  loadBackupConfig,
  invalidateBackupConfigCache,
  runBackup,
  listBackups,
  getBackupPath,
  deleteBackupFile,
  cleanupOldBackups,
  BACKUP_CONFIG_DEFAULTS,
} from '../maintenance/backupJob.js';
import { PRIVACY_FILTER_DEFAULTS, invalidatePrivacyFilterCache } from '../llm/llmPrivacyFilter.js';
import { writeAuditLog } from '../../middleware/audit.js';
import { getDefaultEventSource } from '../../services/eventSourceFactory.js';

/**
 * Phase 7 feature routes: compliance export, RAG query, app config,
 * AI configuration, cost visibility.
 */
export async function registerFeaturesRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── Compliance export ──────────────────────────────────────
  app.post<{ Body: ExportParams }>(
    '/api/v1/export/compliance',
    { preHandler: requireAuth(PERMISSIONS.COMPLIANCE_EXPORT) },
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
    { preHandler: requireAuth(PERMISSIONS.RAG_USE) },
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
    { preHandler: requireAuth(PERMISSIONS.RAG_USE) },
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
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
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

        await writeAuditLog(db, {
          action: 'rag_history_delete',
          resource_type: 'rag_history',
          details: { deleted, system_id: system_id ?? null },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

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
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
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
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const { key, value } = request.body ?? {} as any;

      if (!key || value === undefined) {
        return reply.code(400).send({ error: '"key" and "value" are required.' });
      }

      await db.raw(`
        INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [key, JSON.stringify(value)]);

      await writeAuditLog(db, {
        action: 'config_update',
        resource_type: 'app_config',
        details: { key },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({ key, value });
    },
  );

  // ── AI configuration (model, base URL, API key) ────────────
  app.get(
    '/api/v1/ai-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
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
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
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

      await writeAuditLog(db, {
        action: 'ai_config_update',
        resource_type: 'ai_config',
        details: { fields: updates.map(u => u.key) },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

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
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
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
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
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

      await writeAuditLog(db, {
        action: 'prompt_update',
        resource_type: 'ai_prompts',
        details: { fields: promptFields.filter(f => f.val !== undefined).map(f => f.key) },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

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

  // ── Per-criterion scoring guidelines ─────────────────────────
  const CRITERION_SLUGS_LIST = [
    'it_security', 'performance_degradation', 'failure_prediction',
    'anomaly', 'compliance_audit', 'operational_risk',
  ];
  const CRITERION_GUIDE_PREFIX = 'criterion_guide_';
  const MAX_GUIDE_LEN = 5000;

  /**
   * GET /api/v1/ai-prompts/criterion-guidelines
   * Returns per-criterion scoring guidelines (current + defaults).
   */
  app.get(
    '/api/v1/ai-prompts/criterion-guidelines',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      const overrides = await resolveCriterionGuidelines(db);

      const guidelines: Record<string, {
        current: string;
        default_value: string;
        is_custom: boolean;
      }> = {};

      for (const slug of CRITERION_SLUGS_LIST) {
        const custom = overrides[slug];
        guidelines[slug] = {
          current: custom ?? DEFAULT_CRITERION_GUIDELINES[slug] ?? '',
          default_value: DEFAULT_CRITERION_GUIDELINES[slug] ?? '',
          is_custom: !!custom,
        };
      }

      // Also return the assembled prompt preview so the user can see what the LLM receives
      const effectiveOverrides: Record<string, string> = {};
      for (const slug of CRITERION_SLUGS_LIST) {
        effectiveOverrides[slug] = overrides[slug] ?? DEFAULT_CRITERION_GUIDELINES[slug] ?? '';
      }

      return reply.send({
        guidelines,
        assembled_prompt_preview: buildScoringPrompt(effectiveOverrides),
      });
    },
  );

  /**
   * PUT /api/v1/ai-prompts/criterion-guidelines
   * Update one or more per-criterion scoring guidelines.
   * Send null or empty string for a slug to reset it to the built-in default.
   */
  app.put(
    '/api/v1/ai-prompts/criterion-guidelines',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = request.body as Record<string, string | null | undefined> ?? {};

      // Validate — only known criterion slugs
      const updates: Array<{ slug: string; value: string | null }> = [];
      for (const [key, val] of Object.entries(body)) {
        if (!CRITERION_SLUGS_LIST.includes(key)) {
          return reply.code(400).send({ error: `Unknown criterion slug: "${key}". Valid slugs: ${CRITERION_SLUGS_LIST.join(', ')}` });
        }
        if (val !== undefined && val !== null && val !== '') {
          if (typeof val !== 'string') {
            return reply.code(400).send({ error: `Guideline for "${key}" must be a string.` });
          }
          if (val.length > MAX_GUIDE_LEN) {
            return reply.code(400).send({ error: `Guideline for "${key}" exceeds maximum length (${MAX_GUIDE_LEN} chars).` });
          }
        }
        updates.push({ slug: key, value: (val && typeof val === 'string' && val.trim() !== '') ? val : null });
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'Provide at least one criterion slug with a guideline value.' });
      }

      // Upsert or delete each guideline
      for (const { slug, value } of updates) {
        const dbKey = `${CRITERION_GUIDE_PREFIX}${slug}`;
        if (value === null) {
          await db('app_config').where({ key: dbKey }).del();
        } else {
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, [dbKey, JSON.stringify(value)]);
        }
      }

      // Flush caches
      invalidateAiConfigCache();
      invalidateCriterionGuidelinesCache();

      await writeAuditLog(db, {
        action: 'guideline_update',
        resource_type: 'ai_prompts',
        details: { criteria: updates.map(u => u.slug) },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] Criterion scoring guidelines updated: ${updates.map((u) => u.slug).join(', ')}`);

      // Return updated state (same shape as GET)
      const overrides = await resolveCriterionGuidelines(db);
      const guidelines: Record<string, {
        current: string;
        default_value: string;
        is_custom: boolean;
      }> = {};
      const effectiveOverrides: Record<string, string> = {};
      for (const slug of CRITERION_SLUGS_LIST) {
        const custom = overrides[slug];
        guidelines[slug] = {
          current: custom ?? DEFAULT_CRITERION_GUIDELINES[slug] ?? '',
          default_value: DEFAULT_CRITERION_GUIDELINES[slug] ?? '',
          is_custom: !!custom,
        };
        effectiveOverrides[slug] = overrides[slug] ?? DEFAULT_CRITERION_GUIDELINES[slug] ?? '';
      }

      return reply.send({
        guidelines,
        assembled_prompt_preview: buildScoringPrompt(effectiveOverrides),
      });
    },
  );

  // ── Cost visibility ────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string; system_id?: string; group_by?: string } }>(
    '/api/v1/costs',
    { preHandler: requireAuth(PERMISSIONS.AI_USAGE_VIEW) },
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

  // ── Token Optimisation config ────────────────────────────

  const TOKEN_OPT_DEFAULTS = {
    score_cache_enabled: true,
    score_cache_ttl_minutes: 360,
    severity_filter_enabled: false,
    severity_skip_levels: ['debug'],
    severity_default_score: 0,
    message_max_length: 512,
    scoring_batch_size: 20,
    low_score_auto_skip_enabled: false,
    low_score_threshold: 0.05,
    low_score_min_scorings: 5,
    meta_max_events: 200,
    meta_prioritize_high_scores: true,
    // O1: Skip LLM meta-analysis entirely when all events in window scored 0
    skip_zero_score_meta: true,
    // O2: Exclude zero-score events from meta-analysis prompt to reduce tokens
    filter_zero_score_meta_events: true,
  };

  /** GET /api/v1/token-optimization — return current config with defaults. */
  app.get(
    '/api/v1/token-optimization',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'token_optimization' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        // Merge with defaults to fill any missing keys
        const config = { ...TOKEN_OPT_DEFAULTS, ...parsed };

        // Also return cache stats
        const stats = await db('message_templates')
          .whereNotNull('last_scored_at')
          .count('id as cached_templates')
          .avg('avg_max_score as average_score')
          .first();

        return reply.send({
          config,
          defaults: TOKEN_OPT_DEFAULTS,
          cache_stats: {
            cached_templates: Number(stats?.cached_templates ?? 0),
            average_score: stats?.average_score != null ? Number(Number(stats.average_score).toFixed(4)) : null,
          },
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch token-optimization config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/token-optimization — update config with validation. */
  app.put(
    '/api/v1/token-optimization',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      // Validate individual fields
      if (body.score_cache_ttl_minutes !== undefined) {
        const v = Number(body.score_cache_ttl_minutes);
        if (!Number.isFinite(v) || v < 1 || v > 10080) {
          return reply.code(400).send({ error: 'score_cache_ttl_minutes must be 1–10080.' });
        }
      }
      if (body.message_max_length !== undefined) {
        const v = Number(body.message_max_length);
        if (!Number.isFinite(v) || v < 50 || v > 10000) {
          return reply.code(400).send({ error: 'message_max_length must be 50–10000.' });
        }
      }
      if (body.scoring_batch_size !== undefined) {
        const v = Number(body.scoring_batch_size);
        if (!Number.isFinite(v) || v < 1 || v > 100) {
          return reply.code(400).send({ error: 'scoring_batch_size must be 1–100.' });
        }
      }
      if (body.low_score_threshold !== undefined) {
        const v = Number(body.low_score_threshold);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          return reply.code(400).send({ error: 'low_score_threshold must be 0–1.' });
        }
      }
      if (body.low_score_min_scorings !== undefined) {
        const v = Number(body.low_score_min_scorings);
        if (!Number.isFinite(v) || v < 1 || v > 100) {
          return reply.code(400).send({ error: 'low_score_min_scorings must be 1–100.' });
        }
      }
      if (body.meta_max_events !== undefined) {
        const v = Number(body.meta_max_events);
        if (!Number.isFinite(v) || v < 10 || v > 2000) {
          return reply.code(400).send({ error: 'meta_max_events must be 10–2000.' });
        }
      }
      if (body.severity_skip_levels !== undefined) {
        if (!Array.isArray(body.severity_skip_levels)) {
          return reply.code(400).send({ error: 'severity_skip_levels must be an array.' });
        }
        if (body.severity_skip_levels.some((s: unknown) => typeof s !== 'string')) {
          return reply.code(400).send({ error: 'severity_skip_levels must contain only strings.' });
        }
      }

      try {
        // Load existing config, merge with new values
        const existing = await db('app_config').where({ key: 'token_optimization' }).first('value');
        let current: Record<string, unknown> = { ...TOKEN_OPT_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        // Only merge known keys
        const allowedKeys = Object.keys(TOKEN_OPT_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('token_optimization', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'token_optimization',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Token optimization config updated`);

        return reply.send({ config: current, defaults: TOKEN_OPT_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update token-optimization config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  /** POST /api/v1/token-optimization/invalidate-cache — clear all template score caches. */
  app.post(
    '/api/v1/token-optimization/invalidate-cache',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (_req, reply) => {
      try {
        const result = await db('message_templates')
          .whereNotNull('last_scored_at')
          .update({
            last_scored_at: null,
            cached_scores: null,
          });

        await writeAuditLog(db, {
          action: 'cache_invalidate',
          resource_type: 'score_cache',
          details: { cleared: result },
          ip: _req.ip,
          user_id: _req.currentUser?.id,
          session_id: _req.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Score cache invalidated: ${result} templates cleared`);
        return reply.send({ cleared: result });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to invalidate score cache: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to invalidate cache.' });
      }
    },
  );

  // ── Meta-Analysis Config (finding dedup, auto-resolve, severity decay) ──

  const META_CONFIG_DEFAULTS = {
    finding_dedup_enabled: true,
    finding_dedup_threshold: 0.6,
    max_new_findings_per_window: 3,
    auto_resolve_after_misses: 0,
    severity_decay_enabled: false,
    severity_decay_after_occurrences: 10,
    max_open_findings_per_system: 50,
    // Number of previous window summaries included as LLM context
    context_window_size: 5,
    // How far back (days) to check for recently resolved findings when detecting recurring issues
    recurring_lookback_days: 14,
  };

  /** GET /api/v1/meta-analysis-config — return current config with defaults and stats. */
  app.get(
    '/api/v1/meta-analysis-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'meta_analysis_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        const config = { ...META_CONFIG_DEFAULTS, ...parsed };

        // Gather stats about current findings
        const findingsStats = await db('findings')
          .where({ status: 'open' })
          .select(
            db.raw('COUNT(*) as total_open'),
            db.raw('AVG(occurrence_count) as avg_occurrence_count'),
            db.raw('MAX(occurrence_count) as max_occurrence_count'),
            db.raw('AVG(consecutive_misses) as avg_consecutive_misses'),
          )
          .first();

        return reply.send({
          config,
          defaults: META_CONFIG_DEFAULTS,
          stats: {
            total_open_findings: Number(findingsStats?.total_open ?? 0),
            avg_occurrence_count: findingsStats?.avg_occurrence_count != null
              ? Number(Number(findingsStats.avg_occurrence_count).toFixed(1)) : 0,
            max_occurrence_count: Number(findingsStats?.max_occurrence_count ?? 0),
            avg_consecutive_misses: findingsStats?.avg_consecutive_misses != null
              ? Number(Number(findingsStats.avg_consecutive_misses).toFixed(1)) : 0,
          },
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch meta-analysis config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/meta-analysis-config — update config with validation. */
  app.put(
    '/api/v1/meta-analysis-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      // Validate individual fields
      if (body.finding_dedup_threshold !== undefined) {
        const v = Number(body.finding_dedup_threshold);
        if (!Number.isFinite(v) || v < 0.1 || v > 1.0) {
          return reply.code(400).send({ error: 'finding_dedup_threshold must be 0.1–1.0.' });
        }
      }
      if (body.max_new_findings_per_window !== undefined) {
        const v = Number(body.max_new_findings_per_window);
        if (!Number.isFinite(v) || v < 1 || v > 50) {
          return reply.code(400).send({ error: 'max_new_findings_per_window must be 1–50.' });
        }
      }
      if (body.auto_resolve_after_misses !== undefined) {
        const v = Number(body.auto_resolve_after_misses);
        if (!Number.isFinite(v) || v < 0 || v > 100) {
          return reply.code(400).send({ error: 'auto_resolve_after_misses must be 0–100 (0 = disabled).' });
        }
      }
      if (body.severity_decay_after_occurrences !== undefined) {
        const v = Number(body.severity_decay_after_occurrences);
        if (!Number.isFinite(v) || v < 1 || v > 100) {
          return reply.code(400).send({ error: 'severity_decay_after_occurrences must be 1–100.' });
        }
      }
      if (body.max_open_findings_per_system !== undefined) {
        const v = Number(body.max_open_findings_per_system);
        if (!Number.isFinite(v) || v < 5 || v > 200) {
          return reply.code(400).send({ error: 'max_open_findings_per_system must be 5–200.' });
        }
      }
      if (body.context_window_size !== undefined) {
        const v = Number(body.context_window_size);
        if (!Number.isFinite(v) || v < 1 || v > 20) {
          return reply.code(400).send({ error: 'context_window_size must be 1–20.' });
        }
      }
      if (body.recurring_lookback_days !== undefined) {
        const v = Number(body.recurring_lookback_days);
        if (!Number.isFinite(v) || v < 1 || v > 90) {
          return reply.code(400).send({ error: 'recurring_lookback_days must be 1–90.' });
        }
      }

      try {
        // Load existing config, merge with new values
        const existing = await db('app_config').where({ key: 'meta_analysis_config' }).first('value');
        let current: Record<string, unknown> = { ...META_CONFIG_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        // Only merge known keys
        const allowedKeys = Object.keys(META_CONFIG_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('meta_analysis_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'meta_analysis_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Meta-analysis config updated`);

        return reply.send({ config: current, defaults: META_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update meta-analysis config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  // ── Dashboard Config (score display window, etc.) ──────────

  const DASHBOARD_CONFIG_DEFAULTS: Record<string, unknown> = {
    score_display_window_days: 7,
  };

  /** GET /api/v1/dashboard-config — return current dashboard config with defaults. */
  app.get(
    '/api/v1/dashboard-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'dashboard_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        const config = { ...DASHBOARD_CONFIG_DEFAULTS, ...parsed };
        return reply.send({ config, defaults: DASHBOARD_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch dashboard config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/dashboard-config — update dashboard config with validation. */
  app.put(
    '/api/v1/dashboard-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      if (body.score_display_window_days !== undefined) {
        const v = Number(body.score_display_window_days);
        if (!Number.isFinite(v) || v < 1 || v > 90) {
          return reply.code(400).send({ error: 'score_display_window_days must be 1–90.' });
        }
      }

      try {
        const existing = await db('app_config').where({ key: 'dashboard_config' }).first('value');
        let current: Record<string, unknown> = { ...DASHBOARD_CONFIG_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        const allowedKeys = Object.keys(DASHBOARD_CONFIG_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('dashboard_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'dashboard_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Dashboard config updated`);

        return reply.send({ config: current, defaults: DASHBOARD_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update dashboard config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  // ── Pipeline Config (interval, window size, scoring limit, meta weight) ──

  const PIPELINE_CONFIG_DEFAULTS: Record<string, unknown> = {
    pipeline_interval_minutes: 5,
    window_minutes: 5,
    scoring_limit_per_run: 500,
    effective_score_meta_weight: 0.7,
  };

  /** GET /api/v1/pipeline-config — return current pipeline config with defaults. */
  app.get(
    '/api/v1/pipeline-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'pipeline_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        const config = { ...PIPELINE_CONFIG_DEFAULTS, ...parsed };
        return reply.send({ config, defaults: PIPELINE_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch pipeline config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/pipeline-config — update pipeline config with validation. */
  app.put(
    '/api/v1/pipeline-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      if (body.pipeline_interval_minutes !== undefined) {
        const v = Number(body.pipeline_interval_minutes);
        if (!Number.isFinite(v) || v < 1 || v > 60) {
          return reply.code(400).send({ error: 'pipeline_interval_minutes must be 1–60.' });
        }
      }
      if (body.window_minutes !== undefined) {
        const v = Number(body.window_minutes);
        if (!Number.isFinite(v) || v < 1 || v > 60) {
          return reply.code(400).send({ error: 'window_minutes must be 1–60.' });
        }
      }
      if (body.scoring_limit_per_run !== undefined) {
        const v = Number(body.scoring_limit_per_run);
        if (!Number.isFinite(v) || v < 10 || v > 5000) {
          return reply.code(400).send({ error: 'scoring_limit_per_run must be 10–5000.' });
        }
      }
      if (body.effective_score_meta_weight !== undefined) {
        const v = Number(body.effective_score_meta_weight);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          return reply.code(400).send({ error: 'effective_score_meta_weight must be 0.0–1.0.' });
        }
      }

      try {
        const existing = await db('app_config').where({ key: 'pipeline_config' }).first('value');
        let current: Record<string, unknown> = { ...PIPELINE_CONFIG_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        const allowedKeys = Object.keys(PIPELINE_CONFIG_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('pipeline_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'pipeline_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Pipeline config updated`);

        return reply.send({ config: current, defaults: PIPELINE_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update pipeline config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  // ── Per-Task Model Config (O3: two-tier model) ────────────

  const TASK_MODEL_DEFAULTS: Record<string, string> = {
    scoring_model: '',
    meta_model: '',
    rag_model: '',
  };

  /** GET /api/v1/task-model-config — return per-task model overrides. */
  app.get(
    '/api/v1/task-model-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'task_model_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        const config = { ...TASK_MODEL_DEFAULTS, ...parsed };
        return reply.send({ config, defaults: TASK_MODEL_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch task-model config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/task-model-config — update per-task model overrides. */
  app.put(
    '/api/v1/task-model-config',
    { preHandler: requireAuth(PERMISSIONS.AI_CONFIG_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      // Validate: each field must be a string (model name) or empty string
      for (const key of ['scoring_model', 'meta_model', 'rag_model']) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== 'string' || body[key].length > 128) {
            return reply.code(400).send({ error: `${key} must be a string up to 128 characters.` });
          }
        }
      }

      try {
        const existing = await db('app_config').where({ key: 'task_model_config' }).first('value');
        let current: Record<string, unknown> = { ...TASK_MODEL_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        const allowedKeys = Object.keys(TASK_MODEL_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('task_model_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'task_model_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Task model config updated`);

        return reply.send({ config: current, defaults: TASK_MODEL_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update task-model config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  // ── Database Maintenance Config ────────────────────────────

  const MAINT_CONFIG_DEFAULTS = {
    default_retention_days: 90,
    maintenance_interval_hours: 6,
  };

  /** GET /api/v1/maintenance-config — current maintenance settings and per-system retention. */
  app.get(
    '/api/v1/maintenance-config',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_VIEW) },
    async (_req, reply) => {
      try {
        const cfg = await loadMaintenanceConfig(db);

        // Per-system retention info
        const systems = await db('monitored_systems')
          .select('id', 'name', 'retention_days')
          .orderBy('name');

        // DB size stats (best effort)
        let dbStats: Record<string, unknown> = {};
        try {
          const sizeResult = await db.raw(`
            SELECT
              pg_size_pretty(pg_database_size(current_database())) as db_size,
              (SELECT count(*) FROM events) as total_events,
              (SELECT count(*) FROM event_scores) as total_event_scores,
              (SELECT count(*) FROM findings) as total_findings,
              (SELECT count(*) FROM message_templates) as total_templates
          `);
          if (sizeResult.rows?.length) {
            dbStats = sizeResult.rows[0];
          }
        } catch {
          // Some queries might fail — non-critical
        }

        return reply.send({
          config: cfg,
          defaults: MAINT_CONFIG_DEFAULTS,
          systems: systems.map((s: any) => ({
            id: s.id,
            name: s.name,
            retention_days: s.retention_days,
            effective_retention_days: s.retention_days ?? cfg.default_retention_days,
          })),
          db_stats: dbStats,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch maintenance config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/maintenance-config — update global maintenance settings. */
  app.put(
    '/api/v1/maintenance-config',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      if (body.default_retention_days !== undefined) {
        const v = Number(body.default_retention_days);
        if (!Number.isFinite(v) || v < 1 || v > 3650) {
          return reply.code(400).send({ error: 'default_retention_days must be 1–3650.' });
        }
      }

      if (body.maintenance_interval_hours !== undefined) {
        const v = Number(body.maintenance_interval_hours);
        if (!Number.isFinite(v) || v < 1 || v > 168) {
          return reply.code(400).send({ error: 'maintenance_interval_hours must be 1–168 (max 7 days).' });
        }
      }

      try {
        if (body.default_retention_days !== undefined) {
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES ('default_retention_days', ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, [JSON.stringify(body.default_retention_days)]);
        }

        if (body.maintenance_interval_hours !== undefined) {
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES ('maintenance_interval_hours', ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, [JSON.stringify(body.maintenance_interval_hours)]);
        }

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'maintenance_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Maintenance config updated`);

        const cfg = await loadMaintenanceConfig(db);
        return reply.send({ config: cfg, defaults: MAINT_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update maintenance config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  /** POST /api/v1/maintenance/run — trigger manual maintenance run. */
  app.post(
    '/api/v1/maintenance/run',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (_req, reply) => {
      try {
        app.log.info(`[${localTimestamp()}] Manual maintenance run triggered`);
        await writeAuditLog(db, {
          action: 'maintenance_run',
          resource_type: 'maintenance',
          ip: _req.ip,
          user_id: _req.currentUser?.id,
          session_id: _req.currentSession?.id,
        });
        const result = await runMaintenance(db);
        return reply.send(result);
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Manual maintenance run failed: ${err.message}`);
        return reply.code(500).send({ error: `Maintenance run failed: ${err.message}` });
      }
    },
  );

  /** GET /api/v1/maintenance/history — list recent maintenance runs. */
  app.get<{ Querystring: { limit?: string } }>(
    '/api/v1/maintenance/history',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_VIEW) },
    async (request, reply) => {
      const rawLimit = Number(request.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 20;

      try {
        const rows = await db('maintenance_log')
          .orderBy('started_at', 'desc')
          .limit(limit)
          .select('*');

        // Parse details JSON
        const runs = rows.map((r: any) => {
          let details = r.details;
          if (typeof details === 'string') {
            try { details = JSON.parse(details); } catch { /* keep as-is */ }
          }
          return { ...r, details };
        });

        return reply.send(runs);
      } catch (err: any) {
        // Table might not exist yet
        if (err.message.includes('does not exist')) {
          return reply.send([]);
        }
        app.log.error(`[${localTimestamp()}] Failed to fetch maintenance history: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch history.' });
      }
    },
  );

  // ── Database Backup ────────────────────────────────────────

  /** GET /api/v1/maintenance/backup/config — get backup settings. */
  app.get(
    '/api/v1/maintenance/backup/config',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_VIEW) },
    async (_req, reply) => {
      try {
        const cfg = await loadBackupConfig(db);
        const backups = listBackups();
        return reply.send({
          config: cfg,
          defaults: BACKUP_CONFIG_DEFAULTS,
          backups_count: backups.length,
          total_size_bytes: backups.reduce((sum, b) => sum + b.size_bytes, 0),
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch backup config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch backup config.' });
      }
    },
  );

  /** PUT /api/v1/maintenance/backup/config — update backup settings. */
  app.put(
    '/api/v1/maintenance/backup/config',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      if (body.backup_interval_hours !== undefined) {
        const v = Number(body.backup_interval_hours);
        if (!Number.isFinite(v) || v < 1 || v > 720) {
          return reply.code(400).send({ error: 'backup_interval_hours must be 1–720 (max 30 days).' });
        }
      }

      if (body.backup_retention_count !== undefined) {
        const v = Number(body.backup_retention_count);
        if (!Number.isFinite(v) || v < 1 || v > 100) {
          return reply.code(400).send({ error: 'backup_retention_count must be 1–100.' });
        }
      }

      if (body.backup_format !== undefined) {
        if (!['custom', 'plain'].includes(body.backup_format)) {
          return reply.code(400).send({ error: 'backup_format must be "custom" or "plain".' });
        }
      }

      try {
        // Load existing, merge
        const existing = await db('app_config').where({ key: 'backup_config' }).first('value');
        let current: Record<string, unknown> = { ...BACKUP_CONFIG_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        const allowedKeys = Object.keys(BACKUP_CONFIG_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('backup_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        invalidateBackupConfigCache();

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'backup_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Backup config updated`);

        return reply.send({ config: current, defaults: BACKUP_CONFIG_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update backup config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update backup config.' });
      }
    },
  );

  /** POST /api/v1/maintenance/backup/trigger — trigger manual backup. */
  app.post(
    '/api/v1/maintenance/backup/trigger',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (_req, reply) => {
      try {
        app.log.info(`[${localTimestamp()}] Manual backup triggered`);
        await writeAuditLog(db, {
          action: 'backup_trigger',
          resource_type: 'backup',
          ip: _req.ip,
          user_id: _req.currentUser?.id,
          session_id: _req.currentSession?.id,
        });
        const result = await runBackup(db);

        // Run cleanup after backup
        if (result.success) {
          const cfg = await loadBackupConfig(db);
          cleanupOldBackups(cfg.backup_retention_count);
        }

        return reply.send(result);
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Manual backup failed: ${err.message}`);
        return reply.code(500).send({ error: `Backup failed: ${err.message}` });
      }
    },
  );

  /** GET /api/v1/maintenance/backup/list — list available backup files. */
  app.get(
    '/api/v1/maintenance/backup/list',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_VIEW) },
    async (_req, reply) => {
      try {
        const backups = listBackups();
        return reply.send(backups);
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to list backups: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to list backups.' });
      }
    },
  );

  /** GET /api/v1/maintenance/backup/download/:filename — download a backup file. */
  app.get<{ Params: { filename: string } }>(
    '/api/v1/maintenance/backup/download/:filename',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (request, reply) => {
      const { filename } = request.params;
      const filepath = getBackupPath(filename);

      if (!filepath) {
        return reply.code(404).send({ error: 'Backup file not found.' });
      }

      const stat = statSync(filepath);
      const contentType = filename.endsWith('.dump')
        ? 'application/octet-stream'
        : 'application/gzip';

      return reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', stat.size)
        .send(createReadStream(filepath));
    },
  );

  /** DELETE /api/v1/maintenance/backup/:filename — delete a specific backup. */
  app.delete<{ Params: { filename: string } }>(
    '/api/v1/maintenance/backup/:filename',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_MANAGE) },
    async (request, reply) => {
      const { filename } = request.params;
      const deleted = deleteBackupFile(filename);

      if (!deleted) {
        return reply.code(404).send({ error: 'Backup file not found or could not be deleted.' });
      }

      await writeAuditLog(db, {
        action: 'backup_delete',
        resource_type: 'backup',
        details: { filename },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] Backup deleted: ${filename}`);
      return reply.send({ deleted: true, filename });
    },
  );

  // ── Privacy Settings ──────────────────────────────────────

  /** GET /api/v1/privacy-config — return current privacy settings. */
  app.get(
    '/api/v1/privacy-config',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_VIEW) },
    async (_req, reply) => {
      try {
        const row = await db('app_config').where({ key: 'privacy_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
        }
        const config = { ...PRIVACY_FILTER_DEFAULTS, ...parsed };

        // Ensure custom_patterns is always an array
        if (!Array.isArray(config.custom_patterns)) {
          config.custom_patterns = [];
        }

        return reply.send({ config, defaults: PRIVACY_FILTER_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to fetch privacy config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch config.' });
      }
    },
  );

  /** PUT /api/v1/privacy-config — update privacy settings. */
  app.put(
    '/api/v1/privacy-config',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
    async (request, reply) => {
      const body = (request.body as any) ?? {};

      // Validate rag_history_retention_days
      if (body.rag_history_retention_days !== undefined) {
        const v = Number(body.rag_history_retention_days);
        if (!Number.isFinite(v) || v < 0 || v > 3650) {
          return reply.code(400).send({ error: 'rag_history_retention_days must be 0–3650.' });
        }
      }

      // Validate custom_patterns
      if (body.custom_patterns !== undefined) {
        if (!Array.isArray(body.custom_patterns)) {
          return reply.code(400).send({ error: 'custom_patterns must be an array.' });
        }
        // Validate each pattern
        for (let i = 0; i < body.custom_patterns.length; i++) {
          const cp = body.custom_patterns[i];
          if (!cp || typeof cp !== 'object') {
            return reply.code(400).send({ error: `custom_patterns[${i}] must be an object.` });
          }
          if (!cp.pattern || typeof cp.pattern !== 'string') {
            return reply.code(400).send({ error: `custom_patterns[${i}].pattern must be a non-empty string.` });
          }
          // Verify regex is valid
          try {
            new RegExp(cp.pattern, 'gi');
          } catch {
            return reply.code(400).send({ error: `custom_patterns[${i}].pattern is not a valid regex: "${cp.pattern}"` });
          }
          if (cp.replacement !== undefined && typeof cp.replacement !== 'string') {
            return reply.code(400).send({ error: `custom_patterns[${i}].replacement must be a string.` });
          }
        }
      }

      try {
        // Load existing config, merge with new values
        const existing = await db('app_config').where({ key: 'privacy_config' }).first('value');
        let current: Record<string, unknown> = { ...PRIVACY_FILTER_DEFAULTS };
        if (existing) {
          const raw = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (raw && typeof raw === 'object') current = { ...current, ...(raw as Record<string, unknown>) };
        }

        // Only merge known keys
        const allowedKeys = Object.keys(PRIVACY_FILTER_DEFAULTS);
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            current[key] = body[key];
          }
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('privacy_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        // Invalidate cache so pipeline picks up changes
        invalidatePrivacyFilterCache();

        await writeAuditLog(db, {
          action: 'config_update',
          resource_type: 'privacy_config',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] Privacy config updated`);

        return reply.send({ config: current, defaults: PRIVACY_FILTER_DEFAULTS });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to update privacy config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update config.' });
      }
    },
  );

  /** POST /api/v1/privacy/test-filter — test privacy filter against a sample message. */
  app.post<{ Body: { message: string } }>(
    '/api/v1/privacy/test-filter',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
    async (request, reply) => {
      const { message } = request.body ?? {} as any;
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: '"message" is required.' });
      }

      try {
        // Import dynamically to get the latest config
        const { loadPrivacyFilterConfig, filterText } = await import('../llm/llmPrivacyFilter.js');
        const config = await loadPrivacyFilterConfig(db);
        const filtered = filterText(message, config);

        return reply.send({
          original: message,
          filtered,
          filter_enabled: config.llm_filter_enabled,
          changes_made: message !== filtered,
        });
      } catch (err: any) {
        return reply.code(500).send({ error: `Test failed: ${err.message}` });
      }
    },
  );

  // ── Bulk Event Deletion (protected) ───────────────────────

  /**
   * POST /api/v1/events/bulk-delete — delete all events for a specified period.
   * Requires body.confirmation === "YES" to proceed.
   */
  app.post<{
    Body: {
      confirmation: string;
      from?: string;
      to?: string;
      system_id?: string;
    };
  }>(
    '/api/v1/events/bulk-delete',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
    async (request, reply) => {
      const { confirmation, from, to, system_id } = request.body ?? {} as any;

      // ── Safety checks ──────────────────────────────────────
      if (confirmation !== 'YES') {
        return reply.code(400).send({
          error: 'Confirmation required. Send confirmation: "YES" to proceed with deletion.',
        });
      }

      if (!from && !to && !system_id) {
        return reply.code(400).send({
          error: 'At least one filter is required (from, to, or system_id). To delete all events use the data retention settings.',
        });
      }

      // Validate dates if provided
      if (from && isNaN(Date.parse(from))) {
        return reply.code(400).send({ error: '"from" must be a valid ISO date string.' });
      }
      if (to && isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: '"to" must be a valid ISO date string.' });
      }

      // Validate system_id if provided
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (system_id && !UUID_RE.test(system_id)) {
        return reply.code(400).send({ error: 'system_id must be a valid UUID.' });
      }

      try {
        // Delete events + scores via EventSource abstraction
        const eventSource = getDefaultEventSource(db);
        const result = await eventSource.bulkDeleteEvents({ from, to, system_id });

        if (result.deleted_events === 0) {
          return reply.send({ deleted_events: 0, deleted_scores: 0, message: 'No events matched the specified criteria.' });
        }

        // Also clean up stale aggregated data (windows -> meta_results, effective_scores,
        // findings all CASCADE) so the dashboard doesn't show old scores for deleted events.
        let windowsDeleted = 0;
        try {
          let windowQuery = db('windows');
          if (from) windowQuery = windowQuery.where('from_ts', '>=', from);
          if (to) windowQuery = windowQuery.where('to_ts', '<=', to);
          if (system_id) windowQuery = windowQuery.where({ system_id });

          const windowIds = await windowQuery.pluck('id');

          if (windowIds.length > 0) {
            for (let i = 0; i < windowIds.length; i += 500) {
              const chunk = windowIds.slice(i, i + 500);
              const deleted = await db('windows').whereIn('id', chunk).del();
              windowsDeleted += deleted;
            }
          }
        } catch (cleanupErr: any) {
          app.log.warn(`[${localTimestamp()}] Bulk delete: stale data cleanup warning: ${cleanupErr.message}`);
        }

        app.log.info(
          `[${localTimestamp()}] Bulk event deletion: ${result.deleted_events} events, ${result.deleted_scores} scores, ` +
          `${windowsDeleted} windows deleted (from=${from ?? 'any'}, to=${to ?? 'any'}, system_id=${system_id ?? 'all'})`,
        );

        await writeAuditLog(db, {
          action: 'events_bulk_delete',
          resource_type: 'events',
          details: { from, to, system_id, deleted_events: result.deleted_events },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        return reply.send({
          deleted_events: result.deleted_events,
          deleted_scores: result.deleted_scores,
          deleted_windows: windowsDeleted,
          message: `Successfully deleted ${result.deleted_events} events, ${result.deleted_scores} scores, and ${windowsDeleted} analysis windows.`,
        });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Bulk event deletion failed: ${err.message}`);
        return reply.code(500).send({ error: `Deletion failed: ${err.message}` });
      }
    },
  );

  /** POST /api/v1/privacy/purge-rag-history — delete all RAG history. */
  app.post<{ Body: { confirmation: string } }>(
    '/api/v1/privacy/purge-rag-history',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
    async (request, reply) => {
      const { confirmation } = request.body ?? {} as any;
      if (confirmation !== 'YES') {
        return reply.code(400).send({ error: 'Confirmation required. Send confirmation: "YES".' });
      }

      try {
        const deleted = await db('rag_history').del();

        await writeAuditLog(db, {
          action: 'rag_purge',
          resource_type: 'rag_history',
          details: { deleted },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] RAG history purged: ${deleted} entries`);
        return reply.send({ deleted, message: `Deleted ${deleted} RAG history entries.` });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to purge RAG history: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to purge RAG history.' });
      }
    },
  );

  /** POST /api/v1/privacy/purge-llm-usage — delete all LLM usage logs. */
  app.post<{ Body: { confirmation: string } }>(
    '/api/v1/privacy/purge-llm-usage',
    { preHandler: requireAuth(PERMISSIONS.PRIVACY_MANAGE) },
    async (request, reply) => {
      const { confirmation } = request.body ?? {} as any;
      if (confirmation !== 'YES') {
        return reply.code(400).send({ error: 'Confirmation required. Send confirmation: "YES".' });
      }

      try {
        const deleted = await db('llm_usage').del();

        await writeAuditLog(db, {
          action: 'llm_usage_purge',
          resource_type: 'llm_usage',
          details: { deleted },
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession?.id,
        });

        app.log.info(`[${localTimestamp()}] LLM usage logs purged: ${deleted} entries`);
        return reply.send({ deleted, message: `Deleted ${deleted} LLM usage log entries.` });
      } catch (err: any) {
        app.log.error(`[${localTimestamp()}] Failed to purge LLM usage: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to purge LLM usage logs.' });
      }
    },
  );
}
