/**
 * Multiline syslog reassembly module.
 *
 * PostgreSQL (and some other programs) emit multi-line log messages via syslog.
 * Because syslog is inherently single-line, each continuation is delivered as
 * a separate syslog message.  This module detects and merges related lines
 * into single events.
 *
 * Two independent detection methods are used:
 *
 * **Method 1 — `[N-M]` continuation headers** (syslog_sequence_numbers = on):
 *   [5-1] first part of the message
 *   [5-2] #011continuation...
 *   [5-3] #011continuation...
 *
 * **Method 2 — PID+timestamp grouping** (standard PostgreSQL log prefix):
 *   2026-02-17 01:14:58.777 EET [127949] user@db ERROR: ...
 *   2026-02-17 01:14:58.777 EET [127949] user@db DETAIL: ...
 *   2026-02-17 01:14:58.777 EET [127949] user@db STATEMENT: ...
 *
 * Both methods use **group-based** merging (not strict adjacency), so
 * interleaved entries from concurrent sessions or other programs do not
 * break reassembly.
 *
 * The module operates entirely within a single ingest batch (no cross-batch
 * state) and runs BEFORE normalisation.
 */

import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

// ── Types ────────────────────────────────────────────────────────

/** Minimal shape of an ingest entry before normalisation. */
interface RawEntry {
  message?: string;
  host?: string;
  program?: string;
  [key: string]: unknown;
}

// ── Shared helpers ───────────────────────────────────────────────

/** Type guard: is entry a usable RawEntry with a string message? */
function isValidEntry(e: unknown): e is RawEntry {
  return !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as any).message === 'string';
}

/**
 * Convert syslog octal escape `#011` (horizontal tab) to a real tab character.
 * Also handles `#012` (newline) which PostgreSQL occasionally emits.
 */
