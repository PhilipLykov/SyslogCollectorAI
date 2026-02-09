import { createHash } from 'node:crypto';
import type { IngestEntry, NormalizedEvent } from '../../types/index.js';

/**
 * Normalize a raw ingest entry into the internal event schema.
 * Supports common shapes: syslog-style, GELF, flat key-value.
 *
 * Returns null if the entry is invalid (missing message).
 */
export function normalizeEntry(entry: IngestEntry): NormalizedEvent | null {
  const message = entry.message ?? (entry as any).short_message ?? (entry as any).msg;
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

  // Severity: normalize from syslog numeric or string
  let severity = entry.severity ?? (entry as any).level ?? (entry as any).syslog_severity;
  if (typeof severity === 'number') {
    severity = syslogSeverityToString(severity);
  } else if (typeof severity === 'string') {
    severity = severity.toLowerCase();
  } else {
    // Boolean, object, array, etc. — ignore
    severity = undefined;
  }

  // Build known fields; everything else goes into raw
  const known = new Set([
    'timestamp', 'time', '@timestamp',
    'message', 'short_message', 'msg',
    'severity', 'level', 'syslog_severity',
    'host', 'hostname', 'source',
    'source_ip', 'fromhost_ip', 'fromhost-ip', 'ip', 'client_ip', 'src_ip',
    'service', 'service_name', 'application',
    'facility', 'syslog_facility',
    'program', 'app_name', 'appname',
    'trace_id', 'traceId',
    'span_id', 'spanId',
    'external_id', 'connector_id',
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

  return {
    timestamp,
    message: message.trim(),
    severity: severity ?? undefined,
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
