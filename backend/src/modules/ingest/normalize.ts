import { createHash } from 'node:crypto';
import type { IngestEntry, NormalizedEvent } from '../../types/index.js';

/** Pino/Bunyan numeric log levels → canonical severity names. */
const PINO_LEVEL_MAP: Record<number, string> = {
  10: 'debug', 20: 'debug', 30: 'info', 40: 'warning', 50: 'error', 60: 'critical',
};

/**
 * Try to parse a JSON message body and extract severity + human-readable message.
 * Handles Pino, Bunyan, Winston, and generic structured loggers.
 * Returns null if the message is not JSON or extraction fails.
 */
function tryParseJsonMessage(message: string): { severity?: string; message?: string } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;

    const result: { severity?: string; message?: string } = {};

    const levelVal = obj.level ?? obj.severity ?? obj.loglevel ?? obj.lvl;
    if (typeof levelVal === 'number') {
      result.severity = PINO_LEVEL_MAP[levelVal] ?? (levelVal <= 7 ? syslogSeverityToString(levelVal) : undefined);
    } else if (typeof levelVal === 'string' && levelVal.trim().length > 0) {
      const lower = levelVal.toLowerCase().trim();
      result.severity = SEVERITY_CANONICAL[lower] ?? lower;
    }

    const msgVal = obj.msg ?? obj.message ?? obj.text;
    if (typeof msgVal === 'string' && msgVal.trim().length > 0) {
      result.message = msgVal.trim();
    }

    return (result.severity || result.message) ? result : null;
  } catch {
    return null;
  }
}

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

  // Try to unpack JSON structured logs (Pino, Bunyan, Winston)
  const jsonParsed = tryParseJsonMessage(message);
  const effectiveMessage = jsonParsed?.message ?? message;

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

  // Step 5: JSON message body severity (Pino/Bunyan/Winston structured logs)
  if (severity === undefined && jsonParsed?.severity) {
    severity = jsonParsed.severity;
  }

  // Final normalization: convert numbers to names, lowercase strings,
  // and map aliases (err→error, warn→warning, etc.) to canonical forms.
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
      // Map aliases to canonical names (RFC 5424 preferred forms)
      severity = SEVERITY_CANONICAL[trimmed] ?? trimmed;
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
    'ident', 'pid',              // Syslog parser fields (ident → program via Fluent Bit filter)
    'mnemonic', 'seq',           // Cisco IOS syslog parser fields
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
  const enrichedSeverity = enrichSeverityFromContent(effectiveMessage.trim(), severity);

  // Clean source_ip: Fluent Bit's source_address_key produces transport
  // addresses like "udp://192.168.30.14:52502" or "tcp://10.0.0.1:44321".
  // Extract just the IP address.
  const rawSourceIp = stringField(entry, 'source_ip', 'fromhost_ip', 'fromhost-ip', 'ip', 'client_ip', 'src_ip');
  const source_ip = cleanTransportAddress(rawSourceIp);

  // Resolve host: apply multiple layers of cleaning:
  //   1. Try standard host fields
  //   2. Clean transport-address formats (tcp://..., udp://...)
  //   3. Validate that the result is a plausible hostname (not a misaligned
  //      timestamp from a Cisco/network device parser failure)
  //   4. Fall back to the clean source IP if all else fails
  const rawHost = stringField(entry, 'host', 'hostname', 'source');
  const cleanedHost = rawHost ? (cleanTransportAddress(rawHost) ?? rawHost) : undefined;
  const host = (cleanedHost && isPlausibleHost(cleanedHost)) ? cleanedHost : source_ip;

  return {
    timestamp,
    message: effectiveMessage.trim(),
    severity: enrichedSeverity ?? undefined,
    host,
    source_ip,
    service: stringField(entry, 'service', 'service_name', 'application'),
    facility: stringField(entry, 'facility', 'syslog_facility'),
    program: stringField(entry, 'program', 'ident', 'app_name', 'appname', 'mnemonic'),
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

// ── Timestamp corrections ────────────────────────────────────

/**
 * Apply a timezone offset correction to an ISO 8601 timestamp string.
 *
 * RFC 3164 syslog timestamps have NO timezone information.  Fluent Bit
 * interprets them in its container's local time.  If a source's actual
 * timezone differs, the stored timestamp is wrong by the delta.
 *
 * @param isoTimestamp  ISO 8601 string (e.g. "2026-02-17T03:14:58.000Z")
 * @param offsetMinutes Offset in minutes.  Positive = source is AHEAD of
 *                      Fluent Bit's TZ (we subtract); negative = BEHIND (we add).
 * @returns Corrected ISO 8601 string, or original if parsing fails.
 */
export function applyTimezoneOffset(isoTimestamp: string, offsetMinutes: number): string {
  if (!offsetMinutes) return isoTimestamp;
  try {
    const d = new Date(isoTimestamp);
    if (isNaN(d.getTime())) return isoTimestamp;
    d.setTime(d.getTime() - offsetMinutes * 60_000);
    return d.toISOString();
  } catch {
    return isoTimestamp;
  }
}

/**
 * Convert an RFC 3164 timestamp to UTC using a proper IANA timezone name.
 * 
 * Unlike `applyTimezoneOffset` (fixed offset), this handles DST transitions
 * correctly by computing the actual UTC offset at the event's local time.
 *
 * @param isoTimestamp  ISO 8601 string as parsed by Fluent Bit (in Fluent Bit's TZ)
 * @param tzName        IANA timezone identifier (e.g. "Europe/Chisinau", "America/New_York")
 * @param fluentBitTz   IANA timezone of the Fluent Bit container (default: "UTC")
 * @returns Corrected ISO 8601 string in UTC, or original if conversion fails.
 */
export function applyTimezoneByName(
  isoTimestamp: string,
  tzName: string,
  fluentBitTz: string = 'UTC',
): string {
  try {
    const d = new Date(isoTimestamp);
    if (isNaN(d.getTime())) return isoTimestamp;

    // Get the UTC offset (in minutes) for both the source TZ and Fluent Bit TZ
    // at the specific moment of the event.
    const sourceOffsetMin = getUtcOffsetMinutes(d, tzName);
    const fbOffsetMin = getUtcOffsetMinutes(d, fluentBitTz);

    if (sourceOffsetMin === null || fbOffsetMin === null) return isoTimestamp;

    // Fluent Bit interpreted the timestamp in its own TZ.
    // The real local time was in the source's TZ.
    // Correction = (source offset - FB offset) in minutes.
    const deltaMinutes = sourceOffsetMin - fbOffsetMin;
    if (deltaMinutes === 0) return isoTimestamp;

    d.setTime(d.getTime() - deltaMinutes * 60_000);
    return d.toISOString();
  } catch {
    return isoTimestamp;
  }
}

/**
 * Compute the UTC offset in minutes for a given IANA timezone at a specific instant.
 * Positive = ahead of UTC (e.g., +120 for EET, +180 for EEST).
 * Returns null if the timezone name is invalid.
 */
function getUtcOffsetMinutes(date: Date, tzName: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    const localDate = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));

    return Math.round((localDate.getTime() - date.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/**
 * Clamp a future timestamp to the current time if it exceeds the allowed drift.
 *
 * Prevents events with impossible future timestamps (from clock skew,
 * misconfigured devices, or timezone errors) from polluting the database.
 *
 * @param isoTimestamp       ISO 8601 string
 * @param maxDriftSeconds    Maximum allowed drift into the future (default 300 = 5 min)
 * @returns Object with the (possibly clamped) timestamp and a boolean flag.
 */
export function clampFutureTimestamp(
  isoTimestamp: string,
  maxDriftSeconds: number,
): { timestamp: string; clamped: boolean } {
  if (maxDriftSeconds <= 0) return { timestamp: isoTimestamp, clamped: false };
  try {
    const eventTime = new Date(isoTimestamp).getTime();
    if (isNaN(eventTime)) return { timestamp: isoTimestamp, clamped: false };
    const maxAllowed = Date.now() + maxDriftSeconds * 1000;
    if (eventTime > maxAllowed) {
      return { timestamp: new Date().toISOString(), clamped: true };
    }
    return { timestamp: isoTimestamp, clamped: false };
  } catch {
    return { timestamp: isoTimestamp, clamped: false };
  }
}

// ── Severity alias → canonical name mapping ──────────────────
// Maps common syslog severity aliases and application-level names
// to their canonical RFC 5424 forms. Applied during final normalization.
const SEVERITY_CANONICAL: Record<string, string> = {
  err:           'error',       // BSD syslog (RFC 3164)
  warn:          'warning',     // Common application shorthand
  crit:          'critical',    // BSD syslog (RFC 3164)
  emerg:         'emergency',   // BSD syslog (RFC 3164)
  informational: 'info',        // RFC 5424 long form
  information:   'info',        // .NET / Windows Event Log
  fatal:         'critical',    // Application-level (Java, Node.js, etc.)
  panic:         'emergency',   // Linux kernel / Go runtime
  trace:         'debug',       // Application-level (OpenTelemetry, etc.)
  verbose:       'debug',       // Application-level (.NET, NLog, etc.)
};

// ── helpers ──────────────────────────────────────────────────

function stringField(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = entry[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Extract a clean IP address from a transport address string.
 *
 * Fluent Bit's `source_address_key` produces values like:
 *   - "udp://192.168.30.14:52502"
 *   - "tcp://10.0.0.1:44321"
 *   - "unix:///var/run/syslog.sock"
 *   - "192.168.1.1"          (already clean)
 *   - "[::1]:5140"           (IPv6 with port)
 *   - "::1"                  (IPv6 without port)
 *
 * Returns just the IP address, or undefined if unparseable.
 */
export function cleanTransportAddress(raw: string | undefined): string | undefined {
  if (!raw || raw.length === 0) return undefined;

  let addr = raw.trim();

  // Strip protocol prefix (udp://, tcp://, unix://, etc.)
  const protoIdx = addr.indexOf('://');
  if (protoIdx >= 0) {
    addr = addr.substring(protoIdx + 3);
  }

  // Handle IPv6 in brackets: [::1]:12345 → ::1
  if (addr.startsWith('[')) {
    const bracketEnd = addr.indexOf(']');
    if (bracketEnd > 0) {
      addr = addr.substring(1, bracketEnd);
    }
    return addr.length > 0 ? addr : undefined;
  }

  // Handle IPv4 with port: 192.168.1.1:52502 → 192.168.1.1
  // Only strip if what follows the last colon is a pure numeric port.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon > 0) {
    const afterColon = addr.substring(lastColon + 1);
    if (/^\d{1,5}$/.test(afterColon)) {
      addr = addr.substring(0, lastColon);
    }
  }

  // Reject unix socket paths or other non-IP values
  if (addr.includes('/')) return undefined;

  return addr.length > 0 ? addr : undefined;
}

/**
 * Validate that a string looks like a plausible hostname or IP address.
 *
 * Rejects values that are clearly misaligned parser fields:
 *   - Timestamps: "13:28:05.323:", "2024-01-15T10:30:00Z", etc.
 *   - Bare numbers (port or sequence) without dots: "52502"
 *   - Empty / whitespace-only strings
 *
 * Accepts:
 *   - IPv4: "192.168.1.1"
 *   - IPv6: "::1", "fe80::1"
 *   - Hostnames: "pve", "switch-core-01", "fw.example.com"
 */
function isPlausibleHost(value: string): boolean {
  if (!value || value.trim().length === 0) return false;

  const v = value.trim();

  // Reject if it looks like a timestamp (HH:MM:SS with optional fractional seconds)
  if (/^\d{1,2}:\d{2}:\d{2}/.test(v)) return false;

  // Reject ISO 8601-like timestamps: 2024-01-15T10:30:00
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(v)) return false;

  // Reject bare numeric values (port numbers, sequence IDs)
  if (/^\d+$/.test(v)) return false;

  // Reject strings starting with colon-separated numbers that exceed 3 groups
  // (likely a timestamp or numeric sequence, not an IPv6 address or hostname)
  if (/^\d+:\d+:\d+:\d+/.test(v) && !v.includes('.')) return false;

  // Reject strings that are just punctuation or control chars
  if (/^[^a-zA-Z0-9]+$/.test(v)) return false;

  return true;
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
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
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
  // ── Notice ─────────────────────────────────────────
  {
    severity: 'notice',
    patterns: [
      /\blevel\s*[=:]\s*"?notice\b/i,
      /"(?:severity|level)"\s*:\s*"notice"/i,
      /\bNOTICE\s*[:\]|>]/,
    ],
  },
  // ── Info ────────────────────────────────────────────
  {
    severity: 'info',
    patterns: [
      /\blevel\s*[=:]\s*"?(?:info|informational)\b/i,
      /"(?:severity|level)"\s*:\s*"(?:info|informational)"/i,
      /\bINFO\s*[:\]|>]/,
      /"level"\s*:\s*30\b/,
    ],
  },
  // ── Debug ──────────────────────────────────────────
  {
    severity: 'debug',
    patterns: [
      /\blevel\s*[=:]\s*"?(?:debug|trace)\b/i,
      /"(?:severity|level)"\s*:\s*"(?:debug|trace)"/i,
      /\bDEBUG\s*[:\]|>]/,
      /\bTRACE\s*[:\]|>]/,
      /"level"\s*:\s*[12]0\b/,
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

  // Upgrade from header, or SET when header was absent (undefined)
  if (bestContentSeverity && (bestContentPriority < headerPriority || headerSeverity === undefined)) {
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
