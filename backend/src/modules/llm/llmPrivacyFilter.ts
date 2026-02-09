/**
 * LLM Privacy Filter
 *
 * Applies configurable PII/sensitive data masking to event data
 * BEFORE it is sent to the LLM for analysis.
 *
 * This is separate from the ingest-time redaction (redact.ts) which
 * handles secrets/passwords at persistence time.  This filter focuses
 * on user-configurable privacy patterns applied at LLM-call time so
 * that stored events keep the original data but the LLM never sees it.
 *
 * Supported built-in pattern categories:
 *  - IPv4 / IPv6 addresses
 *  - Email addresses
 *  - Phone numbers (international formats)
 *  - URLs / URIs
 *  - User / home-directory paths
 *  - MAC addresses
 *  - Credit card numbers (basic Luhn-irrelevant pattern match)
 *  - Passwords / secrets (key=value patterns)
 *  - API keys / tokens (key=value and common key formats)
 *  - Usernames / login identifiers
 *  - Custom user-defined regex patterns
 */

import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';

// ── Types ──────────────────────────────────────────────────────

export interface PrivacyFilterConfig {
  /** Master switch for the LLM privacy filter. */
  llm_filter_enabled: boolean;

  /** Individual built-in category toggles. */
  filter_ipv4: boolean;
  filter_ipv6: boolean;
  filter_email: boolean;
  filter_phone: boolean;
  filter_urls: boolean;
  filter_user_paths: boolean;
  filter_mac_addresses: boolean;
  filter_credit_cards: boolean;
  filter_passwords: boolean;
  filter_api_keys: boolean;
  filter_usernames: boolean;

  /** Whether to strip the `host` field from events sent to LLM. */
  strip_host_field: boolean;

  /** Whether to strip the `program` field from events sent to LLM. */
  strip_program_field: boolean;

  /** Custom regex patterns (array of { pattern, replacement } objects). */
  custom_patterns: Array<{ pattern: string; replacement: string }>;

  /** Whether to log LLM request content to llm_usage (disabled = only tokens/cost). */
  log_llm_requests: boolean;

  /** Auto-delete RAG history older than N days (0 = never). */
  rag_history_retention_days: number;
}

export const PRIVACY_FILTER_DEFAULTS: PrivacyFilterConfig = {
  llm_filter_enabled: false,
  filter_ipv4: true,
  filter_ipv6: true,
  filter_email: true,
  filter_phone: true,
  filter_urls: false,
  filter_user_paths: true,
  filter_mac_addresses: true,
  filter_credit_cards: true,
  filter_passwords: true,
  filter_api_keys: true,
  filter_usernames: true,
  strip_host_field: false,
  strip_program_field: false,
  custom_patterns: [],
  log_llm_requests: true,
  rag_history_retention_days: 0,
};

// ── Built-in Patterns ──────────────────────────────────────────

const PATTERN_MAP: Record<string, { regex: RegExp; placeholder: string }> = {
  filter_ipv4: {
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\/\d{1,2})?\b/g,
    placeholder: '<IPv4>',
  },
  filter_ipv6: {
    regex: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    placeholder: '<IPv6>',
  },
  filter_email: {
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '<EMAIL>',
  },
  filter_phone: {
    regex: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
    placeholder: '<PHONE>',
  },
  filter_urls: {
    regex: /https?:\/\/[^\s"'<>]+/gi,
    placeholder: '<URL>',
  },
  filter_user_paths: {
    regex: /(?:\/home\/|\/Users\/|C:\\Users\\)[^\s"'<>:;|]+/gi,
    placeholder: '<USER_PATH>',
  },
  filter_mac_addresses: {
    regex: /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g,
    placeholder: '<MAC>',
  },
  filter_credit_cards: {
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    placeholder: '<CARD>',
  },
  filter_passwords: {
    // Matches password/secret/passwd/pwd/passphrase followed by = or : and a value (quoted or unquoted)
    regex: /(?<=(?:password|passwd|pwd|secret|pass_?phrase)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    placeholder: '<PASSWORD>',
  },
  filter_api_keys: {
    // Matches api_key/api-key/access_key/secret_key/auth_token/bearer followed by = or : and a value
    regex: /(?<=(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|bearer)\s*[=:\s]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    placeholder: '<API_KEY>',
  },
  filter_usernames: {
    // Matches user/username/login/uid/account followed by = or : and a value
    regex: /(?<=(?:user(?:name)?|login|uid|account)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    placeholder: '<USERNAME>',
  },
};

// ── Config Cache ───────────────────────────────────────────────

let _cachedConfig: PrivacyFilterConfig | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

export function invalidatePrivacyFilterCache(): void {
  _cachedConfig = null;
  _cacheTime = 0;
}

export async function loadPrivacyFilterConfig(db: Knex): Promise<PrivacyFilterConfig> {
  if (_cachedConfig && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return _cachedConfig;
  }

  try {
    const row = await db('app_config').where({ key: 'privacy_config' }).first('value');
    let parsed: Record<string, unknown> = {};
    if (row) {
      const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    }
    _cachedConfig = { ...PRIVACY_FILTER_DEFAULTS, ...parsed } as PrivacyFilterConfig;

    // Ensure custom_patterns is always an array
    if (!Array.isArray(_cachedConfig.custom_patterns)) {
      _cachedConfig.custom_patterns = [];
    }

    _cacheTime = Date.now();
    return _cachedConfig;
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to load privacy filter config:`, err);
    return { ...PRIVACY_FILTER_DEFAULTS };
  }
}

// ── Filter Function ────────────────────────────────────────────

/**
 * Apply privacy filter to a single text string.
 * Returns the filtered string with PII replaced by placeholders.
 */
export function filterText(text: string, config: PrivacyFilterConfig): string {
  if (!config.llm_filter_enabled || !text) return text;

  let result = text;

  // Apply built-in patterns
  for (const [key, { regex, placeholder }] of Object.entries(PATTERN_MAP)) {
    if ((config as any)[key]) {
      // Reset lastIndex for global regexes
      regex.lastIndex = 0;
      result = result.replace(regex, placeholder);
    }
  }

  // Apply custom patterns
  for (const cp of config.custom_patterns) {
    if (!cp.pattern) continue;
    try {
      const re = new RegExp(cp.pattern, 'gi');
      result = result.replace(re, cp.replacement || '<FILTERED>');
    } catch {
      // Invalid regex — skip silently
    }
  }

  return result;
}

/**
 * Apply privacy filter to an event object prepared for LLM scoring.
 * Returns a new object with filtered fields.
 */
export function filterEventForLlm(
  event: { message: string; severity?: string; host?: string; source_ip?: string; program?: string },
  config: PrivacyFilterConfig,
): { message: string; severity?: string; host?: string; source_ip?: string; program?: string } {
  if (!config.llm_filter_enabled) return event;

  return {
    message: filterText(event.message, config),
    severity: event.severity,
    host: config.strip_host_field ? undefined : (event.host ? filterText(event.host, config) : event.host),
    source_ip: event.source_ip ? filterText(event.source_ip, config) : event.source_ip,
    program: config.strip_program_field ? undefined : (event.program ? filterText(event.program, config) : event.program),
  };
}

/**
 * Apply privacy filter to a meta-analysis event object.
 * Returns a new object with filtered message field.
 * Uses a generic to preserve the exact shape of the input object.
 */
export function filterMetaEventForLlm<T extends { message: string }>(
  event: T,
  config: PrivacyFilterConfig,
): T {
  if (!config.llm_filter_enabled) return event;

  return {
    ...event,
    message: filterText(event.message, config),
  };
}
