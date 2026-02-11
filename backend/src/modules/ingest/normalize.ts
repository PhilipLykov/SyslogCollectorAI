import { createHash } from 'node:crypto';
import type { IngestEntry, NormalizedEvent } from '../../types/index.js';

/**
 * Normalize a raw ingest entry into the internal event schema.
 * Supports common shapes: syslog-style, GELF, flat key-value.
 *
 * Returns null if the entry is invalid (missing message).
 */
export function normalizeEntry(entry: IngestEntry): NormalizedEvent | null {
  const message = entry.message ?? (entry as any).short_message ?? (entry as any).msg ?? (entry as any).body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return null;
  }

  // Resolve timestamp: try multiple common field names
  let timestamp = entry.timestamp ?? (entry as any).time ?? (entry as any)['@timestamp'];
  if (!timestamp) {
    timestamp = new Date().toISOString();
  } else if (typeof timestamp === 'number') {
    // Unix epoch: handle seconds, milliseconds, microseconds, nanoseconds
    if (timestamp > 1e18) {
      // Nanoseconds
      timestamp = new Date(timestamp / 1_000_000).toISOString();
    } else if (timestamp > 1e15) {
      // Microseconds
      timestamp = new Date(timestamp / 1_000).toISOString();
    } else if (timestamp > 1e12) {
      // Milliseconds
      timestamp = new Date(timestamp).toISOString();
    } else {
      // Seconds
      timestamp = new Date(timestamp * 1000).toISOString();
    }
  } else if (typeof timestamp === 'string') {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      timestamp = new Date().toISOString();
    } else {
      timestamp = d.toISOString();
    }
  } else {
    timestamp = new Date().toISOString();
  }

  // Severity: normalize from syslog numeric or string.
  //
  // Resolution order:
  //   1. Standard string fields: severity, level, syslog_severity, severity_text
  //   2. Standard numeric fields: severity, level (syslog 0-7)
  //   3. OTel severity_number (1-24)
  //   4. Syslog PRI (facility*8 + severity)

  /** Treat null, undefined, and empty/whitespace strings as "not set". */
  const nonEmptyString = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') { const t = v.trim(); return t.length > 0 ? t : undefined; }
    return undefined;
  };

  // Step 1: Try non-empty string values
  let severity: string | number | undefined =
    nonEmptyString(entry.severity) ??
    nonEmptyString((entry as any).level) ??
    nonEmptyString((entry as any).syslog_severity) ??
    nonEmptyString((entry as any).severity_text);

  // Step 2: If no string, check for numeric severity/level (syslog 0-7)
  if (severity === undefined) {
    const numCandidate = entry.severity ?? (entry as any).level;
    if (typeof numCandidate === 'number') {
      severity = numCandidate;
    }
  }

  // Step 3: OTel severity_number (1-24 scale, NOT syslog 0-7).
  // OTel levels: 1-4=TRACE, 5-8=DEBUG, 9-12=INFO, 13-16=WARN, 17-20=ERROR, 21-24=FATAL
  // Handles both numeric and string representations (e.g. 17 or "17").
  if (severity === undefined) {
    const raw = (entry as any).severity_number;
    if (raw !== undefined && raw !== null) {
      const otelSevNum = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(otelSevNum) && otelSevNum >= 1) {
        severity = otelSeverityNumberToString(otelSevNum);
      }
    }
  }

  // Step 4: Syslog PRI field — PRI = facility * 8 + severity (RFC 5424 / RFC 3164)
  if (severity === undefined) {
    const pri = (entry as any).pri;
    if (pri !== undefined && pri !== null) {
      const priNum = typeof pri === 'number' ? pri : Number(pri);
      if (Number.isFinite(priNum) && priNum >= 0) {
        severity = syslogSeverityToString(priNum % 8);
        // Also extract facility if not already set
        if (!entry.facility) {
          const facNum = Math.floor(priNum / 8);
          (entry as any).facility = syslogFacilityToString(facNum);
        }
      }
    }
  }

  // Final normalization: convert numbers to names, lowercase strings.
  // Also handle numeric strings like "7" (common with rsyslog omhttp / Fluent Bit).
  if (typeof severity === 'number') {
    severity = syslogSeverityToString(severity);
  } else if (typeof severity === 'string') {
    const trimmed = severity.toLowerCase().trim();
    if (trimmed.length === 0) {
      severity = undefined;
    } else if (/^\d+$/.test(trimmed)) {
      // Pure numeric string (e.g. "7") — treat as syslog severity number
      const num = Number(trimmed);
      severity = (num >= 0 && num <= 7) ? syslogSeverityToString(num) : trimmed;
    } else {
      severity = trimmed;
    }
  } else {
    severity = undefined;
  }

  // Build known fields; everything else goes into raw
  const known = new Set([
    'timestamp', 'time', '@timestamp',
    'message', 'short_message', 'msg', 'body',
    'severity', 'level', 'syslog_severity', 'severity_text', 'severity_number',
    'host', 'hostname', 'source',
    'source_ip', 'fromhost_ip', 'fromhost-ip', 'ip', 'client_ip', 'src_ip',
    'service', 'service_name', 'application',
    'facility', 'syslog_facility',
    'program', 'app_name', 'appname',
    'trace_id', 'traceId',
    'span_id', 'spanId',
    'external_id', 'connector_id',
    'pri', 'msgid', 'extradata', // Syslog RFC 5424 parsed fields (consumed above)
    'collector', 'collector_host', // Fluent Bit metadata fields
    'raw', // Connector adapters pass pre-built raw — don't nest it
  ]);

  // Collect unknown fields into extras
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!known.has(k) && v !== undefined) {
      extras[k] = v;
    }
  }

  // Merge: incoming raw (from connectors) + collected extras (from ingest API)
  const incomingRaw = entry.raw && typeof entry.raw === 'object' && !Array.isArray(entry.raw)
    ? (entry.raw as Record<string, unknown>)
    : undefined;
  const hasExtras = Object.keys(extras).length > 0;
  const mergedRaw = incomingRaw || hasExtras
    ? { ...(incomingRaw ?? {}), ...(hasExtras ? extras : {}) }
    : undefined;

  // Content-based severity enrichment: upgrade if message body
  // indicates a higher severity than the syslog header provided.
  const enrichedSeverity = enrichSeverityFromContent(message.trim(), severity);

  return {
    timestamp,
    message: message.trim(),
    severity: enrichedSeverity ?? undefined,
    host: stringField(entry, 'host', 'hostname', 'source'),
    source_ip: stringField(entry, 'source_ip', 'fromhost_ip', 'fromhost-ip', 'ip', 'client_ip', 'src_ip'),
    service: stringField(entry, 'service', 'service_name', 'application'),
    facility: stringField(entry, 'facility', 'syslog_facility'),
    program: stringField(entry, 'program', 'app_name', 'appname'),
    trace_id: stringField(entry, 'trace_id', 'traceId'),
    span_id: stringField(entry, 'span_id', 'spanId'),
    raw: mergedRaw,
    external_id: safeString(entry.external_id),
    connector_id: safeString(entry.connector_id),
  };
}

