import type { Knex } from 'knex';

/**
 * Add indexes to support event search, filtering, and tracing.
 *
 * - GIN index on to_tsvector('english', message) for full-text search
 * - B-tree indexes on commonly filtered columns: trace_id, span_id, host, program, severity
 */
export async function up(knex: Knex): Promise<void> {
  // Full-text search GIN index on message column
  // Note: CONCURRENTLY cannot be used inside a transaction (Knex default),
  // so we use regular CREATE INDEX here. This will briefly lock the table during
  // migration — acceptable since migrations run once at deploy time.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_message_fts
    ON events USING gin (to_tsvector('english', message))
  `);

  // B-tree indexes for common filter columns
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_trace_id
    ON events (trace_id) WHERE trace_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_span_id
    ON events (span_id) WHERE span_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_host
    ON events (host)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_program
    ON events (program)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_severity
    ON events (severity)
  `);

  // Index for global time-ordered queries (without system_id filter)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_timestamp
    ON events (timestamp DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_events_message_fts');
  await knex.raw('DROP INDEX IF EXISTS idx_events_trace_id');
  await knex.raw('DROP INDEX IF EXISTS idx_events_span_id');
  await knex.raw('DROP INDEX IF EXISTS idx_events_host');
  await knex.raw('DROP INDEX IF EXISTS idx_events_program');
  await knex.raw('DROP INDEX IF EXISTS idx_events_severity');
  await knex.raw('DROP INDEX IF EXISTS idx_events_timestamp');
}
