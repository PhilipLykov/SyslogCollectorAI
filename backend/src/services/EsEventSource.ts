/**
 * Elasticsearch implementation of EventSource.
 *
 * Reads events from an Elasticsearch cluster while keeping lightweight
 * metadata (acknowledgments, template assignments) in PostgreSQL via the
 * `es_event_metadata` table.
 *
 * The ES query DSL is built dynamically based on the same filters that
 * PgEventSource uses, translated to their ES equivalents.
 */

import type { Client } from '@elastic/elasticsearch';
import type { Knex } from 'knex';
import { getDb } from '../db/index.js';
import { getEsClient } from './esClient.js';
import { localTimestamp } from '../config/index.js';
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
import type { EsSystemConfig } from '../types/index.js';

// ── Constants ────────────────────────────────────────────────────

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const FACET_LIMIT = 200;

const ALLOWED_SORT_COLUMNS = new Set([
  'timestamp', 'severity', 'host', 'source_ip', 'program', 'service',
]);

// ── Default field mapping (ECS-compatible) ───────────────────────

const DEFAULT_FIELD_MAPPING: Record<string, string> = {
  '@timestamp': 'timestamp',
  'message': 'message',
  'log.level': 'severity',
  'host.name': 'host',
  'source.ip': 'source_ip',
  'service.name': 'service',
  'log.syslog.facility.name': 'facility',
  'process.name': 'program',
  'trace.id': 'trace_id',
  'span.id': 'span_id',
};

// ── Implementation ───────────────────────────────────────────────

export class EsEventSource implements EventSource {
  private db: Knex;
  private connectionId: string;
  private systemId: string;
  private config: EsSystemConfig;
  private fieldMap: Record<string, string>;  // ES field → LogEvent field
  private reverseMap: Record<string, string>; // LogEvent field → ES field

  constructor(
    systemId: string,
    connectionId: string,
    config: EsSystemConfig,
    db?: Knex,
  ) {
    this.db = db ?? getDb();
    this.systemId = systemId;
    this.connectionId = connectionId;
    this.config = config;
    this.fieldMap = { ...DEFAULT_FIELD_MAPPING, ...(config.field_mapping ?? {}) };
    this.reverseMap = {};
    for (const [esField, logField] of Object.entries(this.fieldMap)) {
      this.reverseMap[logField] = esField;
    }
    // Ensure timestamp and message fields are mapped
    if (config.timestamp_field && config.timestamp_field !== '@timestamp') {
      this.fieldMap[config.timestamp_field] = 'timestamp';
      this.reverseMap['timestamp'] = config.timestamp_field;
    }
    if (config.message_field && config.message_field !== 'message') {
      this.fieldMap[config.message_field] = 'message';
      this.reverseMap['message'] = config.message_field;
    }
  }

  private async getClient(): Promise<Client> {
    return getEsClient(this.connectionId, this.db);
  }

  /** Get the ES field name for a LogEvent field. */
  private esField(logField: string): string {
    return this.reverseMap[logField] ?? logField;
  }

  /** Map an ES hit to a LogEvent. */
  private hitToLogEvent(hit: any): LogEvent {
    const source = hit._source ?? {};
    const event: LogEvent = {
      id: hit._id,
      system_id: this.systemId,
      timestamp: this.extractField(source, 'timestamp') ?? new Date().toISOString(),
      message: this.extractField(source, 'message') ?? '',
      severity: this.extractField(source, 'severity'),
      host: this.extractField(source, 'host'),
      source_ip: this.extractField(source, 'source_ip'),
      service: this.extractField(source, 'service'),
      facility: this.extractField(source, 'facility'),
      program: this.extractField(source, 'program'),
      trace_id: this.extractField(source, 'trace_id'),
      span_id: this.extractField(source, 'span_id'),
      raw: source,
    };
    return event;
  }

