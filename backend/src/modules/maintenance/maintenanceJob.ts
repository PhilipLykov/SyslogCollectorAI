/**
 * Database Maintenance Job
 *
 * Performs periodic database maintenance tasks:
 * 1. Data retention cleanup — delete events older than the configured retention period
 * 2. VACUUM ANALYZE — reclaim storage and update query planner statistics
 * 3. REINDEX — rebuild indexes for optimal performance
 * 4. Log run history to maintenance_log table
 *
 * Each system can have its own retention_days (NULL = use global default).
 */

import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { loadBackupConfig, runBackup, cleanupOldBackups } from './backupJob.js';
import { getEventSource } from '../../services/eventSourceFactory.js';

// ── Types ──────────────────────────────────────────────────────

export interface MaintenanceConfig {
  default_retention_days: number;
  maintenance_interval_hours: number;
}

export interface MaintenanceRunResult {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  events_deleted: number;
  event_scores_deleted: number;
  systems_cleaned: Array<{ system_id: string; system_name: string; retention_days: number; events_deleted: number }>;
  vacuum_ran: boolean;
  reindex_ran: boolean;
  errors: string[];
}

const CONFIG_DEFAULTS: MaintenanceConfig = {
  default_retention_days: 90,
  maintenance_interval_hours: 6,
};

// ── Config Loader ──────────────────────────────────────────────

export async function loadMaintenanceConfig(db: Knex): Promise<MaintenanceConfig> {
  try {
    const rows = await db('app_config')
      .whereIn('key', ['default_retention_days', 'maintenance_interval_hours'])
      .select('key', 'value');

    const cfg = { ...CONFIG_DEFAULTS };
    for (const row of rows) {
      let v = row.value;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { /* use as-is */ }
      }
      const num = Number(v);
      if (row.key === 'default_retention_days' && Number.isFinite(num) && num > 0) {
        cfg.default_retention_days = num;
      }
      if (row.key === 'maintenance_interval_hours' && Number.isFinite(num) && num > 0) {
        cfg.maintenance_interval_hours = num;
      }
    }
    return cfg;
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to load maintenance config:`, err);
    return { ...CONFIG_DEFAULTS };
  }
}

// ── Partition Management ──────────────────────────────────────

/**
 * Check if the events table is partitioned.
 */
async function isEventsPartitioned(db: Knex): Promise<boolean> {
  try {
    const result = await db.raw(`
      SELECT relkind FROM pg_class
      WHERE relname = 'events'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `);
    return result.rows.length > 0 && result.rows[0].relkind === 'p';
  } catch {
    return false;
  }
}

/**
 * Ensure monthly partitions exist for the next N months.
 * Creates any missing partitions so new events always have a valid partition.
 */
async function ensureFuturePartitions(db: Knex, monthsAhead: number = 3): Promise<number> {
  const now = new Date();
  let created = 0;

  for (let i = 0; i <= monthsAhead; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-indexed

    const nextDate = new Date(year, month + 1, 1);
    const partName = `events_y${year}m${String(month + 1).padStart(2, '0')}`;
    const fromStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const toStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-01`;

    // Check if partition exists
    const exists = await db.raw(`
      SELECT 1 FROM pg_class WHERE relname = ? AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `, [partName]);

    if (exists.rows.length === 0) {
      try {
        await db.raw(`
          CREATE TABLE "${partName}"
          PARTITION OF events
          FOR VALUES FROM ('${fromStr}') TO ('${toStr}')
        `);
        created++;
        console.log(`[${localTimestamp()}] Maintenance: created partition ${partName} (${fromStr} to ${toStr})`);
      } catch (err: any) {
        // Partition might overlap with default or another partition — log but don't fail
        if (!err.message.includes('already exists')) {
          console.warn(`[${localTimestamp()}] Maintenance: could not create partition ${partName}: ${err.message}`);
        }
      }
    }
  }

  return created;
}

/**
 * Drop partitions that are entirely older than the global retention cutoff.
 * Only drops partitions whose end date is before the cutoff.
 * Returns the count of dropped partitions.
 */
