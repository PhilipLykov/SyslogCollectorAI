/**
 * Multiline syslog reassembly module.
 *
 * PostgreSQL (and some other programs) emit multi-line log messages via syslog.
 * Because syslog is inherently single-line, each continuation is delivered as
 * a separate syslog message.  This module detects and merges related lines
 * into single events.
 *
 * Four independent detection methods are used:
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
 * **Method 3 — Generic fragment detection** (same host + program + second):
 *   Merges lines that look like continuations (key:value, stack traces,
 *   braces) into the nearest head line within the same batch.
 *
 * **Method 4 — Cross-batch fragment buffer** (handles split flushes):
 *   Orphan fragments with no head in the current batch are held in an
 *   in-memory buffer.  When a matching head arrives in a subsequent batch,
 *   the fragments are merged.  Expired fragments are released as standalone
 *   events (no data loss).
 *
 * Methods 1–3 use **group-based** merging (not strict adjacency), so
 * interleaved entries from concurrent sessions or other programs do not
 * break reassembly.
 *
 * The module runs BEFORE normalisation.
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
      // No head found — consolidate all orphans into ONE merged event
      // (group is already sorted by continuation on line 140)
      const parts = group.map(item => decodeSyslogOctalEscapes(item.body));
      const first = group[0];
      result[first.idx] = { ...first.entry, message: parts.join('\n') };
      consumed.add(first.idx);
      for (let k = 1; k < group.length; k++) {
        result[group[k].idx] = undefined;
        consumed.add(group[k].idx);
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
//  Method 3: Generic fragment detection (same-second grouping)
// ═══════════════════════════════════════════════════════════════════

/**
 * Regex matching lines that look like a log "head" — they start with a
 * recognisable log-level marker or timestamp prefix, indicating the start
 * of a new logical message.
 */
const GENERIC_HEAD_RE =
  /^\s*(\[?(ERROR|WARN|WARNING|INFO|NOTICE|DEBUG|FATAL|PANIC|CRITICAL|TRACE|ALERT|EMERG)\]?\s*[:\-–—⚠❌ ]|(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})\s)/i;

/** Max lines per merged message (prevent runaway merges). */
const MAX_FRAGMENT_MERGE = 20;

/**
 * Extract a second-level timestamp key from a raw entry.
 * Looks at the `timestamp` or `@timestamp` field and truncates to seconds.
 * Returns null if no usable timestamp is found.
 */
function extractTimestampSecond(e: RawEntry): string | null {
  const raw = (e as any).timestamp ?? (e as any)['@timestamp'];
  if (!raw || typeof raw !== 'string') return null;
  // ISO 8601: "2026-02-19T23:58:14.123Z" → "2026-02-19T23:58:14"
  // Syslog:   "Feb 19 23:58:14" → "Feb 19 23:58:14"
  // Truncate to second-level by dropping sub-second and everything after
  const isoMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(raw);
  if (isoMatch) return isoMatch[1];
  // Syslog-style "Mon DD HH:MM:SS" — already second-level
  const syslogMatch = /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/.exec(raw);
  if (syslogMatch) return syslogMatch[1];
  return raw.slice(0, 19); // fallback: first 19 chars
}

/**
 * Returns true if a message looks like a continuation fragment rather
 * than the start of a new log entry.
 *
 * Detection patterns (checked after GENERIC_HEAD_RE excludes known heads):
 *   1. Indented lines (leading whitespace)
 *   2. Structure continuation chars: { } ) , ] :
 *   3. JS/Java stack trace lines ("at ...")
 *   4. Elided stack frames ("... N lines matching ...")
 *   5. Short key: value lines (schema: undefined, params: 1)
 *   6. Quoted data-structure elements ('foo' ], "key": value, etc.)
 *   7. Lines ending with trailing comma (short)
 *   8. List/diff/separator prefixes (# - + ~ | *)
 */