/**
 * Compute a normalized hash for dedup.
 * Uses null byte as separator to prevent delimiter-injection collisions.
 * Called AFTER redaction so the hash reflects the stored content.
 */
export function computeNormalizedHash(event: NormalizedEvent): string {
  const parts = [
    event.timestamp,
    event.message,
    event.host ?? '',
    event.source_ip ?? '',
    event.service ?? '',
    event.program ?? '',
    event.facility ?? '',
  ];
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

// ── helpers ──────────────────────────────────────────────────

function stringField(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = entry[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Safely coerce to string or return undefined. */
function safeString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function syslogSeverityToString(n: number): string {
  const map: Record<number, string> = {
    0: 'emergency', 1: 'alert', 2: 'critical', 3: 'error',
    4: 'warning', 5: 'notice', 6: 'info', 7: 'debug',
  };
  return map[n] ?? 'info';
}

/** Convert syslog facility numeric code to a human-readable name (RFC 5424). */
function syslogFacilityToString(n: number): string {
  const map: Record<number, string> = {
    0: 'kern', 1: 'user', 2: 'mail', 3: 'daemon',
    4: 'auth', 5: 'syslog', 6: 'lpr', 7: 'news',
    8: 'uucp', 9: 'cron', 10: 'authpriv', 11: 'ftp',
    12: 'ntp', 13: 'audit', 14: 'alert', 15: 'clock',
    16: 'local0', 17: 'local1', 18: 'local2', 19: 'local3',
    20: 'local4', 21: 'local5', 22: 'local6', 23: 'local7',
  };
  return map[n] ?? `facility${n}`;
}

/**
 * Convert an OpenTelemetry severity_number (1-24) to a syslog-compatible
 * severity string. OTel spec: https://opentelemetry.io/docs/specs/otel/logs/data-model/#severity-fields
 *
 *   1-4  = TRACE   → debug
 *   5-8  = DEBUG   → debug
 *   9-12 = INFO    → info
 *  13-16 = WARN    → warning
 *  17-20 = ERROR   → error
 *  21-24 = FATAL   → critical
 */
function otelSeverityNumberToString(n: number): string {
  if (n <= 4) return 'debug';    // TRACE, TRACE2, TRACE3, TRACE4
  if (n <= 8) return 'debug';    // DEBUG, DEBUG2, DEBUG3, DEBUG4
  if (n <= 12) return 'info';    // INFO, INFO2, INFO3, INFO4
  if (n <= 16) return 'warning'; // WARN, WARN2, WARN3, WARN4
  if (n <= 20) return 'error';   // ERROR, ERROR2, ERROR3, ERROR4
  return 'critical';             // FATAL, FATAL2, FATAL3, FATAL4
}

// ── Content-based severity enrichment ────────────────────────

/**
 * Severity priority (lower = more severe).  Matches RFC 5424.
 */
const SEVERITY_PRIORITY: Record<string, number> = {
  emergency: 0, emerg: 0,
  alert: 1,
  critical: 2, crit: 2,
  error: 3, err: 3,
  warning: 4, warn: 4,
  notice: 5,
  info: 6, informational: 6,
  debug: 7,
};

/**
 * Patterns that indicate a specific severity when found in the message body.
 * Ordered from most severe to least.  Each regex is tested case-insensitively.
 *
 * Categories of patterns:
 *  1. Structured log fields (key=value, key="value", JSON-like)
 *  2. Common log-line prefixes / tags
 *  3. Keyword heuristics (conservative — only strong signals)
 */
const CONTENT_SEVERITY_RULES: { severity: string; patterns: RegExp[] }[] = [
  // ── Emergency / Alert / Critical ────────────────────
  {
    severity: 'emergency',
    patterns: [
      /\blevel\s*[=:]\s*"?(?:emergency|emerg)\b/i,
      /\b(?:EMERGENCY|EMERG)\s*[:\]|]/,
    ],
  },
  {
    severity: 'alert',
    patterns: [
      /\blevel\s*[=:]\s*"?alert\b/i,
      /\bALERT\s*[:\]|]/,
    ],
  },
  {
    severity: 'critical',
    patterns: [
      /\blevel\s*[=:]\s*"?(?:critical|crit|fatal)\b/i,
      /\b(?:CRITICAL|CRIT|FATAL)\s*[:\]|]/,
      /\bpanic:/i,
      /\bkernel\s+panic\b/i,
      /\bout of memory\b/i,
    ],
  },
  // ── Error ───────────────────────────────────────────
  {
    severity: 'error',
    patterns: [
      // Structured: level=error, level="error", "level":"error"
      /\blevel\s*[=:]\s*"?(?:error|err)\b/i,
      // JSON-style: "severity":"error"
      /"(?:severity|level)"\s*:\s*"(?:error|err)"/i,
      // Log-line prefix:  ERROR: ..., [ERROR] ..., <error> ...
      /\bERROR\s*[:\]|>]/,
      // Common message-start pattern: "error: ..."
      // (only at word boundary + colon to avoid false positives)
      /\berror:/i,
      // Systemd / service failures
      /\bfailed with result\b/i,
      /\breturn(?:ed)? (?:non-zero|error|failure)\b/i,
      /\bsegmentation fault\b/i,
      /\bsegfault\b/i,
      /\bcore dumped\b/i,
      // Common exit-code failure patterns
      /\bexit(?:ed)?\s+(?:code|status)\s*[=:]?\s*[1-9]\d*/i,
    ],
  },
  // ── Warning ─────────────────────────────────────────
  {
    severity: 'warning',
    patterns: [
      /\blevel\s*[=:]\s*"?(?:warning|warn)\b/i,
      /"(?:severity|level)"\s*:\s*"(?:warning|warn)"/i,
      /\bWARN(?:ING)?\s*[:\]|>]/,
      /\bwarning:/i,
      // Deprecation warnings
      /\bdeprecated\b/i,
      // Restart / retry hints
      /\bwill not be restarted\b/i,
      /\bretry(?:ing)?\s+(?:in|after)\b/i,
      /\bShouldRestart failed\b/i,
    ],
  },
];

