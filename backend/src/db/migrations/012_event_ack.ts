import type { Knex } from 'knex';

/**
 * Migration 012 — Event acknowledgement support.
 *
 * Adds `acknowledged_at` column to `events` so users can bulk-acknowledge
 * events for a time range / system. Acknowledged events are excluded from
 * LLM scoring and optionally annotated in meta-analysis.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('events', (t) => {
    t.timestamp('acknowledged_at').nullable().defaultTo(null);
  });

  // Partial index: efficiently find un-acknowledged events (used by scoring job)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_unacked
    ON events (acknowledged_at) WHERE acknowledged_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_events_unacked');
  await knex.schema.alterTable('events', (t) => {
    t.dropColumn('acknowledged_at');
  });
}
