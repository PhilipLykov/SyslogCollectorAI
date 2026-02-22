import type { Knex } from 'knex';
import crypto from 'crypto';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

export interface DiscoveryConfig {
  enabled: boolean;
  group_by_host: boolean;
  group_by_ip: boolean;
  split_by_program: boolean;
  min_events_threshold: number;
  min_rate_per_hour: number;
  buffer_ttl_hours: number;
  auto_accept: boolean;
  ignore_patterns: string[];
}

export const DISCOVERY_DEFAULTS: DiscoveryConfig = {
  enabled: true,
  group_by_host: true,
  group_by_ip: true,
  split_by_program: false,
  min_events_threshold: 10,
  min_rate_per_hour: 3,
  buffer_ttl_hours: 72,
  auto_accept: false,
  ignore_patterns: [],
};

export async function loadDiscoveryConfig(db: Knex): Promise<DiscoveryConfig> {
  try {
    const row = await db('app_config').where({ key: 'discovery_config' }).first('value');
    if (!row) return { ...DISCOVERY_DEFAULTS };
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return { ...DISCOVERY_DEFAULTS, ...(raw as Partial<DiscoveryConfig>) };
  } catch {
    return { ...DISCOVERY_DEFAULTS };
  }
}

/** Purge discovery_buffer entries older than the configured TTL. */
export async function purgeDiscoveryBuffer(db: Knex, ttlHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  const result = await db('discovery_buffer').where('received_at', '<', cutoff).del();
  return typeof result === 'number' ? result : 0;
}

/** Generate a friendly system name from host/ip/program. */
function generateSuggestedName(host: string | null, ip: string | null, program: string | null): string {
  let name = '';
  if (host && host !== ip) {
    name = host
      .replace(/\.localdomain$/i, '')
      .replace(/\.local$/i, '')
      .replace(/\.internal$/i, '')
      .replace(/\.home$/i, '');
  } else if (ip) {
    name = `Host ${ip}`;
  } else {
    name = 'Unknown Source';
  }

  if (program) {
    name += ` / ${program}`;
  }
  return name;
}