function decodeSyslogOctalEscapes(text: string): string {
  return text
    .replace(/#011/g, '\t')
    .replace(/#012/g, '\n');
}

// ═══════════════════════════════════════════════════════════════════
//  Method 1: [N-M] continuation headers (group-based)
// ═══════════════════════════════════════════════════════════════════

/** Parsed continuation metadata from a PostgreSQL syslog line. */
interface PgContinuationInfo {
  sessionLine: number;
  continuation: number;
  body: string;
}

/**
 * Matches the PostgreSQL syslog continuation header at the start of a message.
 * Format: `[<session_line>-<continuation>] <rest>`
 *
 * Examples:
 *   `[5-1] 2026-02-16 13:45:58.351 EET [116965] syslog_ai@...`
 *   `[5-2] #011    WITH window_max AS (`
 */
const PG_CONTINUATION_RE = /^\[(\d+)-(\d+)\]\s*/;

function parsePgContinuation(message: string): PgContinuationInfo | null {
  const m = PG_CONTINUATION_RE.exec(message);
  if (!m) return null;
  return {
    sessionLine: parseInt(m[1], 10),
    continuation: parseInt(m[2], 10),
    body: message.slice(m[0].length),
  };
}

/** Index entry for the [N-M] group map. */
interface NMIndexEntry {
  idx: number;           // original batch index
  entry: RawEntry;
  continuation: number;  // M in [N-M]
  body: string;          // message with [N-M] prefix stripped
}

/**
 * Group-based reassembly for [N-M] continuation headers.
 *
 * Pass 1: Index all [N-M] entries into groups keyed by (host, program, N).
 * Pass 2: For each head ([N-1]), collect continuations from the group sorted
 *          by M, merge, mark consumed.  Orphan continuations are emitted
 *          individually with the header stripped.
 *
 * @returns Set of consumed entry indices.
 */
function reassembleNM(entries: unknown[], result: (unknown | null)[]): Set<number> {
  const consumed = new Set<number>();
  const groups = new Map<string, NMIndexEntry[]>();

  // Pass 1: index
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isValidEntry(e)) continue;
    const parsed = parsePgContinuation(e.message!);
    if (!parsed) continue;

    const key = `${e.host ?? ''}\0${e.program ?? ''}\0${parsed.sessionLine}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push({ idx: i, entry: e, continuation: parsed.continuation, body: parsed.body });
  }

  // Pass 2: merge within each group
  for (const group of groups.values()) {
    // Sort by continuation index (stable — preserves insertion order for ties)
    group.sort((a, b) => a.continuation - b.continuation);

    // Find the head (continuation === 1)
    const headIdx = group.findIndex((g) => g.continuation === 1);
    if (headIdx < 0) {
      // No head found — emit all as orphans (stripped)
      for (const item of group) {
        result[item.idx] = { ...item.entry, message: decodeSyslogOctalEscapes(item.body) };
        consumed.add(item.idx);
      }
      continue;
    }

    const head = group[headIdx];
    const parts: string[] = [decodeSyslogOctalEscapes(head.body)];

    // Collect sequential continuations starting from 2
    let expectedNext = 2;
    for (let j = headIdx + 1; j < group.length; j++) {
      if (group[j].continuation === expectedNext) {
        parts.push(decodeSyslogOctalEscapes(group[j].body));
        consumed.add(group[j].idx);
        result[group[j].idx] = undefined; // mark as consumed so final assembly skips it
        expectedNext++;
      }
      // Non-sequential entries in the group are left as orphans
    }

    // Build merged entry at the head's position
    const mergedMessage = parts.join('\n');
    result[head.idx] = { ...head.entry, message: mergedMessage };
    consumed.add(head.idx);

    // Emit any remaining items in the group that were not consumed as orphans
    for (const item of group) {
      if (!consumed.has(item.idx)) {
        result[item.idx] = { ...item.entry, message: decodeSyslogOctalEscapes(item.body) };
        consumed.add(item.idx);
      }
    }
  }

  return consumed;
}

// ═══════════════════════════════════════════════════════════════════
//  Method 2: PID + Timestamp grouping (standard PostgreSQL log prefix)
// ═══════════════════════════════════════════════════════════════════

/**
 * PostgreSQL log line prefix regex.
 *
 * Matches the standard `log_line_prefix` format used by PostgreSQL when
 * logging to syslog or stderr:
 *
 *   2026-02-17 01:14:58.777 EET [127949] user@db ERROR:  message...
 *   2026-02-17 01:14:58.777 EET [127949] user@db DETAIL:  Failing row...
 *
 * Capture groups:
 *   1: timestamp second-level (e.g. "2026-02-17 01:14:58")
 *   2: PID (e.g. "127949")
 *   3: log level (e.g. "ERROR", "DETAIL", "STATEMENT")
 */
const PG_LOG_PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\.\d+\s+\w+\s+\[(\d+)\]\s+\S+\s+(ERROR|WARNING|LOG|FATAL|PANIC|DETAIL|HINT|CONTEXT|STATEMENT|QUERY):\s/;

/** Primary log levels that act as a group "head". */
const PG_HEAD_LEVELS = new Set(['ERROR', 'WARNING', 'LOG', 'FATAL', 'PANIC']);

/** Continuation log levels that get merged into a head. */
const PG_CONTINUATION_LEVELS = new Set(['DETAIL', 'HINT', 'CONTEXT', 'STATEMENT', 'QUERY']);

/**
 * Defined merge order for continuation types.
 * Lower value = appears first in the merged message.
 */
const PG_CONTINUATION_ORDER: Record<string, number> = {
  DETAIL: 1,
  HINT: 2,
  CONTEXT: 3,
  STATEMENT: 4,
  QUERY: 5,
};

interface PgLogPrefixInfo {
  timestampSecond: string;
  pid: string;
  level: string;
}

function parsePgLogPrefix(message: string): PgLogPrefixInfo | null {
  const m = PG_LOG_PREFIX_RE.exec(message);
  if (!m) return null;
  return {
    timestampSecond: m[1],
    pid: m[2],
    level: m[3],
  };
}

/** Index entry for the PID-based group map. */
interface PidIndexEntry {
  idx: number;
  entry: RawEntry;
  level: string;
  message: string;
}

/**
 * Group-based reassembly for PostgreSQL log prefix (PID + timestamp).
 *
 * Groups entries by (host, program, PID, timestamp_second).  Within each
 * group, head entries (ERROR, WARNING, LOG, FATAL, PANIC) absorb
 * continuation entries (DETAIL, HINT, CONTEXT, STATEMENT, QUERY).
 *
 * If a group has multiple heads (rare — concurrent errors in same PID at
 * same second), only the FIRST head absorbs continuations.
 *
 * @param entries     Full batch
 * @param result      Output array (indexed by original position)
 * @param nmConsumed  Indices already consumed by Method 1
 */
function reassemblePgLogPrefix(
  entries: unknown[],
  result: (unknown | null)[],
  nmConsumed: Set<number>,
): void {
  const groups = new Map<string, PidIndexEntry[]>();

  // Pass 1: index entries not already consumed by Method 1
  for (let i = 0; i < entries.length; i++) {
    if (nmConsumed.has(i)) continue;
    if (result[i] !== null) continue; // already placed by Method 1

    const e = entries[i];
    if (!isValidEntry(e)) continue;

    const parsed = parsePgLogPrefix(e.message!);
    if (!parsed) continue;

    const key = `${e.host ?? ''}\0${e.program ?? ''}\0${parsed.pid}\0${parsed.timestampSecond}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push({ idx: i, entry: e, level: parsed.level, message: e.message! });
  }

  // Pass 2: merge within each group
  for (const group of groups.values()) {
    // Find the first head entry
    const headItem = group.find((item) => PG_HEAD_LEVELS.has(item.level));
    if (!headItem) {
      // No head — leave all entries as-is (they'll be emitted in pass-through)
      continue;
    }

    // Collect continuation entries, sorted by defined order
    const continuations = group
      .filter((item) => item.idx !== headItem.idx && PG_CONTINUATION_LEVELS.has(item.level))
      .sort((a, b) => (PG_CONTINUATION_ORDER[a.level] ?? 99) - (PG_CONTINUATION_ORDER[b.level] ?? 99));

    if (continuations.length === 0) {
      // No continuations — leave the head as-is
      continue;
    }

    // Merge: head message + continuation messages (separated by newline)
    const parts = [headItem.message, ...continuations.map((c) => c.message)];
    const mergedMessage = parts.join('\n');

    result[headItem.idx] = { ...headItem.entry, message: mergedMessage };

    // Mark continuations as consumed (set to a sentinel that will be skipped)
    for (const cont of continuations) {
      result[cont.idx] = undefined; // sentinel: skip during final assembly
    }

    // If there are additional head entries in the same group (very rare),
    // leave them as standalone entries (result[idx] stays null → pass-through).
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Reassemble multiline syslog entries in a batch.
 *
 * Applies two independent detection methods:
 *   1. `[N-M]` continuation headers (group-based, handles interleaving)
 *   2. PID + timestamp grouping for standard PostgreSQL log prefix
 *
 * Entries that do not match any multiline pattern pass through unchanged.
 *
 * @param entries - Array of raw ingest entries (pre-normalisation).
 * @returns A new array with merged entries (length <= entries.length).
 */
export function reassembleMultilineEntries(entries: unknown[]): unknown[] {
  if (!entries || entries.length <= 1) return entries;

  // result[i] = null means "not yet placed, will use original entry"
  // result[i] = undefined means "consumed by a merge, skip"
  // result[i] = object means "placed (merged or orphan-stripped)"
  const result: (unknown | null | undefined)[] = new Array(entries.length).fill(null);

  // Method 1: [N-M] continuation headers
  const nmConsumed = reassembleNM(entries, result);

  // Method 2: PID + timestamp grouping (on remaining entries)
  reassemblePgLogPrefix(entries, result, nmConsumed);

  // Final assembly: collect results in original order
  const output: unknown[] = [];
  let mergedByNM = 0;
  let mergedByPid = 0;

  for (let i = 0; i < entries.length; i++) {
    if (result[i] === undefined) {
      // Consumed by a merge — skip
      continue;
    }
    if (result[i] !== null) {
      // Placed by Method 1 or Method 2
      output.push(result[i]);
      if (nmConsumed.has(i)) mergedByNM++;
      else mergedByPid++;
    } else {
      // Not matched by any method — pass through unchanged
      output.push(entries[i]);
    }
  }

  if (mergedByNM > 0 || mergedByPid > 0) {
    const delta = entries.length - output.length;
    if (delta > 0) {
      logger.debug(
        `[${localTimestamp()}] Multiline reassembly: ${entries.length} → ${output.length} entries ` +
        `(merged ${delta}: ${mergedByNM > 0 ? `[N-M]=${nmConsumed.size}` : ''}${mergedByNM > 0 && mergedByPid > 0 ? ', ' : ''}` +
        `${mergedByPid > 0 ? `PID-group=${mergedByPid}` : ''})`,
      );
    }
  }

  return output;
}