/**
 * Detect severity from message content and return the more severe
 * of (header severity, content severity).  Never downgrades.
 *
 * @param message  - The (trimmed) event message body.
 * @param headerSeverity - Severity from the syslog header (already lowercase), or undefined.
 * @returns The enriched severity string, or the original if no upgrade.
 */
function enrichSeverityFromContent(
  message: string,
  headerSeverity: string | undefined,
): string | undefined {
  const headerPriority = headerSeverity
    ? (SEVERITY_PRIORITY[headerSeverity] ?? 6)  // default to "info" if unknown
    : 7; // if no header severity, treat as lowest (debug)

  let bestContentPriority = Infinity;
  let bestContentSeverity: string | undefined;

  for (const rule of CONTENT_SEVERITY_RULES) {
    const rulePriority = SEVERITY_PRIORITY[rule.severity] ?? 6;
    // Skip if this rule can't beat what we already have
    if (rulePriority >= bestContentPriority) continue;

    for (const pattern of rule.patterns) {
      if (pattern.test(message)) {
        bestContentPriority = rulePriority;
        bestContentSeverity = rule.severity;
        break; // no need to test more patterns for this severity
      }
    }
  }

  // Only upgrade — never downgrade
  if (bestContentSeverity && bestContentPriority < headerPriority) {
    return bestContentSeverity;
  }

  return headerSeverity;
}

