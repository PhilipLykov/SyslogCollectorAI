import type { Knex } from 'knex';

/**
 * Add source_ip column to events table for storing the IP address
 * of the host that generated the log event.
 */
export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('events', 'source_ip');
  if (!hasColumn) {
    await knex.schema.alterTable('events', (t) => {
      t.string('source_ip', 45).nullable(); // IPv4 or IPv6 (max 45 chars)
    });

    // Index for filtering by source IP
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_events_source_ip
      ON events (source_ip)
      WHERE source_ip IS NOT NULL
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_events_source_ip');
  const hasColumn = await knex.schema.hasColumn('events', 'source_ip');
  if (hasColumn) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('source_ip');
    });
  }
}
