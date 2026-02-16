import type { Knex } from 'knex';

/**
 * Migration 025 — Performance Optimization
 *
 * 1. Add `scored_at` column to `events` — eliminates the expensive LEFT JOIN
 *    in getUnscoredEvents and allows skipping zero-score rows in event_scores.
 * 2. Add functional index on events((id::text)) for efficient JOINs with event_scores.
 * 3. Add missing indexes on event_scores, windows, findings.
 * 4. Backfill scored_at for events that already have scores.
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. Add scored_at column to events ───────────────────────
  // On partitioned tables, ALTER TABLE on the parent propagates to all partitions.
  const hasScoredAt = await knex.raw(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'scored_at' AND table_schema = 'public'
  `);
  if (hasScoredAt.rows.length === 0) {
    await knex.raw(`ALTER TABLE events ADD COLUMN scored_at TIMESTAMPTZ`);
    console.log('[Migration 025] Added scored_at column to events');
  }

  // ── 2. Partial index for unscored events (hot path: scoring pipeline) ──
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_unscored
      ON events (system_id, "timestamp")
      WHERE scored_at IS NULL AND acknowledged_at IS NULL
    `);
    console.log('[Migration 025] Created idx_events_unscored');
  } catch (err: any) {
    // CONCURRENTLY may fail inside a transaction; fall back
    try {
      await knex.raw(`
        CREATE INDEX IF NOT EXISTS idx_events_unscored
        ON events (system_id, "timestamp")
        WHERE scored_at IS NULL AND acknowledged_at IS NULL
      `);
      console.log('[Migration 025] Created idx_events_unscored (non-concurrent)');
    } catch { console.warn('[Migration 025] idx_events_unscored already exists or failed'); }
  }

  // ── 3. Functional index for id::text JOINs ──────────────────
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_id_text
      ON events ((id::text))
    `);
    console.log('[Migration 025] Created idx_events_id_text');
  } catch (err: any) {
    try {
      await knex.raw(`
        CREATE INDEX IF NOT EXISTS idx_events_id_text
        ON events ((id::text))
      `);
      console.log('[Migration 025] Created idx_events_id_text (non-concurrent)');
    } catch { console.warn('[Migration 025] idx_events_id_text already exists or failed'); }
  }

  // ── 4. Missing index: event_scores(event_id) for DELETE operations ──
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_scores_event_id
      ON event_scores (event_id)
    `);
    console.log('[Migration 025] Created idx_event_scores_event_id');
  } catch {
    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_event_scores_event_id ON event_scores (event_id)`);
    } catch { console.warn('[Migration 025] idx_event_scores_event_id failed'); }
  }

  // ── 5. Covering index for MAX(score) aggregation pattern ────
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_scores_eid_crit_score
      ON event_scores (event_id, criterion_id, score DESC)
    `);
    console.log('[Migration 025] Created idx_event_scores_eid_crit_score');
  } catch {
    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_event_scores_eid_crit_score ON event_scores (event_id, criterion_id, score DESC)`);
    } catch { console.warn('[Migration 025] idx_event_scores_eid_crit_score failed'); }
  }

  // ── 6. Windows: system + to_ts for dashboard and recalc queries ──
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_windows_system_to_ts
      ON windows (system_id, to_ts DESC)
    `);
    console.log('[Migration 025] Created idx_windows_system_to_ts');
  } catch {
    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_windows_system_to_ts ON windows (system_id, to_ts DESC)`);
    } catch { console.warn('[Migration 025] idx_windows_system_to_ts failed'); }
  }

  // ── 7. Findings: resolved detection ─────────────────────────
  try {
    await knex.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_findings_system_resolved
      ON findings (system_id, resolved_at DESC)
      WHERE status = 'resolved'
    `);
    console.log('[Migration 025] Created idx_findings_system_resolved');
  } catch {
    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_findings_system_resolved ON findings (system_id, resolved_at DESC) WHERE status = 'resolved'`);
    } catch { console.warn('[Migration 025] idx_findings_system_resolved failed'); }
  }

  // ── 8. Backfill scored_at for events that already have event_scores ──
  // This marks existing scored events so the pipeline doesn't re-process them.
  // Uses batched updates to avoid long locks.
  try {
    const batchSize = 10000;
    let totalBackfilled = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await knex.raw(`
        UPDATE events
        SET scored_at = NOW()
        WHERE id IN (
          SELECT DISTINCT e.id
          FROM events e
          JOIN event_scores es ON es.event_id = e.id::text
          WHERE e.scored_at IS NULL
          LIMIT ${batchSize}
        )
      `);
      const affected = result.rowCount ?? 0;
      totalBackfilled += affected;
      hasMore = affected >= batchSize;
    }
    console.log(`[Migration 025] Backfilled scored_at for ${totalBackfilled} events`);
  } catch (err: any) {
    console.warn(`[Migration 025] scored_at backfill failed (non-critical): ${err.message}`);
  }

  // ── 9. Delete zero-score event_scores rows (reclaim space) ──
  // Rows where ALL 6 criteria scored 0 are no longer needed since scored_at
  // tracks the "processed" state. Keep rows with score > 0.
  try {
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await knex.raw(`
        DELETE FROM event_scores
        WHERE id IN (
          SELECT es.id
          FROM event_scores es
          WHERE es.score = 0 AND es.score_type = 'event'
          LIMIT 50000
        )
      `);
      const affected = result.rowCount ?? 0;
      totalDeleted += affected;
      hasMore = affected >= 50000;
    }
    console.log(`[Migration 025] Deleted ${totalDeleted} zero-score event_scores rows`);
  } catch (err: any) {
    console.warn(`[Migration 025] Zero-score cleanup failed (non-critical): ${err.message}`);
  }
}

export async function down(knex: Knex): Promise<void> {
  // Drop indexes
  await knex.raw('DROP INDEX IF EXISTS idx_events_unscored');
  await knex.raw('DROP INDEX IF EXISTS idx_events_id_text');
  await knex.raw('DROP INDEX IF EXISTS idx_event_scores_event_id');
  await knex.raw('DROP INDEX IF EXISTS idx_event_scores_eid_crit_score');
  await knex.raw('DROP INDEX IF EXISTS idx_windows_system_to_ts');
  await knex.raw('DROP INDEX IF EXISTS idx_findings_system_resolved');

  // Drop scored_at column
  const hasScoredAt = await knex.raw(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'scored_at' AND table_schema = 'public'
  `);
  if (hasScoredAt.rows.length > 0) {
    await knex.raw('ALTER TABLE events DROP COLUMN scored_at');
  }
}
