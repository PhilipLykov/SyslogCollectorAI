import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

/**
 * Normal Behavior Templates — regex pattern generation, matching, and loading.
 *
 * Users mark events as "normal behavior," which generates a context-aware
 * regex pattern.  Future events matching the pattern (and optional host /
 * program filters) are excluded from LLM scoring and meta-analysis,
 * reducing noise and saving tokens.
 *
 * Patterns are stored as full regex strings (anchored with ^ … $) so
 * users can express precise match conditions (e.g., `\d{1,3}` for a
 * number vs `.*` for "anything").
 */

// ── Types ────────────────────────────────────────────────────

export interface NormalBehaviorTemplate {
  id: string;
  system_id: string | null;
  pattern: string;
  pattern_regex: string;
  host_pattern: string | null;
  program_pattern: string | null;
  original_message: string;
  original_event_id: string | null;
  created_by: string;
  created_at: string;
  enabled: boolean;
  notes: string | null;
}

/** Template with pre-compiled RegExp for efficient matching. */
interface CompiledTemplate extends NormalBehaviorTemplate {
  _compiledRegex: RegExp;
  _compiledHostRegex: RegExp | null;
  _compiledProgramRegex: RegExp | null;
}

/** Result returned by generateNormalPattern. */
export interface GeneratedPattern {
  pattern: string;
  host_pattern: string | null;
  program_pattern: string | null;
}

// ── Regex Helpers ────────────────────────────────────────────

/**
 * Escape regex special characters in a literal string segment.
 *
 * Characters escaped (special in POSIX ERE / JavaScript / PostgreSQL ARE):
 *   . * + ? ^ $ { } ( ) | [ ] \  /
 *
 * `/` is not syntactically special in POSIX or JS `new RegExp()`, but we
 * escape it for safety and consistency (e.g. forward-compat, readability).
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// ── Context-Aware Regex Generation ───────────────────────────

/**
 * Replacement rules applied in order.  Each rule has a detection regex
 * and a replacement regex string.  The detection regex captures the
 * variable part of the message; it is replaced with the targeted regex
 * pattern that matches similar values without being overly broad.
 *
 * Order matters: more specific patterns (UUIDs, MACs, IPs) must run
 * before the generic "standalone numbers" rule.
 */
const REPLACEMENT_RULES: Array<{ detect: RegExp; replacement: string; tag: string }> = [
  // UUIDs (8-4-4-4-12 hex)
  {
    detect: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    tag: 'UUID',
  },
  // MAC addresses (colon/dash separated)
  {
    detect: /\b[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}\b/gi,
    replacement: '[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}',
    tag: 'MAC',
  },
  // MAC addresses (Cisco dot notation aabb.ccdd.eeff)
  {
    detect: /\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi,
    replacement: '[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}',
    tag: 'MAC_DOT',
  },
  // IPv4 addresses with optional CIDR
  {
    detect: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/g,
    replacement: '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?:\\/\\d{1,2})?',
    tag: 'IPv4',
  },
  // IPv6 addresses (simplified)
  {
    detect: /\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2,7}\b/gi,
    replacement: '[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7}',
    tag: 'IPv6',
  },
  // Network interface names (Cisco/HP/Juniper long form)
  {
    detect: /\b(?:(?:Ten)?(?:Hundred)?(?:Gigabit)?(?:Fast)?Ethernet|Gi|Fa|Te|Hu|Eth|eth|ens|em|enp\d+s)\d+(?:\/\d+)*/gi,
    replacement: '(?:(?:Ten)?(?:Hundred)?(?:Gigabit)?(?:Fast)?Ethernet|Gi|Fa|Te|Hu|Eth|eth|ens|em|enp\\d+s)\\S+',
    tag: 'IFACE',
  },
  // Network interface names (Port-channel, Vlan, Loopback, etc.)
  {
    detect: /\b(?:Port-channel|Po|po|Vlan|vlan|Loopback|Lo|Tunnel|Tu|BVI|bvi|mgmt|Mgmt)\d+\b/gi,
    replacement: '(?:Port-channel|Po|po|Vlan|vlan|Loopback|Lo|Tunnel|Tu|BVI|bvi|mgmt|Mgmt)\\d+',
    tag: 'IFACE2',
  },
  // "Switch N", "Stack N", "Unit N", "Slot N", "Module N"
  {
    detect: /\b(?:Switch|Stack|Unit|Slot|Module|Member|Node)\s+\d+\b/gi,
    replacement: '(?:Switch|Stack|Unit|Slot|Module|Member|Node)\\s+\\d+',
    tag: 'DEVICE_ID',
  },
  // MST/STP instance identifiers
  {
    detect: /\b(?:MST|MSTI|STP)\d+\b/gi,
    replacement: '(?:MST|MSTI|STP)\\d+',
    tag: 'STP_ID',
  },
  // Hex strings (0x-prefixed 4+ chars)
  {
    detect: /\b0x[0-9a-f]{4,}\b/gi,
    replacement: '0x[0-9a-f]+',
    tag: 'HEX',
  },
  // Long standalone hex strings (16+ chars, e.g. session tokens)
  {
    detect: /\b[0-9a-f]{16,}\b/gi,
    replacement: '[0-9a-f]+',
    tag: 'HEX_LONG',
  },
  // File/directory paths (2+ segments)
  {
    detect: /(?:\/[\w.+-]+){2,}/g,
    replacement: '(?:\\/[\\w.+-]+)+',
    tag: 'PATH',
  },
  // Double-quoted strings
  {
    detect: /"[^"]*"/g,
    replacement: '"[^"]*"',
    tag: 'DQUOTE',
  },
  // Single-quoted strings
  {
    detect: /'[^']*'/g,
    replacement: "'[^']*'",
    tag: 'SQUOTE',
  },
  // Numeric suffix after underscore (e.g., disk_03, cpu_0, port_8080)
  // Must come before NUM — these aren't caught by \b\d+\b because
  // underscore is a word character (no boundary between _ and 0).
  {
    detect: /_\d+\b/g,
    replacement: '_\\d+',
    tag: 'UNDERSCORE_NUM',
  },
  // Standalone numbers (not inside words) — must be last
  {
    detect: /\b\d+\b/g,
    replacement: '\\d+',
    tag: 'NUM',
  },
];