/** Compute group key hash for dedup. */
function computeGroupKey(host: string | null, ip: string | null, program: string | null): string {
  const canonical = `${host ?? ''}|${ip ?? ''}|${program ?? ''}`.toLowerCase();
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Check if a value matches any of the ignore patterns. */
function matchesIgnorePatterns(value: string | null, patterns: string[]): boolean {
  if (!value || patterns.length === 0) return false;
  for (const pat of patterns) {
    try {
      if (new RegExp(pat, 'i').test(value)) return true;
    } catch { /* invalid regex, skip */ }
  }
  return false;
}

/** Find the common prefix for a list of program names (for clustering). */
function findCommonPrefix(programs: string[]): string | null {
  if (programs.length < 2) return null;
  const slashPrefixes = programs
    .filter(p => p.includes('/'))
    .map(p => p.split('/')[0]);
  if (slashPrefixes.length >= 2) {
    const unique = [...new Set(slashPrefixes)];
    if (unique.length === 1) return unique[0];
  }
  return null;
}

interface BufferGroup {
  host: string | null;
  source_ip: string | null;
  program: string | null;
  event_count: number;
  first_seen: string;
  last_seen: string;
  sample_messages: string[];
  programs: string[];
}

/**
 * Run the discovery grouping engine.
 * Aggregates discovery_buffer into discovery_suggestions.
 */
export async function runGroupingEngine(db: Knex): Promise<{ created: number; updated: number; purged: number }> {
  const cfg = await loadDiscoveryConfig(db);
  if (!cfg.enabled) return { created: 0, updated: 0, purged: 0 };

  // 1. Purge old buffer entries
  const purged = await purgeDiscoveryBuffer(db, cfg.buffer_ttl_hours);
  if (purged > 0) {
    logger.debug(`[${localTimestamp()}] Discovery: purged ${purged} expired buffer entries`);
  }

  // 2. Aggregate buffer into groups
  let groups: BufferGroup[];

  if (cfg.split_by_program) {
    const rows = await db('discovery_buffer')
      .select(
        'host', 'source_ip', 'program',
        db.raw('COUNT(*)::int as event_count'),
        db.raw('MIN(received_at) as first_seen'),
        db.raw('MAX(received_at) as last_seen'),
      )
      .groupBy('host', 'source_ip', 'program')
      .having(db.raw('COUNT(*) >= ?', [cfg.min_events_threshold]));

    groups = rows.map((r: any) => ({
      host: r.host ?? null,
      source_ip: r.source_ip ?? null,
      program: r.program ?? null,
      event_count: r.event_count,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      sample_messages: [],
      programs: r.program ? [r.program] : [],
    }));
  } else {
    const hostRows = cfg.group_by_host ? await db('discovery_buffer')
      .select(
        'host',
        db.raw('COUNT(*)::int as event_count'),
        db.raw('MIN(received_at) as first_seen'),
        db.raw('MAX(received_at) as last_seen'),
        db.raw(`ARRAY_AGG(DISTINCT program) FILTER (WHERE program IS NOT NULL) as programs`),
      )
      .whereNotNull('host')
      .groupBy('host')
      .having(db.raw('COUNT(*) >= ?', [cfg.min_events_threshold])) : [];

    const hostNames = new Set((hostRows as any[]).map((r: any) => r.host));

    const ipRows = cfg.group_by_ip ? await db('discovery_buffer')
      .select(
        'source_ip',
        db.raw('COUNT(*)::int as event_count'),
        db.raw('MIN(received_at) as first_seen'),
        db.raw('MAX(received_at) as last_seen'),
        db.raw(`ARRAY_AGG(DISTINCT program) FILTER (WHERE program IS NOT NULL) as programs`),
      )
      .whereNotNull('source_ip')
      .where(function() {
        if (hostNames.size > 0) {
          this.whereNull('host').orWhereNotIn('host', [...hostNames]);
        }
      })
      .groupBy('source_ip')
      .having(db.raw('COUNT(*) >= ?', [cfg.min_events_threshold])) : [];

    groups = [
      ...(hostRows as any[]).map((r: any) => ({
        host: r.host ?? null,
        source_ip: null as string | null,
        program: null as string | null,
        event_count: r.event_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        sample_messages: [],
        programs: Array.isArray(r.programs) ? r.programs.filter(Boolean) : [],
      })),
      ...(ipRows as any[]).map((r: any) => ({
        host: null as string | null,
        source_ip: r.source_ip ?? null,
        program: null as string | null,
        event_count: r.event_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        sample_messages: [],
        programs: Array.isArray(r.programs) ? r.programs.filter(Boolean) : [],
      })),
    ];
  }

  // 3. Filter by ignore patterns and rate
  groups = groups.filter(g => {
    if (matchesIgnorePatterns(g.host, cfg.ignore_patterns)) return false;
    if (matchesIgnorePatterns(g.source_ip, cfg.ignore_patterns)) return false;

    if (cfg.min_rate_per_hour > 0 && g.first_seen && g.last_seen) {
      const durationHours = Math.max(1, (new Date(g.last_seen).getTime() - new Date(g.first_seen).getTime()) / 3600_000);
      const rate = g.event_count / durationHours;
      if (rate < cfg.min_rate_per_hour) return false;
    }
    return true;
  });

  // 4. Fetch sample messages for each group
  for (const g of groups) {
    const sampleRows = await db('discovery_buffer')
      .select('message_sample')
      .modify((qb) => {
        if (g.host) qb.where('host', g.host);
        else if (g.source_ip) qb.where('source_ip', g.source_ip);
        if (g.program) qb.where('program', g.program);
      })
      .whereNotNull('message_sample')
      .orderBy('received_at', 'desc')
      .limit(5);
    g.sample_messages = sampleRows.map((r: any) => r.message_sample).filter(Boolean);
  }

  // 5. Check for existing system affinity
  const existingSources = await db('log_sources')
    .join('monitored_systems', 'log_sources.system_id', 'monitored_systems.id')
    .select('log_sources.selector', 'monitored_systems.id as system_id', 'monitored_systems.name as system_name');

  // 6. Upsert into discovery_suggestions
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const g of groups) {
    let displayProgram = g.program;
    if (!displayProgram && g.programs.length > 1) {
      const prefix = findCommonPrefix(g.programs);
      if (prefix) displayProgram = prefix;
    }

    const groupKey = computeGroupKey(g.host, g.source_ip, displayProgram);
    const suggestedName = generateSuggestedName(g.host, g.source_ip, displayProgram);

    let mergeTargetId: string | null = null;
    for (const src of existingSources) {
      try {
        const sel = typeof src.selector === 'string' ? JSON.parse(src.selector) : src.selector;
        const selectors = Array.isArray(sel) ? sel : [sel];
        for (const s of selectors) {
          if (!s || typeof s !== 'object') continue;
          const hostMatch = s.host && g.host && new RegExp(s.host, 'i').test(g.host);
          const ipMatch = s.source_ip && g.source_ip && new RegExp(s.source_ip, 'i').test(g.source_ip);
          if (hostMatch || ipMatch) {
            mergeTargetId = src.system_id;
            break;
          }
        }
      } catch { /* skip bad selectors */ }
      if (mergeTargetId) break;
    }

    const existing = await db('discovery_suggestions').where({ group_key: groupKey }).first();
    if (existing) {
      if (existing.status === 'dismissed' && existing.dismissed_until) {
        const dismissedUntil = new Date(existing.dismissed_until);
        if (dismissedUntil > new Date()) continue;
      }
      if (existing.status === 'accepted' || existing.status === 'merged') continue;

      await db('discovery_suggestions')
        .where({ id: existing.id })
        .update({
          event_count: g.event_count,
          last_seen_at: g.last_seen,
          sample_messages: JSON.stringify(g.sample_messages),
          program_patterns: JSON.stringify(g.programs),
          merge_target_id: mergeTargetId,
          status: 'pending',
          dismissed_until: null,
          updated_at: now,
        });
      updated++;
    } else {
      await db('discovery_suggestions').insert({
        group_key: groupKey,
        suggested_name: suggestedName,
        host_pattern: g.host,
        ip_pattern: g.source_ip,
        program_patterns: JSON.stringify(g.programs),
        sample_messages: JSON.stringify(g.sample_messages),
        event_count: g.event_count,
        first_seen_at: g.first_seen,
        last_seen_at: g.last_seen,
        status: 'pending',
        merge_target_id: mergeTargetId,
        created_at: now,
        updated_at: now,
      });
      created++;
    }
  }

  if (created > 0 || updated > 0) {
    logger.info(
      `[${localTimestamp()}] Discovery grouping: ${created} new suggestions, ${updated} updated`,
    );
  }

  return { created, updated, purged };
}