  /** Extract a field from ES source using the field mapping. */
  private extractField(source: Record<string, unknown>, logField: string): string | undefined {
    const esField = this.esField(logField);
    // Support nested dot-notation
    const parts = esField.split('.');
    let current: unknown = source;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    if (current == null) return undefined;
    return String(current);
  }

  /** Build the base ES query (index pattern + optional query filter). */
  private baseQuery(): { index: string; query: any } {
    const must: any[] = [];
    if (this.config.query_filter && Object.keys(this.config.query_filter).length > 0) {
      must.push(this.config.query_filter);
    }
    return {
      index: this.config.index_pattern,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
    };
  }

  // ── Search & retrieval ─────────────────────────────────────

  async searchEvents(filters: EventSearchFilters): Promise<EventSearchResult> {
    const client = await this.getClient();
    const base = this.baseQuery();

    const rawPage = filters.page ?? 1;
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const rawLimit = filters.limit ?? DEFAULT_LIMIT;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;

    // Build query
    const must: any[] = [];
    const filter: any[] = [];

    // Inherit base query
    if (base.query && (base.query as any).bool?.must) {
      must.push(...(base.query as any).bool.must);
    }

    // Severity filter
    if (filters.severity) {
      const sevField = this.esField('severity');
      const severities = filters.severity.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
      if (severities.length > 0) {
        filter.push({ terms: { [sevField]: severities } });
      }
    }

    // Simple field filters
    const fieldFilters: Array<[string, string | undefined]> = [
      ['host', filters.host],
      ['source_ip', filters.source_ip],
      ['program', filters.program],
      ['service', filters.service],
      ['trace_id', filters.trace_id],
    ];
    for (const [logField, value] of fieldFilters) {
      if (value) {
        filter.push({ term: { [this.esField(logField)]: value } });
      }
    }

    // System ID filter — for cross-system queries, skip if this source is system-scoped
    // (EsEventSource is always scoped to one system, so system_id filter is implicit)

    // Time range
    if (filters.from || filters.to) {
      const range: Record<string, string> = {};
      if (filters.from && !isNaN(Date.parse(filters.from))) range.gte = filters.from;
      if (filters.to && !isNaN(Date.parse(filters.to))) range.lte = filters.to;
      if (Object.keys(range).length > 0) {
        filter.push({ range: { [this.esField('timestamp')]: range } });
      }
    }

    // Full-text search
    if (filters.q && filters.q.trim().length > 0) {
      const msgField = this.esField('message');
      if (filters.q_mode === 'contains') {
        must.push({ wildcard: { [msgField]: { value: `*${filters.q.trim()}*`, case_insensitive: true } } });
      } else {
        must.push({ match: { [msgField]: { query: filters.q.trim(), operator: 'and' } } });
      }
    }

    const query: any = {
      bool: {
        ...(must.length > 0 ? { must } : {}),
        ...(filter.length > 0 ? { filter } : {}),
      },
    };

    // If bool is empty, use match_all
    const boolObj = query.bool as Record<string, any>;
    const hasContent = (boolObj.must && (boolObj.must as any[]).length > 0) ||
                       (boolObj.filter && (boolObj.filter as any[]).length > 0);
    const finalQuery = hasContent ? query : { match_all: {} };

    // Sort
    const sortColumn = ALLOWED_SORT_COLUMNS.has(filters.sort_by ?? '') ? filters.sort_by! : 'timestamp';
    const sortDirection = filters.sort_dir === 'asc' ? 'asc' as const : 'desc' as const;
    const sort: any[] = [
      { [this.esField(sortColumn)]: { order: sortDirection, unmapped_type: 'date' } },
      { _id: { order: 'asc' as const } },
    ];

    // Execute count + search
    const [countResult, searchResult] = await Promise.all([
      client.count({ index: base.index, query: finalQuery }),
      client.search({
        index: base.index,
        query: finalQuery,
        sort,
        from: (page - 1) * limit,
        size: limit,
        _source: true,
      }),
    ]);

    const total = typeof countResult.count === 'number' ? countResult.count : 0;
    const events = (searchResult.hits?.hits ?? []).map((h: any) => this.hitToLogEvent(h));

    // Enrich with PG metadata (acknowledgments)
    await this.enrichWithMetadata(events);

    return {
      events,
      total,
      page,
      limit,
      has_more: (page - 1) * limit + limit < total,
    };
  }