async function dropExpiredPartitions(db: Knex, cutoffDate: Date): Promise<{ droppedPartitions: string[]; eventsFreed: number }> {
  const droppedPartitions: string[] = [];
  let eventsFreed = 0;

  // List all child partitions of events
  const partResult = await db.raw(`
    SELECT
      c.relname AS partition_name,
      pg_get_expr(c.relpartbound, c.oid) AS partition_bound
    FROM pg_inherits i
    JOIN pg_class c ON i.inhrelid = c.oid
    JOIN pg_class p ON i.inhparent = p.oid
    WHERE p.relname = 'events'
      AND c.relname != 'events_default'
    ORDER BY c.relname
  `);

  for (const row of partResult.rows) {
    const partName: string = row.partition_name;
    const bound: string = row.partition_bound;

    // Parse the upper bound: FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
    const toMatch = bound.match(/TO\s*\('([^']+)'\)/i);
    if (!toMatch) continue;

    const partEndDate = new Date(toMatch[1]);
    if (isNaN(partEndDate.getTime())) continue;

    // Only drop if the partition's end date is before the cutoff
    if (partEndDate <= cutoffDate) {
      try {
        // Count events before dropping (for logging)
        const countResult = await db.raw(`SELECT COUNT(*) as cnt FROM "${partName}"`);
        const count = Number(countResult.rows[0]?.cnt ?? 0);

        await db.raw(`DROP TABLE "${partName}"`);
        droppedPartitions.push(partName);
        eventsFreed += count;

        console.log(
          `[${localTimestamp()}] Maintenance: dropped partition ${partName} (${count} events, end: ${toMatch[1]})`
        );
      } catch (err: any) {
        console.error(`[${localTimestamp()}] Maintenance: failed to drop partition ${partName}: ${err.message}`);
      }
    }
  }

  return { droppedPartitions, eventsFreed };
}

// ── Main Maintenance Job ───────────────────────────────────────

