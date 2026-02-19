import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

/**
 * Template extraction and dedup for events.
 *
 * Strategy:
 * 1. Parameterize messages: replace numbers, IPs, UUIDs, hex strings with placeholders.
 * 2. Hash the parameterized template → pattern_hash.
 * 3. Upsert template (INSERT ON CONFLICT) to avoid TOCTOU race.
 * 4. Link event to template via template_id.
 *
 * Returns template representatives (one per unique template in the batch)
 * with occurrence counts, for scoring.
 */

interface ParameterizeOptions {
  normalizeSql?: boolean;
}

const MAX_JSON_PARSE_LENGTH = 32_768;

// Replace variable parts of log messages with placeholders
function parameterizeMessage(msg: string, options?: ParameterizeOptions, _depth = 0): string {
  // JSON-aware: extract the human-readable message from structured log JSON
  // before parameterizing. Prevents quoted-string replacement from collapsing
  // all JSON keys/values into identical "<STR>" placeholders.
  // Guarded against deep recursion (max 3 levels) and oversized payloads.
  if (_depth < 3 && msg.length <= MAX_JSON_PARSE_LENGTH) {
    const trimmed = msg.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          const innerMsg = obj.msg ?? obj.message ?? obj.text;
          if (typeof innerMsg === 'string' && innerMsg.trim().length > 0) {
            return parameterizeMessage(innerMsg.trim(), options, _depth + 1);
          }
        }
      } catch { /* not valid JSON, proceed normally */ }
    }
  }

  let result = msg;

  // Replace UUIDs
  result = result.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<UUID>',
  );

  // Replace IPv4 addresses
  result = result.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>');

  // Replace IPv6 addresses (simplified)
  result = result.replace(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}\b/gi, '<IPv6>');

  // Replace hex strings (0x-prefixed 8+ chars, or standalone 16+ hex chars)
  result = result.replace(/\b0x[0-9a-f]{8,}\b/gi, '<HEX>');
  result = result.replace(/\b[0-9a-f]{16,}\b/gi, '<HEX>');

  // Replace numbers (standalone, not inside words)
  result = result.replace(/\b\d+\b/g, '<N>');

  // Replace quoted strings (handles basic cases; escaped quotes are rare in logs)
  result = result.replace(/"[^"]*"/g, '"<STR>"');
  result = result.replace(/'[^']*'/g, "'<STR>'");

  // Normalize PostgreSQL STATEMENT lines: collapse WHERE/ORDER BY/LIMIT/etc.
  // so that the same query against the same table groups regardless of clause variations.
  if (options?.normalizeSql) {
    result = result.replace(
      /STATEMENT:\s+(select|insert|update|delete)\b(.*?)\b(where|order\s+by|limit|offset|group\s+by|having|returning|on\s+conflict)\b.*/gi,
      (_, verb, middle) => `STATEMENT: ${verb}${middle}<SQL_CLAUSES>`,
    );
  }

  return result;
}

function computePatternHash(templateText: string, systemId: string | null): string {
  // Use null byte separator to prevent collision via delimiter injection
  return createHash('sha256')
    .update(`${systemId ?? 'global'}\0${templateText}`)
    .digest('hex');
}

export interface TemplateRepresentative {
  templateId: string;
  templateText: string;
  patternHash: string;
  systemId: string | null;
  occurrenceCount: number;
  representativeEventId: string;
  representativeMessage: string;
}

/**
 * Process a batch of events: extract templates, dedup, link events to templates.
 * Returns template representatives for scoring.
 *
 * Each template upsert + event linking is wrapped in a transaction so that
 * the template's occurrence_count stays consistent with linked events.
 *
 * Supports both PG-backed events (stored in the `events` table with UUID IDs)
 * and ES-backed events (stored in Elasticsearch with string IDs; metadata in
 * `es_event_metadata`).  The `esSystemIds` set controls which system IDs
 * are treated as ES-backed.
 */
export async function extractTemplatesAndDedup(
  db: Knex,
  eventRows: Array<{ id: string; system_id: string; message: string; timestamp?: string }>,
  esSystemIds?: Set<string>,
  options?: { normalizeSql?: boolean },
): Promise<TemplateRepresentative[]> {
  const paramOpts: ParameterizeOptions = { normalizeSql: options?.normalizeSql };

  // Group events by parameterized template
  const groups = new Map<string, {
    templateText: string;
    systemId: string;
    events: Array<{ id: string; message: string; timestamp?: string }>;
  }>();

  for (const event of eventRows) {
    const templateText = parameterizeMessage(event.message, paramOpts);
    const patternHash = computePatternHash(templateText, event.system_id);

    if (!groups.has(patternHash)) {
      groups.set(patternHash, {
        templateText,
        systemId: event.system_id,
        events: [],
      });
    }
    groups.get(patternHash)!.events.push({ id: event.id, message: event.message, timestamp: event.timestamp });
  }

  const representatives: TemplateRepresentative[] = [];

  for (const [patternHash, group] of groups) {
    const { templateText, systemId, events } = group;
    const count = events.length;
    const now = new Date().toISOString();
    const isEs = esSystemIds?.has(systemId) ?? false;

    // Wrap upsert + event linking in a transaction for consistency
    const templateId = await db.transaction(async (trx) => {
      const newId = uuidv4();
      const result = await trx.raw(`
        INSERT INTO message_templates (id, system_id, template_text, pattern_hash, occurrence_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (pattern_hash)
        DO UPDATE SET occurrence_count = message_templates.occurrence_count + EXCLUDED.occurrence_count,
                      last_seen_at = EXCLUDED.last_seen_at
        RETURNING id
      `, [newId, systemId, templateText, patternHash, count, now, now]);

      const tplId = result.rows[0]?.id ?? newId;

      // Link events to template — use the correct table based on event source
      const eventIds = events.map((e) => e.id);
      if (isEs) {
        // ES events: upsert template_id + event_timestamp into es_event_metadata
        // Build a map of event ID → timestamp for this group
        const tsMap = new Map<string, string | null>();
        for (const e of events) {
          tsMap.set(e.id, e.timestamp ?? null);
        }
        for (let i = 0; i < eventIds.length; i += 100) {
          const chunk = eventIds.slice(i, i + 100);
          const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
          const values = chunk.flatMap((eid) => [systemId, eid, tplId, tsMap.get(eid) ?? null]);
          await trx.raw(`
            INSERT INTO es_event_metadata (system_id, es_event_id, template_id, event_timestamp)
            VALUES ${placeholders}
            ON CONFLICT (system_id, es_event_id)
            DO UPDATE SET template_id = EXCLUDED.template_id,
                          event_timestamp = COALESCE(EXCLUDED.event_timestamp, es_event_metadata.event_timestamp)
          `, values);
        }
      } else {
        // PG events: update the events table directly
        for (let i = 0; i < eventIds.length; i += 100) {
          const chunk = eventIds.slice(i, i + 100);
          await trx('events').whereIn('id', chunk).update({ template_id: tplId });
        }
      }

      return tplId;
    });

    representatives.push({
      templateId,
      templateText,
      patternHash,
      systemId,
      occurrenceCount: count,
      representativeEventId: events[0].id,
      representativeMessage: events[0].message,
    });
  }

  logger.debug(
    `[${localTimestamp()}] Dedup: ${eventRows.length} events → ${representatives.length} templates`,
  );

  return representatives;
}