function isFragment(message: string): boolean {
  if (GENERIC_HEAD_RE.test(message)) return false;

  if (/^\s+/.test(message)) return true;                       // indented
  if (/^[{}),\]:]/.test(message)) return true;                 // structure continuation
  if (/^at\s+/.test(message)) return true;                     // JS/Java stack trace
  if (/^\.\.\.\s*\d+\s+/.test(message)) return true;           // "... 4 lines matching ..."
  if (/^[a-zA-Z_]+:\s/.test(message) && message.length < 80) { // short key: value lines
    return true;
  }

  const trimmed = message.trimEnd();

  // Quoted data-structure elements: lines starting with ' or " that end
  // with a structure character (comma, bracket, brace, paren).
  // Catches: 'paxcounter' ], "enabled": true, 'device', 'position',
  if (/^['"]/.test(message) && /[,\]}\)]\s*$/.test(trimmed)) return true;

  // Quoted key-value notation: "key": value  or  'key': value
  // Catches: "password": "*28KwP...", 'enabled': true
  if (/^['"][^'"]{1,60}['"]\s*:/.test(message)) return true;

  // Short lines ending with trailing comma — data-structure elements
  // where leading whitespace was stripped (e.g. by Fluent Bit Lua cleanup).
  // Catches: true,  null,  42,  someValue,
  if (trimmed.length < 60 && /,\s*$/.test(trimmed)) return true;

  // List items, diff hunks, separators (never standalone log entries)
  if (/^[-+~|*#]\s/.test(message) && message.length < 200) return true;

  return false;
}

/** Index entry for the generic fragment group map. */
interface GenericGroupEntry {
  idx: number;
  entry: RawEntry;
  message: string;
  isHead: boolean;
}

/**
 * Generic fragment reassembly.
 *
 * Groups remaining (unprocessed) entries by (host, program, timestamp_second).
 * Within each group, "head" lines absorb subsequent "fragment" lines.
 *
 * @param entries     Full batch
 * @param result      Output array (indexed by original position)
 * @param consumed    Indices already consumed by Methods 1 & 2
 */
function reassembleGenericFragments(
  entries: unknown[],
  result: (unknown | null | undefined)[],
  consumed: Set<number>,
): number {
  const groups = new Map<string, GenericGroupEntry[]>();

  // Pass 1: index unprocessed entries
  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(i)) continue;
    if (result[i] !== null) continue; // already placed by earlier methods

    const e = entries[i];
    if (!isValidEntry(e)) continue;

    const ts = extractTimestampSecond(e);
    if (!ts) continue;

    const key = `${e.host ?? ''}\0${e.program ?? ''}\0${ts}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push({
      idx: i,
      entry: e,
      message: e.message!,
      isHead: !isFragment(e.message!),
    });
  }

  // Pass 2: merge fragments into heads
  let mergedCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue; // nothing to merge

    // Identify heads and fragments
    const heads = group.filter((g) => g.isHead);
    if (heads.length === 0) continue; // no heads — leave all as-is

    // For each head, collect following fragments up to the next head
    for (let h = 0; h < heads.length; h++) {
      const head = heads[h];
      const headGroupIdx = group.indexOf(head);
      const nextHeadGroupIdx = h + 1 < heads.length
        ? group.indexOf(heads[h + 1])
        : group.length;

      const fragments: GenericGroupEntry[] = [];
      for (let f = headGroupIdx + 1; f < nextHeadGroupIdx && fragments.length < MAX_FRAGMENT_MERGE - 1; f++) {
        if (!group[f].isHead) {
          fragments.push(group[f]);
        }
      }

      if (fragments.length === 0) continue;

      // Merge: head message + fragment messages
      const parts = [head.message, ...fragments.map((f) => f.message)];
      const mergedMessage = parts.join('\n');

      result[head.idx] = { ...head.entry, message: mergedMessage };
      consumed.add(head.idx);

      for (const frag of fragments) {
        result[frag.idx] = undefined; // consumed
        consumed.add(frag.idx);
        mergedCount++;
      }
    }

    // Fragments before the first head — merge into the first head
    if (heads.length > 0) {
      const firstHead = heads[0];
      const firstHeadGroupIdx = group.indexOf(firstHead);
      const orphansBefore: GenericGroupEntry[] = [];
      for (let f = 0; f < firstHeadGroupIdx && orphansBefore.length < MAX_FRAGMENT_MERGE - 1; f++) {
        if (!group[f].isHead && !consumed.has(group[f].idx)) {
          orphansBefore.push(group[f]);
        }
      }
      if (orphansBefore.length > 0) {
        // Prepend orphans to the head's (already merged) message
        const currentMsg = result[firstHead.idx]
          ? (result[firstHead.idx] as RawEntry).message ?? firstHead.message
          : firstHead.message;
        const preParts = [...orphansBefore.map((o) => o.message), currentMsg];
        const entry = result[firstHead.idx] ?? firstHead.entry;
        result[firstHead.idx] = { ...(entry as RawEntry), message: preParts.join('\n') };
        consumed.add(firstHead.idx);
        for (const orphan of orphansBefore) {
          result[orphan.idx] = undefined;
          consumed.add(orphan.idx);
          mergedCount++;
        }
      }
    }
  }

  return mergedCount;
}

// ═══════════════════════════════════════════════════════════════════
//  Method 4: Cross-batch fragment buffer
// ═══════════════════════════════════════════════════════════════════
//
//  When log shippers (Fluent Bit, rsyslog) flush at a 1-second interval,
//  a single multi-line error dump can span two flushes. The head line
//  arrives in batch N and is ingested normally. The property/continuation
//  lines arrive in batch N+1 with no head to merge into.
//
//  This in-memory buffer holds orphan fragments briefly so they can be
//  merged with a matching head in a subsequent batch.
//
//  Performance characteristics (enterprise-safe):
//    - O(1) Map lookup per host+program pair
//    - Bounded memory: max BUFFER_MAX_KEYS groups, max BUFFER_MAX_PER_KEY
//      fragments per group ≈ 5 MB worst case
//    - Lazy purge on each batch (no background timer / extra goroutine)
//    - Fully synchronous (no async overhead)
//    - Node.js single-threaded: no locking required
// ═══════════════════════════════════════════════════════════════════

const BUFFER_TTL_MS = 10_000;               // hold fragments max 10 seconds
const BUFFER_MAX_KEYS = 500;                 // max distinct host+program groups
const BUFFER_MAX_PER_KEY = 30;               // max fragments per group
const BUFFER_TIMESTAMP_WINDOW_MS = 5_000;    // ±5 s for head–fragment matching

interface OrphanFragment {
  entry: RawEntry;
  message: string;
  timestampMs: number;
  bufferedAt: number;
}

const _fragmentBuffer = new Map<string, OrphanFragment[]>();

function hostProgKey(e: RawEntry): string {
  return `${e.host ?? ''}\0${e.program ?? ''}`;
}

function parseTimestampMs(e: RawEntry): number | null {
  const raw = (e as any).timestamp ?? (e as any)['@timestamp'];
  if (!raw) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function purgeExpiredFragments(now: number): RawEntry[] {
  const expired: RawEntry[] = [];
  for (const [key, frags] of _fragmentBuffer) {
    const keep: OrphanFragment[] = [];
    for (const f of frags) {
      if (now - f.bufferedAt > BUFFER_TTL_MS) {
        expired.push(f.entry);
      } else {
        keep.push(f);
      }
    }
    if (keep.length === 0) {
      _fragmentBuffer.delete(key);
    } else if (keep.length !== frags.length) {
      _fragmentBuffer.set(key, keep);
    }
  }
  return expired;
}

function tryMergeFromBuffer(head: RawEntry): RawEntry | null {
  const ts = parseTimestampMs(head);
  if (ts === null) return null;

  const key = hostProgKey(head);
  const frags = _fragmentBuffer.get(key);
  if (!frags || frags.length === 0) return null;

  const matching: number[] = [];
  for (let i = 0; i < frags.length; i++) {
    if (Math.abs(frags[i].timestampMs - ts) <= BUFFER_TIMESTAMP_WINDOW_MS) {
      matching.push(i);
    }
  }
  if (matching.length === 0) return null;

  matching.sort((a, b) => frags[a].timestampMs - frags[b].timestampMs);

  const mergedMsg = head.message! + '\n' +
    matching.map(i => frags[i].message).join('\n');

  for (let i = matching.length - 1; i >= 0; i--) {
    frags.splice(matching[i], 1);
  }
  if (frags.length === 0) _fragmentBuffer.delete(key);

  return { ...head, message: mergedMsg };
}

function bufferOrphanFragment(entry: RawEntry, now: number): boolean {
  const ts = parseTimestampMs(entry);
  if (ts === null) return false;

  const key = hostProgKey(entry);

  let frags = _fragmentBuffer.get(key);
  if (!frags) {
    if (_fragmentBuffer.size >= BUFFER_MAX_KEYS) {
      const oldestKey = _fragmentBuffer.keys().next().value;
      if (oldestKey !== undefined) _fragmentBuffer.delete(oldestKey);
    }
    frags = [];
    _fragmentBuffer.set(key, frags);
  }

  if (frags.length >= BUFFER_MAX_PER_KEY) return false;

  frags.push({
    entry: { ...entry },
    message: entry.message!,
    timestampMs: ts,
    bufferedAt: now,
  });
  return true;
}

/** Exposed for testing. */
export function _resetFragmentBuffer(): void {
  _fragmentBuffer.clear();
}

// ═══════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Reassemble multiline syslog entries in a batch.
 *
 * Applies four independent detection methods:
 *   1. `[N-M]` continuation headers (group-based, handles interleaving)
 *   2. PID + timestamp grouping for standard PostgreSQL log prefix
 *   3. Generic fragment detection (same host + program + second)
 *   4. Cross-batch fragment buffer (holds orphans for next batch)
 *
 * Entries that do not match any multiline pattern pass through unchanged.
 *
 * @param entries - Array of raw ingest entries (pre-normalisation).
 * @returns A new array with merged entries (length <= entries.length).
 */
export function reassembleMultilineEntries(entries: unknown[]): unknown[] {
  const now = Date.now();

  // Flush expired buffer fragments → they re-enter the pipeline as standalone
  const expiredFragments = purgeExpiredFragments(now);

  if ((!entries || entries.length === 0) && expiredFragments.length === 0) {
    return entries ?? [];
  }

  const safeEntries = entries ?? [];

  // result[i] = null means "not yet placed, will use original entry"
  // result[i] = undefined means "consumed by a merge, skip"
  // result[i] = object means "placed (merged or orphan-stripped)"
  const result: (unknown | null | undefined)[] = new Array(safeEntries.length).fill(null);

  if (safeEntries.length > 1) {
    // Method 1: [N-M] continuation headers
    const nmConsumed = reassembleNM(safeEntries, result);

    // Method 2: PID + timestamp grouping (on remaining entries)
    reassemblePgLogPrefix(safeEntries, result, nmConsumed);

    // Method 3: Generic fragment detection (on remaining entries)
    const allConsumed = new Set(nmConsumed);
    for (let i = 0; i < result.length; i++) {
      if (result[i] !== null && result[i] !== undefined) allConsumed.add(i);
      if (result[i] === undefined) allConsumed.add(i);
    }
    reassembleGenericFragments(safeEntries, result, allConsumed);
  }

  // Method 4: Cross-batch buffer — merge buffered fragments into heads,
  // buffer new orphan fragments, and release expired ones.
  const output: unknown[] = [];
  let mergedFromBuffer = 0;
  let newlyBuffered = 0;

  // 4a. Release expired fragments as standalone events
  for (const ef of expiredFragments) {
    output.push(ef);
  }

  // 4b. Process current batch entries
  for (let i = 0; i < safeEntries.length; i++) {
    if (result[i] === undefined) continue;

    const entry = result[i] ?? safeEntries[i];
    if (!isValidEntry(entry)) {
      output.push(entry);
      continue;
    }

    const re = entry as RawEntry;
    const msg = re.message!;
    const wasProcessedByMethod = result[i] !== null;

    if (wasProcessedByMethod || !isFragment(msg)) {
      // Head or already-merged entry — check buffer for matching fragments
      const merged = tryMergeFromBuffer(re);
      if (merged) {
        output.push(merged);
        mergedFromBuffer++;
      } else {
        output.push(entry);
      }
    } else {
      // Unprocessed fragment — buffer it instead of ingesting
      if (bufferOrphanFragment(re, now)) {
        newlyBuffered++;
      } else {
        // Buffer full — pass through as standalone
        output.push(entry);
      }
    }
  }

  // Logging
  const totalChanges = expiredFragments.length + mergedFromBuffer + newlyBuffered;
  if (totalChanges > 0) {
    const parts: string[] = [];
    if (mergedFromBuffer > 0) parts.push(`cross-batch-merged=${mergedFromBuffer}`);
    if (newlyBuffered > 0) parts.push(`buffered=${newlyBuffered}`);
    if (expiredFragments.length > 0) parts.push(`expired-released=${expiredFragments.length}`);
    logger.debug(
      `[${localTimestamp()}] Multiline cross-batch: ${parts.join(', ')} (buffer size=${_fragmentBuffer.size} keys)`,
    );
  }

  if (safeEntries.length > output.length) {
    logger.debug(
      `[${localTimestamp()}] Multiline reassembly: ${safeEntries.length} → ${output.length} entries ` +
      `(reduced ${safeEntries.length - output.length})`,
    );
  }

  return output;
}
