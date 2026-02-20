/**
 * PostgreSQL implementation of EventSource.
 *
 * Extracts all event-related Knex queries from route handlers and pipeline
 * modules into a single cohesive class. Route handlers and pipeline jobs
 * delegate to this class via the EventSource interface.
 */

import type { Knex } from 'knex';
import { getDb } from '../db/index.js';
import type {
  EventSource,
  LogEvent,
  EventSearchFilters,
  EventSearchResult,
  EventFacets,
  TraceResult,
  AckFilters,
  BulkDeleteFilters,
  BulkDeleteResult,
} from './EventSource.js';

// ── Constants ────────────────────────────────────────────────────

const ALLOWED_SORT_COLUMNS = new Set([
  'timestamp', 'severity', 'host', 'source_ip', 'program', 'service',
]);

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const FACET_LIMIT = 200;

// ── Helpers ──────────────────────────────────────────────────────

/** Escape LIKE/ILIKE wildcards to prevent pattern injection. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/** Parse raw JSON field safely. */
function parseRawField(raw: unknown): unknown {
  if (raw && typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* keep as string */ }
  }
  return raw;
}

/** Normalise a result row (parse raw JSON). */
function normaliseRow(row: any): LogEvent {
  return { ...row, raw: parseRawField(row.raw) };
}

// ── Select columns used by search queries ────────────────────────

const SEARCH_COLUMNS = [
  'events.id',
  'events.system_id',
  'monitored_systems.name as system_name',
  'events.log_source_id',
  'events.timestamp',
  'events.received_at',
  'events.message',
  'events.severity',
  'events.host',
  'events.source_ip',
  'events.service',
  'events.program',
  'events.facility',
  'events.trace_id',
  'events.span_id',
  'events.external_id',
  'events.raw',
  'events.acknowledged_at',
];

const TRACE_COLUMNS = [
  'events.id',
  'events.system_id',
  'monitored_systems.name as system_name',
  'events.timestamp',
  'events.message',
  'events.severity',
  'events.host',
  'events.source_ip',
  'events.program',
  'events.service',
  'events.trace_id',
  'events.span_id',
  'events.external_id',
  'events.raw',
];

// ── Implementation ───────────────────────────────────────────────

export class PgEventSource implements EventSource {
  private db: Knex;

  constructor(db?: Knex) {
    this.db = db ?? getDb();
  }

  // ── Search & retrieval ─────────────────────────────────────

  async searchEvents(filters: EventSearchFilters): Promise<EventSearchResult> {
    const {
      q, q_mode, system_id, severity, host, source_ip,
      program, service, trace_id, from, to,
    } = filters;

    const rawPage = filters.page ?? 1;
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const rawLimit = filters.limit ?? DEFAULT_LIMIT;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
    const offset = (page - 1) * limit;

    const sortColumn = ALLOWED_SORT_COLUMNS.has(filters.sort_by ?? '') ? filters.sort_by! : 'timestamp';
    const sortDirection = filters.sort_dir === 'asc' ? 'asc' : 'desc';

    // Build base query
    const baseQuery = this.db('events')
      .join('monitored_systems', 'events.system_id', 'monitored_systems.id');

    if (system_id) baseQuery.where('events.system_id', system_id);

    if (severity) {
      const severities = severity.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
      if (severities.length > 0) {
        baseQuery.whereRaw(
          `LOWER(events.severity) IN (${severities.map(() => '?').join(', ')})`,
          severities,
        );
      }
    }

    if (host) {
      const hosts = host.split(',').map(h => h.trim()).filter(h => h.length > 0);
      if (hosts.length === 1) {
        baseQuery.where('events.host', hosts[0]);
      } else if (hosts.length > 1) {
        baseQuery.whereIn('events.host', hosts);
      }
    }
    if (source_ip) {
      const ips = source_ip.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);
      if (ips.length === 1) {
        baseQuery.where('events.source_ip', ips[0]);
      } else if (ips.length > 1) {
        baseQuery.whereIn('events.source_ip', ips);
      }
    }
    if (program) {
      const programs = program.split(',').map(p => p.trim()).filter(p => p.length > 0);
      if (programs.length === 1) {
        baseQuery.where('events.program', programs[0]);
      } else if (programs.length > 1) {
        baseQuery.whereIn('events.program', programs);
      }
    }
    if (service) baseQuery.where('events.service', service);
    if (trace_id) baseQuery.where('events.trace_id', trace_id);
    if (from && !isNaN(Date.parse(from))) baseQuery.where('events.timestamp', '>=', from);
    if (to && !isNaN(Date.parse(to))) baseQuery.where('events.timestamp', '<=', to);

