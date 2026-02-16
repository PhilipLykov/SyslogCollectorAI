import type { Knex } from 'knex';

/**
 * Migration 026 — ES Event Metadata enhancements
 *
 * 1. `scored_at` — tracks which ES events have been processed by the scoring
 *    pipeline, preventing infinite re-fetch loops (see migration 025).
 * 2. `event_timestamp` — stores the original ES event timestamp so that
 *    window-scoped queries (recalcEffectiveScores, meta-analysis) can filter
 *    ES events by time without querying Elasticsearch.
 */
export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('es_event_metadata');
  if (!hasTable) {
    console.log('[Migration 026] es_event_metadata table does not exist — skipping (ES not configured)');
    return;
  }

  // ── 1. Add scored_at column ────────────────────────────────────
  const hasScoredAt = await knex.schema.hasColumn('es_event_metadata', 'scored_at');
  if (!hasScoredAt) {
    await knex.schema.alterTable('es_event_metadata', (t) => {
      t.timestamp('scored_at', { useTz: true }).nullable();
    });
    console.log('[Migration 026] Added scored_at to es_event_metadata');
  }

  // ── 2. Add event_timestamp column ──────────────────────────────
  const hasEventTs = await knex.schema.hasColumn('es_event_metadata', 'event_timestamp');
  if (!hasEventTs) {
    await knex.schema.alterTable('es_event_metadata', (t) => {
      t.timestamp('event_timestamp', { useTz: true }).nullable();
    });
    console.log('[Migration 026] Added event_timestamp to es_event_metadata');
  }

  // ── 3. Index for unscored ES events (hot path: scoring pipeline) ──
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_es_meta_unscored
    ON es_event_metadata (system_id)
    WHERE scored_at IS NULL AND acknowledged_at IS NULL
  `);
  console.log('[Migration 026] Created idx_es_meta_unscored');

  // ── 4. Index for window-scoped queries (event_timestamp range) ──
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_es_meta_system_ts
    ON es_event_metadata (system_id, event_timestamp)
  `);
  console.log('[Migration 026] Created idx_es_meta_system_ts');

  // ── 5. Backfill scored_at for ES events that already have event_scores ──
  try {
    const result = await knex.raw(`
      UPDATE es_event_metadata em
      SET scored_at = NOW()
      WHERE em.scored_at IS NULL
        AND EXISTS (
          SELECT 1 FROM event_scores es
          WHERE es.event_id = em.es_event_id
        )
    `);
    const affected = result.rowCount ?? 0;
    if (affected > 0) {
      console.log(`[Migration 026] Backfilled scored_at for ${affected} ES event metadata rows`);
    }
  } catch (err: any) {
    console.warn(`[Migration 026] scored_at backfill failed (non-critical): ${err.message}`);
  }

  console.log('[Migration 026] ES event metadata migration complete');
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('es_event_metadata');
  if (!hasTable) return;

  await knex.raw('DROP INDEX IF EXISTS idx_es_meta_unscored');
  await knex.raw('DROP INDEX IF EXISTS idx_es_meta_system_ts');

  for (const col of ['scored_at', 'event_timestamp']) {
    const hasCol = await knex.schema.hasColumn('es_event_metadata', col);
    if (hasCol) {
      await knex.schema.alterTable('es_event_metadata', (t) => {
        t.dropColumn(col);
      });
    }
  }
}