export async function runMaintenance(db: Knex): Promise<MaintenanceRunResult> {
  const startTime = Date.now();
  const started_at = new Date().toISOString();
  const errors: string[] = [];

  console.log(`[${localTimestamp()}] Maintenance: starting database maintenance run...`);

  const config = await loadMaintenanceConfig(db);
  let totalEventsDeleted = 0;
  let totalScoresDeleted = 0;
  const systemsCleanedList: MaintenanceRunResult['systems_cleaned'] = [];
  let vacuumRan = false;
  let reindexRan = false;

  // ── 0. Partition management (if events table is partitioned) ──
  const partitioned = await isEventsPartitioned(db);
  if (partitioned) {
    try {
      // Ensure future partitions exist (3 months ahead)
      const newParts = await ensureFuturePartitions(db, 3);
      if (newParts > 0) {
        console.log(`[${localTimestamp()}] Maintenance: created ${newParts} new future partition(s)`);
      }

      // Drop partitions that are fully older than the global retention cutoff
      // (Partition-level drops are instant and far more efficient than row-level deletes)
      const globalCutoff = new Date();
      globalCutoff.setDate(globalCutoff.getDate() - config.default_retention_days);

      const { droppedPartitions, eventsFreed } = await dropExpiredPartitions(db, globalCutoff);
      if (droppedPartitions.length > 0) {
        totalEventsDeleted += eventsFreed;
        console.log(
          `[${localTimestamp()}] Maintenance: dropped ${droppedPartitions.length} expired partition(s), ` +
          `freed ~${eventsFreed} events`,
        );
      }
    } catch (err: any) {
      const msg = `Partition management failed: ${err.message}`;
      console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
      errors.push(msg);
    }
  }

  // ── 1. Data Retention Cleanup (per-system row-level deletes) ──
  //    Even with partitioning, per-system custom retention still needs row-level deletes
  //    for events that fall within a partition that shouldn't be fully dropped.
  try {
    const systems = await db('monitored_systems').select('*');

    for (const system of systems) {
      const retentionDays = system.retention_days ?? config.default_retention_days;
      if (retentionDays <= 0) continue; // 0 or negative = keep forever

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      const cutoffIso = cutoffDate.toISOString();

      try {
        // Delete old events + their scores via EventSource abstraction (system-aware)
        const eventSource = getEventSource(system, db);
        const result = await eventSource.deleteOldEvents(system.id, cutoffIso);

        if (result.deleted_events > 0) {
          systemsCleanedList.push({
            system_id: system.id,
            system_name: system.name,
            retention_days: retentionDays,
            events_deleted: result.deleted_events,
          });
          totalEventsDeleted += result.deleted_events;
          totalScoresDeleted += result.deleted_scores;

          console.log(
            `[${localTimestamp()}] Maintenance: ${system.name} — deleted ${result.deleted_events} events ` +
            `and ${result.deleted_scores} scores older than ${retentionDays} days`,
          );
        }
      } catch (err: any) {
        const msg = `Retention cleanup failed for system ${system.name}: ${err.message}`;
        console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
        errors.push(msg);
      }
    }

    // Clean up stale windows whose events have all been deleted.
    // This cascades to meta_results, effective_scores, and findings,
    // preventing stale scores from lingering on the dashboard.
    //
    // IMPORTANT: Only check against PG events table for PostgreSQL-backed
    // systems.  For Elasticsearch-backed systems, events live in ES (not in
    // the PG events table), so the NOT EXISTS check would falsely consider
    // ALL windows as orphaned and delete them.
    try {
      const pgSystemIds = await db('monitored_systems')
        .where(function () {
          this.where('event_source', 'postgresql').orWhereNull('event_source');
        })
        .pluck('id');

      if (pgSystemIds.length > 0) {
        const orphanedWindows = await db('windows')
          .whereIn('system_id', pgSystemIds)
          .whereNotExists(
            db('events')
              .whereRaw(`events.system_id = windows.system_id AND events."timestamp" >= windows.from_ts AND events."timestamp" <= windows.to_ts`)
              .select(db.raw('1')),
          )
          .del();
        if (orphanedWindows > 0) {
          console.log(`[${localTimestamp()}] Maintenance: cleaned up ${orphanedWindows} orphaned analysis windows`);
        }
      }
    } catch (err: any) {
      errors.push(`Orphaned windows cleanup failed: ${err.message}`);
    }

    // Also clean up orphaned message templates with no events.
    // Same caveat: only check PG-backed systems to avoid deleting
    // templates that are linked to Elasticsearch events.
    try {
      const pgSystemIds = await db('monitored_systems')
        .where(function () {
          this.where('event_source', 'postgresql').orWhereNull('event_source');
        })
        .pluck('id');

      if (pgSystemIds.length > 0) {
        const orphanedTemplates = await db('message_templates')
          .whereIn('system_id', pgSystemIds)
          .whereNotExists(
            db('events')
              .whereRaw('events.template_id = message_templates.id')
              .select(db.raw('1')),
          )
          .del();
        if (orphanedTemplates > 0) {
          console.log(`[${localTimestamp()}] Maintenance: cleaned up ${orphanedTemplates} orphaned message templates`);
        }
      }
    } catch (err: any) {
      errors.push(`Orphaned template cleanup failed: ${err.message}`);
    }

    // Clean up expired sessions
    try {
      const expiredSessions = await db('sessions')
        .where('expires_at', '<', new Date().toISOString())
        .del();
      if (expiredSessions > 0) {
        console.log(`[${localTimestamp()}] Maintenance: cleaned up ${expiredSessions} expired sessions`);
      }
    } catch (err: any) {
      // sessions table might not exist yet — ignore
      if (!err.message.includes('does not exist')) {
        errors.push(`Session cleanup failed: ${err.message}`);
      }
    }

    // Clean up old maintenance logs (keep last 100)
    try {
      const oldLogs = await db('maintenance_log')
        .orderBy('started_at', 'desc')
        .offset(100)
        .pluck('id');
      if (oldLogs.length > 0) {
        await db('maintenance_log').whereIn('id', oldLogs).del();
      }
    } catch {
      // maintenance_log table might not exist yet on first run — ignore
    }

  } catch (err: any) {
    const msg = `Data retention cleanup failed: ${err.message}`;
    console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
    errors.push(msg);
  }

  // ── 2. VACUUM ANALYZE ─────────────────────────────────────
  try {
    // VACUUM cannot run inside a transaction, so use raw queries
    const tables = ['events', 'event_scores', 'message_templates', 'findings', 'meta_results', 'windows'];
    for (const table of tables) {
      try {
        await db.raw(`VACUUM ANALYZE ${table}`);
      } catch (err: any) {
        // Some tables might not exist — that's OK
        if (!err.message.includes('does not exist')) {
          errors.push(`VACUUM ANALYZE ${table} failed: ${err.message}`);
        }
      }
    }
    vacuumRan = true;
    console.log(`[${localTimestamp()}] Maintenance: VACUUM ANALYZE completed`);
  } catch (err: any) {
    const msg = `VACUUM ANALYZE failed: ${err.message}`;
    console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
    errors.push(msg);
  }

  // ── 3. REINDEX ────────────────────────────────────────────
  try {
    const indexes = [
      'idx_events_system_ts',
      'idx_events_template',
      'idx_event_scores_event',
      'idx_findings_fingerprint',
      'idx_findings_open_system',
    ];
    for (const idx of indexes) {
      try {
        await db.raw(`REINDEX INDEX CONCURRENTLY ${idx}`);
      } catch (err: any) {
        // Index might not exist — that's OK
        if (!err.message.includes('does not exist')) {
          // REINDEX CONCURRENTLY requires PG 12+; fall back to regular REINDEX
          try {
            await db.raw(`REINDEX INDEX ${idx}`);
          } catch (err2: any) {
            if (!err2.message.includes('does not exist')) {
              errors.push(`REINDEX ${idx} failed: ${err2.message}`);
            }
          }
        }
      }
    }
    reindexRan = true;
    console.log(`[${localTimestamp()}] Maintenance: REINDEX completed`);
  } catch (err: any) {
    const msg = `REINDEX failed: ${err.message}`;
    console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
    errors.push(msg);
  }

  // ── 4. Scheduled Backup ─────────────────────────────────────
  let backupRan = false;
  try {
    const backupCfg = await loadBackupConfig(db);
    if (backupCfg.backup_enabled) {
      // Check if enough time has passed since last backup
      let shouldBackup = true;
      try {
        const lastBackupRow = await db('app_config')
          .where({ key: 'last_backup_at' })
          .first('value');
        if (lastBackupRow) {
          const raw = typeof lastBackupRow.value === 'string'
            ? JSON.parse(lastBackupRow.value)
            : lastBackupRow.value;
          const lastTime = new Date(raw as string).getTime();
          const minInterval = backupCfg.backup_interval_hours * 60 * 60 * 1000;
          if (Date.now() - lastTime < minInterval) {
            shouldBackup = false;
          }
        }
      } catch {
        // No last backup recorded — proceed
      }

      if (shouldBackup) {
        console.log(`[${localTimestamp()}] Maintenance: starting scheduled backup...`);
        const backupResult = await runBackup(db);
        backupRan = backupResult.success;

        if (backupResult.success) {
          // Record last backup time
          await db.raw(`
            INSERT INTO app_config (key, value) VALUES ('last_backup_at', ?::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `, [JSON.stringify(new Date().toISOString())]);

          // Cleanup old backups
          cleanupOldBackups(backupCfg.backup_retention_count);
        } else {
          errors.push(`Scheduled backup failed: ${backupResult.error}`);
        }
      }
    }
  } catch (err: any) {
    const msg = `Backup step failed: ${err.message}`;
    console.error(`[${localTimestamp()}] Maintenance: ${msg}`);
    errors.push(msg);
  }

  // ── 5. Log the run ────────────────────────────────────────
  const finished_at = new Date().toISOString();
  const duration_ms = Date.now() - startTime;

  const result: MaintenanceRunResult = {
    started_at,
    finished_at,
    duration_ms,
    events_deleted: totalEventsDeleted,
    event_scores_deleted: totalScoresDeleted,
    systems_cleaned: systemsCleanedList,
    vacuum_ran: vacuumRan,
    reindex_ran: reindexRan,
    errors,
  };

  try {
    await db('maintenance_log').insert({
      started_at,
      finished_at,
      duration_ms,
      events_deleted: totalEventsDeleted,
      event_scores_deleted: totalScoresDeleted,
      details: JSON.stringify(result),
      status: errors.length > 0 ? 'completed_with_errors' : 'success',
    });
  } catch {
    // maintenance_log table might not exist on first run
    console.warn(`[${localTimestamp()}] Maintenance: could not log run to maintenance_log table`);
  }

  console.log(
    `[${localTimestamp()}] Maintenance: completed in ${duration_ms}ms — ` +
    `${totalEventsDeleted} events deleted, ${totalScoresDeleted} scores deleted, ` +
    `${errors.length} error(s)`,
  );

  return result;
}

