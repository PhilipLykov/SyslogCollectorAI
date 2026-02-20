import type { Knex } from 'knex';

/**
 * Migration 029 — Ingestion deduplication unique index.
 *
 * Adds a UNIQUE index on (normalized_hash, timestamp) to the partitioned
 * `events` table, enabling ON CONFLICT dedup at ingestion time.
 * The old non-unique index `idx_events_normalized_hash_ts` is dropped
 * since the unique index serves the same purpose.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop old non-unique index
  await knex.raw('DROP INDEX IF EXISTS idx_events_normalized_hash_ts');
  console.log('[Migration 029] Dropped old idx_events_normalized_hash_ts');

  // Create unique index for dedup (timestamp is partition key, so allowed)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup
    ON events (normalized_hash, "timestamp")
  `);
  console.log('[Migration 029] Created unique idx_events_dedup');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_events_dedup');
  // Restore old non-unique index
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_normalized_hash_ts
    ON events (normalized_hash, "timestamp")
  `);
}
