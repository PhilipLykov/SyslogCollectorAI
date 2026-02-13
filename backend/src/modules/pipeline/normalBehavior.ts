import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';

/**
 * Normal Behavior Templates — pattern generation, matching, and loading.
 *
 * Users mark events as "normal behavior," which generates a wildcard
 * pattern (using `*`). Future events matching the pattern are excluded
 * from LLM scoring and meta-analysis, reducing noise and saving tokens.
 */

// ── Types ────────────────────────────────────────────────────

export interface NormalBehaviorTemplate {
  id: string;
  system_id: string | null;
  pattern: string;
  pattern_regex: string;
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
}

// ── Pattern Generation ───────────────────────────────────────

/**
 * Generate a normal-behavior wildcard pattern from a raw event message.
 *
 * More aggressive than the dedup `parameterizeMessage()`:
 * - Replaces network interface names (GigabitEthernet2/0/2, Vlan100, etc.)
 * - Replaces "Switch N", "Stack N", device/host identifiers
 * - Replaces IP/MAC/UUID, numbers, file paths, quoted strings
 * - Collapses consecutive wildcards
 *
 * Uses `*` as the wildcard character for user-friendliness.
 */
export function generateNormalPattern(message: string): string {
  let result = message;

  // Replace UUIDs
  result = result.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '*',
  );

  // Replace MAC addresses (aa:bb:cc:dd:ee:ff or aa-bb-cc-dd-ee-ff or aabb.ccdd.eeff)
  result = result.replace(/\b[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}\b/gi, '*');
  result = result.replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, '*');

  // Replace IPv4 addresses (must come before general number replacement)
  result = result.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/g, '*');

  // Replace IPv6 addresses (simplified)
  result = result.replace(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2,7}\b/gi, '*');

  // Replace network interface names (Cisco/HP/Juniper style)
  // GigabitEthernet0/0/1, FastEthernet0/1, TenGigabitEthernet1/0/2, Gi0/0/1, Fa0/1, Te1/0/2
  // Port-channel1, po1, Vlan100, Loopback0, Tunnel1, BVI1, mgmt0, eth0, ens192
  result = result.replace(
    /\b(?:(?:Ten)?(?:Hundred)?(?:Gigabit)?(?:Fast)?Ethernet|Gi|Fa|Te|Hu|Eth|eth|ens|em|enp\d+s)\d+(?:\/\d+)*/gi,
    '*',
  );
  result = result.replace(/\b(?:Port-channel|Po|po|Vlan|vlan|Loopback|Lo|Tunnel|Tu|BVI|bvi|mgmt|Mgmt)\d+\b/gi, '*');

  // Replace "Switch N", "Stack N", "Unit N", "Slot N", "Module N" patterns
  result = result.replace(/\b(?:Switch|Stack|Unit|Slot|Module|Member|Node)\s+\d+\b/gi, '*');

  // Replace MST/STP instance identifiers (MST0, MSTI1, etc.)
  result = result.replace(/\b(?:MST|MSTI|STP)\d+\b/gi, '*');

  // Replace hex strings (0x-prefixed 4+ chars, or standalone 8+ hex chars)
  result = result.replace(/\b0x[0-9a-f]{4,}\b/gi, '*');
  result = result.replace(/\b[0-9a-f]{16,}\b/gi, '*');

  // Replace file/directory paths
  result = result.replace(/(?:\/[\w.+-]+){2,}/g, '*');

  // Replace quoted strings
  result = result.replace(/"[^"]*"/g, '*');
  result = result.replace(/'[^']*'/g, '*');

  // Replace standalone numbers (not inside words)
  result = result.replace(/\b\d+\b/g, '*');

  // Collapse consecutive wildcards separated by optional whitespace/punctuation
  // e.g., "port * on *.*" stays, but "* * *" becomes "*"
  result = result.replace(/\*(?:\s*\*)+/g, '*');

  // Trim trailing/leading whitespace and punctuation around wildcards at boundaries
  result = result.trim();

  return result;
}

// ── Pattern ↔ Regex Conversion ───────────────────────────────

/**
 * Convert a user-friendly wildcard pattern (using `*`) to a regex string.
 * Escapes all regex special chars in literal parts, replaces `*` with `.*`.
 */
export function patternToRegex(pattern: string): string {
  // Split on `*`, escape each literal segment, rejoin with `.*`
  const segments = pattern.split('*');
  const escaped = segments.map(escapeRegex);
  return `^${escaped.join('.*')}$`;
}

/** Escape regex special characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Matching ─────────────────────────────────────────────────

/** Compile a template's regex once for efficient repeated matching. */
function compileTemplate(template: NormalBehaviorTemplate): CompiledTemplate {
  let regex: RegExp;
  try {
    regex = new RegExp(template.pattern_regex, 'i'); // case-insensitive
  } catch {
    console.error(
      `[${localTimestamp()}] Invalid regex in normal_behavior_template ${template.id}: ${template.pattern_regex}`,
    );
    // Regex that never matches anything (negative lookahead at start)
    regex = /(?!)/;
  }
  return { ...template, _compiledRegex: regex };
}

/**
 * Check if a message matches any active normal-behavior template.
 * Uses pre-compiled regex patterns for efficiency.
 *
 * When `eventSystemId` is provided, system-specific templates (non-null system_id)
 * only match events from that same system. Global templates (system_id IS NULL)
 * always match regardless of event system.
 */
export function matchesNormalBehavior(
  message: string,
  compiledTemplates: CompiledTemplate[],
  eventSystemId?: string,
): NormalBehaviorTemplate | null {
  for (const t of compiledTemplates) {
    // System-specific templates only apply to events from the same system.
    // If the event has no system_id, skip all system-specific templates.
    if (t.system_id && t.system_id !== eventSystemId) {
      continue;
    }
    if (t._compiledRegex.test(message)) {
      return t;
    }
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
 * @param events  — Array of events with at least { id, message } and optionally { system_id }
 * @param templates — Pre-loaded compiled templates
 * @returns filtered events (excludes normal-behavior matches)
 */
export function filterNormalBehaviorEvents<T extends { id: string; message: string; system_id?: string }>(
  events: T[],
  templates: CompiledTemplate[],
): { filtered: T[]; excluded: T[]; excludedCount: number } {
  if (templates.length === 0) {
    return { filtered: events, excluded: [], excludedCount: 0 };
  }

  const filtered: T[] = [];
  const excluded: T[] = [];

  for (const event of events) {
    if (matchesNormalBehavior(event.message, templates, event.system_id)) {
      excluded.push(event);
    } else {
      filtered.push(event);
    }
  }

  return { filtered, excluded, excludedCount: excluded.length };
}