// ── Scheduler ──────────────────────────────────────────────────

export function startMaintenanceScheduler(
  db: Knex,
  intervalMs: number = 6 * 60 * 60 * 1000, // default 6 hours
): { stop: () => void } {
  let running = false;

  const timer = setInterval(async () => {
    if (running) {
      console.log(`[${localTimestamp()}] Maintenance: previous run still in progress, skipping.`);
      return;
    }
    running = true;
    try {
      // Re-read interval from config each time (user may have changed it via UI)
      const config = await loadMaintenanceConfig(db);
      // Only run if enough time has passed since last run
      try {
        const lastRun = await db('maintenance_log')
          .orderBy('started_at', 'desc')
          .first('started_at');
        if (lastRun) {
          const lastRunTime = new Date(lastRun.started_at).getTime();
          const minInterval = config.maintenance_interval_hours * 60 * 60 * 1000;
          if (Date.now() - lastRunTime < minInterval) {
            return; // Not enough time has passed
          }
        }
      } catch {
        // maintenance_log might not exist yet — proceed with the run
      }

      await runMaintenance(db);
    } catch (err) {
      console.error(`[${localTimestamp()}] Maintenance scheduler error:`, err);
    } finally {
      running = false;
    }
  }, intervalMs);

  console.log(`[${localTimestamp()}] Maintenance scheduler started (check interval=${intervalMs}ms).`);

  return {
    stop: () => {
      clearInterval(timer);
      console.log(`[${localTimestamp()}] Maintenance scheduler stopped.`);
    },
  };
}