    // Full-text search
    if (q && q.trim().length > 0) {
      const trimmed = q.trim();
      if (q_mode === 'contains') {
        baseQuery.where('events.message', 'ILIKE', `%${escapeLike(trimmed)}%`);
      } else {
        baseQuery.whereRaw(
          `to_tsvector('english', events.message) @@ websearch_to_tsquery('english', ?)`,
          [trimmed],
        );
      }
    }

    // Count total
    const countResult = await baseQuery.clone().clearSelect().clearOrder()
      .count('events.id as total').first();
    const total = Number(countResult?.total ?? 0);

    // Fetch page
    const rows = await baseQuery.clone()
      .select(...SEARCH_COLUMNS)
      .orderBy(`events.${sortColumn}`, sortDirection)
      .orderBy('events.id', 'asc')
      .limit(limit)
      .offset(offset);

    return {
      events: rows.map(normaliseRow),
      total,
      page,
      limit,
      has_more: offset + limit < total,
    };
  }

  async getFacets(systemId: string | undefined, days: number): Promise<EventFacets> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const baseWhere = (col: string) => {
      const q = this.db('events')
        .where('events.timestamp', '>=', since)
        .whereNotNull(col)
        .where(col, '!=', '');
      if (systemId) q.where('events.system_id', systemId);
      return q;
    };

    const [severities, hosts, sourceIps, programs] = await Promise.all([
      baseWhere('events.severity').distinct('events.severity as value').orderBy('value').limit(FACET_LIMIT),
      baseWhere('events.host').distinct('events.host as value').orderBy('value').limit(FACET_LIMIT),
      baseWhere('events.source_ip').distinct('events.source_ip as value').orderBy('value').limit(FACET_LIMIT),
      baseWhere('events.program').distinct('events.program as value').orderBy('value').limit(FACET_LIMIT),
    ]);

    return {
      severities: severities.map((r: any) => r.value),
      hosts: hosts.map((r: any) => r.value),
      source_ips: sourceIps.map((r: any) => r.value),
      programs: programs.map((r: any) => r.value),
    };
  }

  async traceEvents(
    value: string,
    field: 'trace_id' | 'message' | 'all',
    fromTs: string,
    toTs: string,
    limit: number,
  ): Promise<TraceResult> {
    const query = this.db('events')
      .join('monitored_systems', 'events.system_id', 'monitored_systems.id')
      .where('events.timestamp', '>=', fromTs)
      .where('events.timestamp', '<=', toTs);

    if (field === 'trace_id') {
      query.where('events.trace_id', value);
    } else if (field === 'message') {
      query.where('events.message', 'ILIKE', `%${escapeLike(value)}%`);
    } else {
      query.where(function () {
        this.where('events.trace_id', value)
          .orWhere('events.span_id', value)
          .orWhere('events.message', 'ILIKE', `%${escapeLike(value)}%`);
      });
    }

    const rows = await query.select(...TRACE_COLUMNS).orderBy('events.timestamp', 'asc').limit(limit);

    return {
      events: rows.map(normaliseRow),
      total: rows.length,
    };
  }

  async getSystemEvents(
    systemId: string,
    opts: {
      from?: string;
      to?: string;
      limit: number;
      severity?: string[];
      host?: string[];
      program?: string[];
      service?: string[];
      facility?: string[];
      event_ids?: string[];
    },
  ): Promise<LogEvent[]> {
    let query = this.db('events')
      .where({ system_id: systemId })
      .orderBy('timestamp', 'desc')
      .limit(opts.limit);

    if (opts.from) query = query.where('timestamp', '>=', opts.from);
    if (opts.to) query = query.where('timestamp', '<=', opts.to);

    // Fetch specific events by ID (used by proof-event links in findings)
    if (opts.event_ids?.length) query = query.whereIn('id', opts.event_ids);

    // Multi-value filters — WHERE column IN (...)
    if (opts.severity?.length) query = query.whereIn('severity', opts.severity);
    if (opts.host?.length) query = query.whereIn('host', opts.host);
    if (opts.program?.length) query = query.whereIn('program', opts.program);
    if (opts.service?.length) query = query.whereIn('service', opts.service);
    if (opts.facility?.length) query = query.whereIn('facility', opts.facility);

    const rows = await query.select('*');
    return rows.map(normaliseRow);
  }

  async countSystemEvents(systemId: string, since: string): Promise<number> {
    const result = await this.db('events')
      .where({ system_id: systemId })
      .where('timestamp', '>=', since)
      .count('id as cnt')
      .first();
    return Number(result?.cnt ?? 0);
  }

  // ── AI pipeline ────────────────────────────────────────────

  async getUnscoredEvents(
    systemId: string | undefined,
    limit: number,
  ): Promise<LogEvent[]> {
    // Use scored_at column instead of expensive LEFT JOIN with event_scores.
    // Also limit to recent events (last 48h) for partition pruning.
    const recentCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let query = this.db('events')
      .whereNull('scored_at')
      .whereNull('acknowledged_at')
      .where('timestamp', '>=', recentCutoff)
      .select('id', 'system_id', 'message', 'severity', 'host', 'program', 'log_source_id')
      .orderBy('timestamp', 'desc')
      .limit(limit);

    if (systemId) {
      query = query.where('system_id', systemId);
    }

    return query;
  }

  async getEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
    opts?: { limit?: number; excludeAcknowledged?: boolean },
  ): Promise<LogEvent[]> {
    let query = this.db('events')
      .where({ system_id: systemId })
      .where('timestamp', '>=', fromTs)
      .where('timestamp', '<', toTs)
      .select('id', 'message', 'severity', 'template_id', 'acknowledged_at')
      .orderBy('timestamp', 'asc');

    if (opts?.limit) query = query.limit(opts.limit);
    if (opts?.excludeAcknowledged) query = query.whereNull('acknowledged_at');

    return query;
  }

  async countEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
  ): Promise<number> {
    const result = await this.db('events')
      .where({ system_id: systemId })
      .where('timestamp', '>=', fromTs)
      .where('timestamp', '<', toTs)
      .count('id as cnt')
      .first();
    return Number(result?.cnt ?? 0);
  }

  // ── Acknowledgment ─────────────────────────────────────────

  async acknowledgeEvents(filters: AckFilters): Promise<number> {
    const BATCH_SIZE = 5000;
    let totalAcked = 0;
    const ackTs = new Date().toISOString();

    // Count first
    let countQ = this.db('events').whereNull('acknowledged_at').where('timestamp', '<=', filters.to);
    if (filters.from) countQ = countQ.where('timestamp', '>=', filters.from);
    if (filters.system_id) countQ = countQ.where('system_id', filters.system_id);
    const countResult = await countQ.count('id as cnt').first();
    const total = Number(countResult?.cnt ?? 0);

    if (total === 0) return 0;

    while (totalAcked < total) {
      let batchQ = this.db('events').whereNull('acknowledged_at').where('timestamp', '<=', filters.to);
      if (filters.from) batchQ = batchQ.where('timestamp', '>=', filters.from);
      if (filters.system_id) batchQ = batchQ.where('system_id', filters.system_id);

      const ids = await batchQ.select('id').limit(BATCH_SIZE);
      if (ids.length === 0) break;

      const idStrings = ids.map((r: any) => r.id);

      await this.db('events')
        .whereIn('id', idStrings)
        .update({ acknowledged_at: ackTs });

      // Delete event_scores for acknowledged events so they no longer
      // contribute to effective scores or appear in drill-downs.
      // On unacknowledge the pipeline will re-score them automatically.
      await this.db('event_scores')
        .whereIn('event_id', idStrings.map(String))
        .del();

      totalAcked += ids.length;
    }

    return totalAcked;
  }

  async unacknowledgeEvents(filters: AckFilters): Promise<number> {
    // Collect IDs of events being un-acknowledged so we can delete
    // their (now-stale zeroed) scores and let the pipeline re-score them.
    let idQuery = this.db('events')
      .whereNotNull('acknowledged_at')
      .where('timestamp', '<=', filters.to);
    if (filters.from) idQuery = idQuery.where('timestamp', '>=', filters.from);
    if (filters.system_id) idQuery = idQuery.where('system_id', filters.system_id);

    const rows = await idQuery.select('id');
    if (rows.length === 0) return 0;

    const idStrings = rows.map((r: any) => String(r.id));

    // Clear acknowledged_at and scored_at so the pipeline re-scores these events
    let updateQ = this.db('events')
      .whereNotNull('acknowledged_at')
      .where('timestamp', '<=', filters.to);
    if (filters.from) updateQ = updateQ.where('timestamp', '>=', filters.from);
    if (filters.system_id) updateQ = updateQ.where('system_id', filters.system_id);
    const count = await updateQ.update({ acknowledged_at: null, scored_at: null });

    // Delete existing scores so the scoring pipeline re-scores these events
    const CHUNK = 5000;
    for (let i = 0; i < idStrings.length; i += CHUNK) {
      await this.db('event_scores')
        .whereIn('event_id', idStrings.slice(i, i + CHUNK))
        .del();
    }

    return count;
  }

  // ── Maintenance & admin ────────────────────────────────────

  async deleteOldEvents(systemId: string, cutoffIso: string): Promise<BulkDeleteResult> {
    // Step 1: Bulk delete scores
    const scoreResult = await this.db.raw(
      `DELETE FROM event_scores WHERE event_id IN (
        SELECT id::text FROM events WHERE system_id = ? AND "timestamp" < ?
      )`,
      [systemId, cutoffIso],
    );
    const deletedScores = scoreResult.rowCount ?? 0;

    // Step 2: Bulk delete events (leverages partition pruning on timestamp)
    const eventResult = await this.db.raw(
      `DELETE FROM events WHERE system_id = ? AND "timestamp" < ?`,
      [systemId, cutoffIso],
    );
    const deletedEvents = eventResult.rowCount ?? 0;

    return { deleted_events: deletedEvents, deleted_scores: deletedScores };
  }

  async bulkDeleteEvents(filters: BulkDeleteFilters): Promise<BulkDeleteResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.from) { conditions.push(`"timestamp" >= ?`); params.push(filters.from); }
    if (filters.to) { conditions.push(`"timestamp" <= ?`); params.push(filters.to); }
    if (filters.system_id) { conditions.push(`system_id = ?`); params.push(filters.system_id); }

    if (conditions.length === 0) {
      return { deleted_events: 0, deleted_scores: 0 };
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // Step 1: Bulk delete scores via subquery (single SQL)
    const scoreResult = await this.db.raw(
      `DELETE FROM event_scores WHERE event_id IN (SELECT id::text FROM events ${where})`,
      params,
    );
    const deletedScores = scoreResult.rowCount ?? 0;

    // Step 2: Bulk delete events (leverages partition pruning on timestamp)
    const eventResult = await this.db.raw(
      `DELETE FROM events ${where}`,
      params,
    );
    const deletedEvents = eventResult.rowCount ?? 0;

    return { deleted_events: deletedEvents, deleted_scores: deletedScores };
  }

  async totalEventCount(): Promise<number> {
    const result = await this.db('events').count('id as cnt').first();
    return Number(result?.cnt ?? 0);
  }

  async cascadeDeleteSystem(systemId: string, trx: unknown): Promise<void> {
    const t = trx as Knex.Transaction;

    // Bulk delete scores via subquery (avoids loading all IDs into memory)
    await t.raw(
      `DELETE FROM event_scores WHERE event_id IN (SELECT id::text FROM events WHERE system_id = ?)`,
      [systemId],
    );
    await t('events').where({ system_id: systemId }).del();
  }
}