  async getFacets(systemId: string | undefined, days: number): Promise<EventFacets> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const tsField = this.esField('timestamp');
    const timeFilter = { range: { [tsField]: { gte: since } } };

    const baseFilter: any[] = [];
    if ((base.query as any)?.bool?.must) {
      baseFilter.push(...(base.query as any).bool.must);
    }
    baseFilter.push(timeFilter);

    const aggs: Record<string, any> = {
      severities: { terms: { field: this.esField('severity'), size: FACET_LIMIT } },
      hosts: { terms: { field: this.esField('host'), size: FACET_LIMIT } },
      source_ips: { terms: { field: this.esField('source_ip'), size: FACET_LIMIT } },
      programs: { terms: { field: this.esField('program'), size: FACET_LIMIT } },
    };

    const result = await client.search({
      index: base.index,
      size: 0,
      query: { bool: { filter: baseFilter } },
      aggs,
    });

    const aggResult = (result.aggregations ?? {}) as Record<string, any>;

    return {
      severities: (aggResult.severities?.buckets ?? []).map((b: any) => String(b.key)),
      hosts: (aggResult.hosts?.buckets ?? []).map((b: any) => String(b.key)),
      source_ips: (aggResult.source_ips?.buckets ?? []).map((b: any) => String(b.key)),
      programs: (aggResult.programs?.buckets ?? []).map((b: any) => String(b.key)),
    };
  }

  async traceEvents(
    value: string,
    field: 'trace_id' | 'message' | 'all',
    fromTs: string,
    toTs: string,
    limit: number,
  ): Promise<TraceResult> {
    const client = await this.getClient();
    const base = this.baseQuery();

    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);
    filter.push({ range: { [this.esField('timestamp')]: { gte: fromTs, lte: toTs } } });

    const should: any[] = [];
    if (field === 'trace_id' || field === 'all') {
      should.push({ term: { [this.esField('trace_id')]: value } });
    }
    if (field === 'message' || field === 'all') {
      should.push({ wildcard: { [this.esField('message')]: { value: `*${value}*`, case_insensitive: true } } });
    }
    if (field === 'all') {
      should.push({ term: { [this.esField('span_id')]: value } });
    }

    const query = {
      bool: {
        filter,
        should,
        minimum_should_match: 1,
      },
    };

    const result = await client.search({
      index: base.index,
      query,
      sort: [{ [this.esField('timestamp')]: { order: 'asc' as const, unmapped_type: 'date' } }],
      size: Math.min(limit, 1000),
      _source: true,
    });

    const events = (result.hits?.hits ?? []).map((h: any) => this.hitToLogEvent(h));
    await this.enrichWithMetadata(events);

    return { events, total: events.length };
  }

  async getSystemEvents(
    systemId: string,
    opts: { from?: string; to?: string; limit: number },
  ): Promise<LogEvent[]> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);

    const tsField = this.esField('timestamp');
    if (opts.from || opts.to) {
      const range: Record<string, string> = {};
      if (opts.from) range.gte = opts.from;
      if (opts.to) range.lte = opts.to;
      filter.push({ range: { [tsField]: range } });
    }

    const query = filter.length > 0 ? { bool: { filter } } : { match_all: {} };

    const result = await client.search({
      index: base.index,
      query,
      sort: [{ [tsField]: { order: 'desc' as const, unmapped_type: 'date' } }],
      size: Math.min(opts.limit, 500),
      _source: true,
    });

    const events = (result.hits?.hits ?? []).map((h: any) => this.hitToLogEvent(h));
    await this.enrichWithMetadata(events);
    return events;
  }

  async countSystemEvents(systemId: string, since: string): Promise<number> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);
    filter.push({ range: { [this.esField('timestamp')]: { gte: since } } });

    const result = await client.count({
      index: base.index,
      query: { bool: { filter } },
    });

    return typeof result.count === 'number' ? result.count : 0;
  }

  // ── AI pipeline ────────────────────────────────────────────

  async getUnscoredEvents(
    systemId: string | undefined,
    limit: number,
  ): Promise<LogEvent[]> {
    // For ES, "unscored" means events that don't have a corresponding
    // row in event_scores. We first get recent events from ES, then
    // filter out those already scored in PG.
    const client = await this.getClient();
    const base = this.baseQuery();
    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);

    // Only look at last 24h to bound the search
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    filter.push({ range: { [this.esField('timestamp')]: { gte: since } } });

    // Exclude acknowledged events
    const ackIds = await this.db('es_event_metadata')
      .where({ system_id: this.systemId })
      .whereNotNull('acknowledged_at')
      .select('es_event_id');
    const ackIdSet = new Set(ackIds.map((r: any) => r.es_event_id));

    // Fetch a larger batch and filter locally
    const fetchSize = Math.min(limit * 3, 1000);
    const result = await client.search({
      index: base.index,
      query: filter.length > 0 ? { bool: { filter } } : { match_all: {} },
      sort: [{ [this.esField('timestamp')]: { order: 'desc' as const, unmapped_type: 'date' } }],
      size: fetchSize,
      _source: true,
    });

    const hits = (result.hits?.hits ?? []);
    const candidateEvents = hits.map((h: any) => this.hitToLogEvent(h));

    // Filter out acknowledged and already-scored events
    const candidateIds = candidateEvents.map((e) => e.id);
    const scoredRows = candidateIds.length > 0
      ? await this.db('event_scores')
          .whereIn('event_id', candidateIds)
          .distinct('event_id')
          .pluck('event_id')
      : [];
    const scoredSet = new Set(scoredRows);

    const unscored: LogEvent[] = [];
    for (const evt of candidateEvents) {
      if (ackIdSet.has(evt.id)) continue;
      if (scoredSet.has(evt.id)) continue;
      unscored.push(evt);
      if (unscored.length >= limit) break;
    }

    return unscored;
  }

  async getEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
    opts?: { limit?: number; excludeAcknowledged?: boolean },
  ): Promise<LogEvent[]> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);
    filter.push({ range: { [this.esField('timestamp')]: { gte: fromTs, lt: toTs } } });

    const query = { bool: { filter } };
    const fetchLimit = opts?.limit ?? 10000;

    const result = await client.search({
      index: base.index,
      query,
      sort: [{ [this.esField('timestamp')]: { order: 'asc' as const, unmapped_type: 'date' } }],
      size: Math.min(fetchLimit, 10000),
      _source: true,
    });

    let events = (result.hits?.hits ?? []).map((h: any) => this.hitToLogEvent(h));

    if (opts?.excludeAcknowledged) {
      const ackIds = await this.db('es_event_metadata')
        .where({ system_id: this.systemId })
        .whereNotNull('acknowledged_at')
        .select('es_event_id');
      const ackSet = new Set(ackIds.map((r: any) => r.es_event_id));
      events = events.filter((e) => !ackSet.has(e.id));
    }

    // Enrich with template_id from metadata
    await this.enrichWithMetadata(events);

    return events;
  }

  async countEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
  ): Promise<number> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const filter: any[] = [];
    if ((base.query as any)?.bool?.must) filter.push(...(base.query as any).bool.must);
    filter.push({ range: { [this.esField('timestamp')]: { gte: fromTs, lt: toTs } } });

    const result = await client.count({
      index: base.index,
      query: { bool: { filter } },
    });

    return typeof result.count === 'number' ? result.count : 0;
  }

  // ── Acknowledgment ─────────────────────────────────────────

  async acknowledgeEvents(filters: AckFilters): Promise<number> {
    // For ES, acknowledgment is stored in es_event_metadata (PG).
    // We first query ES for matching event IDs, then upsert metadata.
    const client = await this.getClient();
    const base = this.baseQuery();
    const esFilter: any[] = [];
    if ((base.query as any)?.bool?.must) esFilter.push(...(base.query as any).bool.must);

    const tsField = this.esField('timestamp');
    const range: Record<string, string> = {};
    if (filters.from) range.gte = filters.from;
    range.lte = filters.to;
    esFilter.push({ range: { [tsField]: range } });

    // Use scroll to batch through potentially large result sets
    const BATCH_SIZE = 5000;
    let totalAcked = 0;
    const ackTs = new Date().toISOString();

    // Get total count
    const countResult = await client.count({
      index: base.index,
      query: { bool: { filter: esFilter } },
    });

    if (countResult.count === 0) return 0;

    // Use search_after for efficient pagination
    let searchAfter: any[] | undefined;
    let hasMore = true;

    while (hasMore) {
      const searchOpts: any = {
        index: base.index,
        query: { bool: { filter: esFilter } },
        sort: [{ [tsField]: { order: 'asc' as const, unmapped_type: 'date' } }, { _id: 'asc' as const }],
        size: BATCH_SIZE,
        _source: false,
      };
      if (searchAfter) {
        searchOpts.search_after = searchAfter;
      }

      const result = await client.search(searchOpts);
      const hits = result.hits?.hits ?? [];
      if (hits.length === 0) { hasMore = false; break; }

      // Upsert acknowledgment metadata in PG
      const eventIds = hits.map((h: any) => h._id);
      for (let i = 0; i < eventIds.length; i += 500) {
        const chunk = eventIds.slice(i, i + 500);
        const values = chunk.map((eid: string) => ({
          system_id: this.systemId,
          es_event_id: eid,
          acknowledged_at: ackTs,
        }));

        // Use upsert (ON CONFLICT DO UPDATE)
        await this.db.raw(
          `INSERT INTO es_event_metadata (system_id, es_event_id, acknowledged_at)
           VALUES ${values.map(() => '(?, ?, ?)').join(', ')}
           ON CONFLICT (system_id, es_event_id) DO UPDATE SET acknowledged_at = EXCLUDED.acknowledged_at`,
          values.flatMap((v: any) => [v.system_id, v.es_event_id, v.acknowledged_at]),
        );
      }

      totalAcked += eventIds.length;
      searchAfter = hits[hits.length - 1].sort;
      if (hits.length < BATCH_SIZE) hasMore = false;
    }

    return totalAcked;
  }

  async unacknowledgeEvents(filters: AckFilters): Promise<number> {
    // Match the time range by querying ES for the matching IDs first,
    // then clear ack in PG's es_event_metadata.
    const client = await this.getClient();
    const base = this.baseQuery();
    const esFilter: any[] = [];
    if ((base.query as any)?.bool?.must) esFilter.push(...(base.query as any).bool.must);

    const tsField = this.esField('timestamp');
    const range: Record<string, string> = {};
    if (filters.from) range.gte = filters.from;
    range.lte = filters.to;
    esFilter.push({ range: { [tsField]: range } });

    // Get IDs from ES
    const result = await client.search({
      index: base.index,
      query: { bool: { filter: esFilter } },
      sort: [{ [tsField]: { order: 'asc' as const, unmapped_type: 'date' } }],
      size: 10000,
      _source: false,
    });

    const eventIds = (result.hits?.hits ?? []).map((h: any) => h._id as string);
    if (eventIds.length === 0) return 0;

    // Clear acknowledged_at for these IDs
    let totalUnacked = 0;
    for (let i = 0; i < eventIds.length; i += 500) {
      const chunk = eventIds.slice(i, i + 500);
      const updated = await this.db('es_event_metadata')
        .where({ system_id: this.systemId })
        .whereIn('es_event_id', chunk)
        .whereNotNull('acknowledged_at')
        .update({ acknowledged_at: null });
      totalUnacked += updated;
    }

    return totalUnacked;
  }

  // ── Maintenance & admin ────────────────────────────────────

  async deleteOldEvents(_systemId: string, _cutoffIso: string): Promise<BulkDeleteResult> {
    // Cannot delete events from a read-only ES cluster.
    // We can only clean up local PG metadata and orphaned scores.
    console.log(`[${localTimestamp()}] ES: deleteOldEvents is a no-op for Elasticsearch-backed systems (read-only). Cleaning PG metadata + scores only.`);

    // Find old metadata IDs to also clean up their event_scores
    const oldMetaIds = await this.db('es_event_metadata')
      .where({ system_id: this.systemId })
      .where('created_at', '<', _cutoffIso)
      .pluck('es_event_id');

    let deletedScores = 0;
    // Delete associated event_scores in batches
    for (let i = 0; i < oldMetaIds.length; i += 500) {
      const chunk = oldMetaIds.slice(i, i + 500);
      deletedScores += await this.db('event_scores').whereIn('event_id', chunk).del();
    }

    // Delete the metadata rows
    const deletedMeta = await this.db('es_event_metadata')
      .where({ system_id: this.systemId })
      .where('created_at', '<', _cutoffIso)
      .del();

    console.log(`[${localTimestamp()}] ES: cleaned ${deletedMeta} metadata rows and ${deletedScores} event_scores rows`);

    return { deleted_events: 0, deleted_scores: deletedScores };
  }

  async bulkDeleteEvents(_filters: BulkDeleteFilters): Promise<BulkDeleteResult> {
    // Cannot delete events from read-only ES.
    console.log(`[${localTimestamp()}] ES: bulkDeleteEvents is a no-op for Elasticsearch-backed systems (read-only).`);
    return { deleted_events: 0, deleted_scores: 0 };
  }

  async totalEventCount(): Promise<number> {
    const client = await this.getClient();
    const base = this.baseQuery();
    const result = await client.count({
      index: base.index,
      query: base.query,
    });
    return typeof result.count === 'number' ? result.count : 0;
  }

  async cascadeDeleteSystem(_systemId: string, trx: unknown): Promise<void> {
    const t = trx as Knex.Transaction;
    // Clean up PG-side metadata and scores for ES events
    const metaIds = await t('es_event_metadata')
      .where({ system_id: this.systemId })
      .pluck('es_event_id');

    if (metaIds.length > 0) {
      for (let i = 0; i < metaIds.length; i += 500) {
        await t('event_scores').whereIn('event_id', metaIds.slice(i, i + 500)).del();
      }
    }

    await t('es_event_metadata').where({ system_id: this.systemId }).del();
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Enrich LogEvents with PG-side metadata (acknowledged_at, template_id).
   */
  private async enrichWithMetadata(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;

    const eventIds = events.map((e) => e.id);
    const metaRows = await this.db('es_event_metadata')
      .where({ system_id: this.systemId })
      .whereIn('es_event_id', eventIds)
      .select('es_event_id', 'acknowledged_at', 'template_id');

    const metaMap = new Map<string, { acknowledged_at?: string | null; template_id?: string | null }>();
    for (const row of metaRows) {
      metaMap.set(row.es_event_id, row);
    }

    for (const event of events) {
      const meta = metaMap.get(event.id);
      if (meta) {
        event.acknowledged_at = meta.acknowledged_at;
        event.template_id = meta.template_id;
      }
    }
  }
}
