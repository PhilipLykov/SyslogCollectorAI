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

// In-memory cache — avoids hitting DB on every LLM call.
let _cache: AiConfig | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

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

/** Flush the cache so next resolveAiConfig reads from DB. */
export function invalidateAiConfigCache(): void {
  _cache = null;
  _cacheTs = 0;
}