/**
 * Generate a context-aware regex pattern from a raw event message.
 *
 * Instead of the old wildcard `*` approach, this function:
 * 1. Scans the message for known variable parts (IPs, UUIDs, numbers, …)
 * 2. Replaces each with a targeted regex character class
 * 3. Escapes all remaining literal text
 * 4. Wraps the result in `^ … $` anchors (case-insensitive matching)
 *
 * Optionally generates host_pattern and program_pattern from event metadata.
 */
export function generateNormalPattern(
  message: string,
  host?: string | null,
  program?: string | null,
): GeneratedPattern {
  // ── Build message regex ──────────────────────────────────
  //
  // Strategy: tokenise the message into "literal" and "placeholder" segments.
  // We process replacement rules in order, using sentinel tokens (\x00N\x00)
  // to protect already-replaced regions from further modification.

  interface Token { type: 'literal' | 'placeholder'; value: string }
  let tokens: Token[] = [{ type: 'literal', value: message }];

  for (const rule of REPLACEMENT_RULES) {
    const next: Token[] = [];
    for (const tok of tokens) {
      if (tok.type !== 'literal') {
        next.push(tok);
        continue;
      }
      // Split this literal on the detection regex
      let lastIndex = 0;
      const text = tok.value;
      // Reset regex lastIndex for global patterns
      rule.detect.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.detect.exec(text)) !== null) {
        if (match.index > lastIndex) {
          next.push({ type: 'literal', value: text.slice(lastIndex, match.index) });
        }
        next.push({ type: 'placeholder', value: rule.replacement });
        lastIndex = match.index + match[0].length;
        // Guard against zero-length matches
        if (match[0].length === 0) { rule.detect.lastIndex++; }
      }
      if (lastIndex < text.length) {
        next.push({ type: 'literal', value: text.slice(lastIndex) });
      }
    }
    tokens = next;
  }

  // Assemble final regex string
  const regexParts = tokens.map((tok) =>
    tok.type === 'literal' ? escapeRegex(tok.value) : tok.value,
  );
  const pattern = `^${regexParts.join('')}$`;

  // ── Host / program patterns ──────────────────────────────
  const host_pattern = host ? `^${escapeRegex(host)}$` : null;
  const program_pattern = program ? `^${escapeRegex(program)}$` : null;

  return { pattern, host_pattern, program_pattern };
}

// ── Legacy Support ───────────────────────────────────────────

/**
 * Convert a legacy wildcard pattern (using `*`) to a regex string.
 * Kept for backward compatibility with any code that still sends
 * wildcard-style patterns from the UI.
 *
 * @deprecated — patterns are now stored as regex directly.
 */
export function patternToRegex(pattern: string): string {
  const segments = pattern.split('*');
  const escaped = segments.map(escapeRegex);
  return `^${escaped.join('.*')}$`;
}