// ── ECS (Elastic Common Schema) field flattening ─────────────

/**
 * Default ECS → flat field mapping.
 * Nested ECS fields (e.g. from OpenTelemetry/Beats agents) are flattened
 * into the ingest API's flat namespace so that normalizeEntry can process them.
 */
const ECS_FLAT_MAP: Record<string, string> = {
  // ECS (Elastic Common Schema)
  'host.name': 'host',
  'host.hostname': 'host',
  'source.ip': 'source_ip',
  'source.address': 'source_ip',
  'service.name': 'service',
  'process.name': 'program',
  'log.level': 'severity',
  'log.syslog.facility.name': 'facility',
  'log.syslog.severity.name': 'severity',
  'trace.id': 'trace_id',
  'span.id': 'span_id',
  'event.original': 'message',
  '@timestamp': 'timestamp',

  // OpenTelemetry Semantic Conventions
  'resource.service.name': 'service',
  'resource.host.name': 'host',
  'attributes.severity_text': 'severity',
  'attributes.trace_id': 'trace_id',
  'attributes.span_id': 'span_id',
};

/**
 * Flatten nested ECS fields in an ingest entry into their flat equivalents.
 *
 * For example, `{ host: { name: "web-01" } }` becomes `{ host: "web-01" }`.
 * Only sets a flat field if it is not already populated (explicit values take priority).
 *
 * @param entry  The raw ingest entry (mutated in place).
 * @returns The same entry with flattened ECS fields.
 */
export function flattenECS(entry: Record<string, unknown>): Record<string, unknown> {
  for (const [ecsPath, flatKey] of Object.entries(ECS_FLAT_MAP)) {
    // Skip if the flat key is already set
    if (entry[flatKey] !== undefined && entry[flatKey] !== null && entry[flatKey] !== '') continue;

    const value = getNestedValue(entry, ecsPath);
    if (value !== undefined && value !== null && value !== '') {
      entry[flatKey] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }
  return entry;
}

/** Resolve a dot-notation path from a nested object. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
