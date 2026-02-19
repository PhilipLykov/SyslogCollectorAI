import { config, localTimestamp } from '../../config/index.js';
import type { NormalizedEvent } from '../../types/index.js';
import { logger } from '../../config/logger.js';

const REDACT_PLACEHOLDER = '***REDACTED***';

/**
 * Built-in redaction patterns (common secrets/passwords in logs).
 * Each regex is applied globally and case-insensitively.
 *
 * ORDERING MATTERS: quoted-value patterns MUST come before \S+ patterns,
 * otherwise \S+ consumes the opening quote and leaks the rest.
 */
const BUILTIN_PATTERNS: RegExp[] = [
  // === Quoted-value patterns first (higher specificity) ===
  /(?<=password\s*[=:]\s*)("[^"]*"|'[^']*')/gi,
  /(?<=secret\s*[=:]\s*)("[^"]*"|'[^']*')/gi,
  /(?<=api[_-]?key\s*[=:]\s*)("[^"]*"|'[^']*')/gi,
  /(?<=token\s*[=:]\s*)("[^"]*"|'[^']*')/gi,

  // === Key=value patterns (unquoted values) ===
  /(?<=password\s*[=:]\s*)\S+/gi,
  /(?<=passwd\s*[=:]\s*)\S+/gi,
  /(?<=secret\s*[=:]\s*)\S+/gi,
  /(?<=api[_-]?key\s*[=:]\s*)\S+/gi,
  /(?<=token\s*[=:]\s*)\S+/gi,
  /(?<=access[_-]?key\s*[=:]\s*)\S+/gi,
  /(?<=private[_-]?key\s*[=:]\s*)\S+/gi,
  /(?<=credentials?\s*[=:]\s*)\S+/gi,

  // === Authorization headers — redact entire value after "Authorization:" ===
  /(?<=Authorization\s*:\s*)\S+(\s+\S+)?/gi,
];

let _compiledPatterns: RegExp[] | null = null;

function getPatterns(): RegExp[] {
  if (_compiledPatterns) return _compiledPatterns;

  // Copy builtin patterns (don't share refs — each gets fresh lastIndex)
  _compiledPatterns = BUILTIN_PATTERNS.map((p) => new RegExp(p.source, p.flags));

  for (const p of config.redaction.extraPatterns) {
    const trimmed = p.trim();
    if (!trimmed) continue; // Skip empty patterns (e.g. from trailing commas in env)
    try {
      _compiledPatterns.push(new RegExp(trimmed, 'gi'));
    } catch {
      logger.warn(`[${localTimestamp()}] [redaction] Invalid extra pattern ignored: ${trimmed}`);
    }
  }

  return _compiledPatterns;
}

/** Invalidate the compiled patterns cache (e.g. after config change). */
export function invalidateRedactionCache(): void {
  _compiledPatterns = null;
}

/** Apply redaction patterns to a string, replacing matches with placeholder. */
function redactString(input: string): string {
  let result = input;

  // Handle connection strings specially (use capture groups, not lookbehind)
  // Recreate regex each call to avoid mutable lastIndex issues with /g
  result = result.replace(/:\/\/([^:]+:)[^@]+(@)/gi, `://$1${REDACT_PLACEHOLDER}$2`);

  for (const pattern of getPatterns()) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACT_PLACEHOLDER);
  }
  return result;
}

/**
 * Recursively redact string values in a JSON object.
 * Used for the `raw` field when redact_raw is enabled.
 */
function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
    'api-key', 'authorization', 'access_key', 'private_key', 'credential',
    'credentials', 'access_token', 'refresh_token', 'client_secret',
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = REDACT_PLACEHOLDER;
    } else if (typeof value === 'string') {
      result[key] = redactString(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') return redactString(item);
        if (item !== null && typeof item === 'object') return redactObject(item as Record<string, unknown>);
        return item;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redact secrets and passwords from a normalized event.
 * Only modifies message and raw — other fields are structured metadata.
 *
 * Pipeline placement: after normalization and source matching,
 * before computing normalized_hash and persist.
 *
 * OWASP A02 (sensitive log content), A09 (no sensitive data in logs).
 */
export function redactEvent(event: NormalizedEvent): NormalizedEvent {
  if (!config.redaction.enabled) return event;

  return {
    ...event,
    message: redactString(event.message),
    raw: event.raw ? redactObject(event.raw) : undefined,
  };
}