/**
 * Detect whether a pattern string is a legacy wildcard pattern (contains
 * `*` but no regex anchors) vs a modern regex pattern.
 */
export function isLegacyWildcardPattern(pattern: string): boolean {
  return pattern.includes('*') && !pattern.startsWith('^');
}

/**
 * Ensure a pattern is in regex format.  Converts legacy wildcards if needed.
 */
export function ensureRegexPattern(pattern: string): string {
  if (isLegacyWildcardPattern(pattern)) {
    return patternToRegex(pattern);
  }
  return pattern;
}

// ── Matching ─────────────────────────────────────────────────

/** Safely compile a regex string, returning null on failure. */
function safeCompileRegex(source: string, label: string, templateId: string): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    logger.error(
      `[${localTimestamp()}] Invalid ${label} regex in normal_behavior_template ${templateId}: ${source}`,
    );
    return null;
  }
}

/** Compile a template's regexes once for efficient repeated matching. */
function compileTemplate(template: NormalBehaviorTemplate): CompiledTemplate {
  const messageRegex = safeCompileRegex(template.pattern_regex, 'message', template.id);
  return {
    ...template,
    _compiledRegex: messageRegex ?? /(?!)/, // never-match fallback
    _compiledHostRegex: template.host_pattern
      ? safeCompileRegex(template.host_pattern, 'host', template.id)
      : null,
    _compiledProgramRegex: template.program_pattern
      ? safeCompileRegex(template.program_pattern, 'program', template.id)
      : null,
  };
}

/**
 * Check if an event matches any active normal-behavior template.
 * Uses pre-compiled regex patterns for efficiency.
 *
 * Matching logic (all must be true for a match):
 *  1. system_id: system-specific templates only match their own system
 *  2. message: must match template.pattern_regex
 *  3. host: if template.host_pattern is set, event.host must match
 *  4. program: if template.program_pattern is set, event.program must match
 */
export function matchesNormalBehavior(
  message: string,
  compiledTemplates: CompiledTemplate[],
  eventSystemId?: string,
  eventHost?: string,
  eventProgram?: string,
): NormalBehaviorTemplate | null {
  for (const t of compiledTemplates) {
    // System-specific templates only apply to events from the same system.
    if (t.system_id && t.system_id !== eventSystemId) {
      continue;
    }

    // Message must match
    if (!t._compiledRegex.test(message)) {
      continue;
    }

    // Host filter (if template specifies one)
    if (t._compiledHostRegex) {
      const hostStr = eventHost ?? '';
      if (!t._compiledHostRegex.test(hostStr)) {
        continue;
      }
    }

    // Program filter (if template specifies one)
    if (t._compiledProgramRegex) {
      const progStr = eventProgram ?? '';
      if (!t._compiledProgramRegex.test(progStr)) {
        continue;
      }
    }

    return t;
  }
  return null;
}

// ── Loading from DB ──────────────────────────────────────────

/**
 * Load and compile all active normal-behavior templates relevant to a system.
 * Returns global templates (system_id IS NULL) plus system-specific ones.
 *
 * Results are compiled once and can be reused for the entire pipeline run.
 */
export async function loadNormalBehaviorTemplates(
  db: Knex,
  systemId?: string,
): Promise<CompiledTemplate[]> {
  let query = db('normal_behavior_templates').where({ enabled: true });

  if (systemId) {
    query = query.andWhere(function () {
      this.whereNull('system_id').orWhere('system_id', systemId);
    });
  }

  const rows: NormalBehaviorTemplate[] = await query.select('*');
  return rows.map(compileTemplate);
}

/**
 * Filter events, removing those that match normal-behavior templates.
 * Returns only events that should be sent to the LLM.
 *
 * System-aware: system-specific templates only filter events from the
 * same system. Global templates (system_id IS NULL) filter all events.
 *
 * Host/program-aware: if a template specifies host_pattern or
 * program_pattern, those fields must also match.
 */
export function filterNormalBehaviorEvents<
  T extends { id: string; message: string; system_id?: string; host?: string; program?: string },
>(
  events: T[],
  templates: CompiledTemplate[],
): { filtered: T[]; excluded: T[]; excludedCount: number } {
  if (templates.length === 0) {
    return { filtered: events, excluded: [], excludedCount: 0 };
  }

  const filtered: T[] = [];
  const excluded: T[] = [];

  for (const event of events) {
    if (matchesNormalBehavior(event.message, templates, event.system_id, event.host, event.program)) {
      excluded.push(event);
    } else {
      filtered.push(event);
    }
  }

  return { filtered, excluded, excludedCount: excluded.length };
}
