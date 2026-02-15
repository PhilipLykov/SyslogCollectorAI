import type { Knex } from 'knex';

/**
 * Resolved AI configuration, reading from app_config (DB) first,
 * then falling back to environment variables.
 *
 * Values set via the UI (stored in app_config) take precedence over
 * env vars. This allows runtime configuration without restarting.
 */
export interface AiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface CustomPrompts {
  /** Custom scoring system prompt. undefined = use built-in default. */
  scoringSystemPrompt?: string;
  /** Custom meta-analysis system prompt. undefined = use built-in default. */
  metaSystemPrompt?: string;
  /** Custom RAG (Ask Question) system prompt. undefined = use built-in default. */
  ragSystemPrompt?: string;
}

/**
 * Per-criterion guideline overrides.
 * Keys are criterion slugs (it_security, performance_degradation, etc.)
 * Values are custom guideline text. undefined = use built-in default.
 */
export type CriterionGuidelines = Partial<Record<string, string>>;

// ── In-memory caches — avoid hitting DB on every LLM call ────
let _cache: AiConfig | null = null;
let _cacheTs = 0;
let _promptCache: CustomPrompts | null = null;
let _promptCacheTs = 0;
let _guideCache: CriterionGuidelines | null = null;
let _guideCacheTs = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

// ── AI Config resolution ─────────────────────────────────────

/**
 * Resolve the current AI configuration.
 * Priority: app_config table → environment variables → defaults.
 */
export async function resolveAiConfig(db: Knex): Promise<AiConfig> {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;

  const rows = await db('app_config')
    .whereIn('key', ['openai_api_key', 'openai_model', 'openai_base_url'])
    .select('key', 'value');

  const dbValues: Record<string, string> = {};
  for (const row of rows) {
    let val = row.value;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { /* use as-is */ }
    }
    if (typeof val === 'string' && val.trim() !== '') {
      dbValues[row.key] = val;
    }
  }

  _cache = {
    apiKey: dbValues['openai_api_key'] ?? process.env.OPENAI_API_KEY ?? '',
    model: dbValues['openai_model'] ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    baseUrl: dbValues['openai_base_url'] ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  };
  _cacheTs = now;

  return _cache;
}

/** Flush all caches so next resolve reads from DB. */
export function invalidateAiConfigCache(): void {
  _cache = null;
  _cacheTs = 0;
  _promptCache = null;
  _promptCacheTs = 0;
  _guideCache = null;
  _guideCacheTs = 0;
  _taskModelCache = null;
  _taskModelCacheTs = 0;
}

// ── Per-task model overrides ──────────────────────────────────

export interface TaskModelConfig {
  /** Model for per-event scoring. Empty/null = use global model. */
  scoring_model: string;
  /** Model for meta-analysis. Empty/null = use global model. */
  meta_model: string;
  /** Model for RAG / Ask AI. Empty/null = use global model. */
  rag_model: string;
}

let _taskModelCache: TaskModelConfig | null = null;
let _taskModelCacheTs = 0;

/**
 * Resolve per-task model overrides from app_config.
 * Returns empty strings for unset models (= use global model).
 */
export async function resolveTaskModels(db: Knex): Promise<TaskModelConfig> {
  const now = Date.now();
  if (_taskModelCache && now - _taskModelCacheTs < CACHE_TTL_MS) return _taskModelCache;

  const DEFAULTS: TaskModelConfig = { scoring_model: '', meta_model: '', rag_model: '' };
  try {
    const row = await db('app_config').where({ key: 'task_model_config' }).first('value');
    if (!row) {
      _taskModelCache = DEFAULTS;
      _taskModelCacheTs = now;
      return DEFAULTS;
    }
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    _taskModelCache = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw as Partial<TaskModelConfig> : {}) };
    _taskModelCacheTs = now;
    return _taskModelCache!;
  } catch {
    _taskModelCache = DEFAULTS;
    _taskModelCacheTs = now;
    return DEFAULTS;
  }
}

// ── Custom system prompt resolution ─────────────────────────

/**
 * Resolve custom system prompts from app_config.
 * Returns undefined for each prompt that is not set (= use default).
 */
export async function resolveCustomPrompts(db: Knex): Promise<CustomPrompts> {
  const now = Date.now();
  if (_promptCache && now - _promptCacheTs < CACHE_TTL_MS) return _promptCache;

  const rows = await db('app_config')
    .whereIn('key', ['scoring_system_prompt', 'meta_system_prompt', 'rag_system_prompt'])
    .select('key', 'value');

  const result: CustomPrompts = {};
  for (const row of rows) {
    let val = row.value;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { /* use as-is */ }
    }
    if (typeof val === 'string' && val.trim() !== '') {
      if (row.key === 'scoring_system_prompt') result.scoringSystemPrompt = val;
      if (row.key === 'meta_system_prompt') result.metaSystemPrompt = val;
      if (row.key === 'rag_system_prompt') result.ragSystemPrompt = val;
    }
  }

  _promptCache = result;
  _promptCacheTs = now;
  return result;
}

// ── Per-criterion scoring guidelines ─────────────────────────

const CRITERION_GUIDE_PREFIX = 'criterion_guide_';

const CRITERION_SLUGS = [
  'it_security',
  'performance_degradation',
  'failure_prediction',
  'anomaly',
  'compliance_audit',
  'operational_risk',
] as const;

/**
 * Resolve per-criterion guideline overrides from app_config.
 * Returns only slugs that have custom overrides set.
 */
export async function resolveCriterionGuidelines(db: Knex): Promise<CriterionGuidelines> {
  const now = Date.now();
  if (_guideCache && now - _guideCacheTs < CACHE_TTL_MS) return _guideCache;

  const keys = CRITERION_SLUGS.map((s) => `${CRITERION_GUIDE_PREFIX}${s}`);
  const rows = await db('app_config')
    .whereIn('key', keys)
    .select('key', 'value');

  const result: CriterionGuidelines = {};
  for (const row of rows) {
    let val = row.value;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { /* use as-is */ }
    }
    if (typeof val === 'string' && val.trim() !== '') {
      const slug = row.key.replace(CRITERION_GUIDE_PREFIX, '');
      result[slug] = val;
    }
  }

  _guideCache = result;
  _guideCacheTs = now;
  return result;
}

/** Invalidate the criterion guidelines cache. */
export function invalidateCriterionGuidelinesCache(): void {
  _guideCache = null;
  _guideCacheTs = 0;
}
