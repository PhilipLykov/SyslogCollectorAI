import type { Knex } from 'knex';

/**
 * Add per-system data retention and seed the global default.
 *
 * - monitored_systems.retention_days: NULL means "use global default".
 * - app_config key "default_retention_days": global fallback (90 days).
 * - app_config key "maintenance_interval_hours": how often the cleanup job runs (6 hours).
 */
export async function up(knex: Knex): Promise<void> {
  // Add retention_days column to monitored_systems
  await knex.schema.alterTable('monitored_systems', (t) => {
    t.integer('retention_days').nullable(); // NULL = use global default
  });

  // Seed global defaults into app_config (idempotent via ON CONFLICT)
  await knex.raw(`
    INSERT INTO app_config (key, value)
    VALUES ('default_retention_days', '"90"'),
           ('maintenance_interval_hours', '"6"')
    ON CONFLICT (key) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitored_systems', (t) => {
    t.dropColumn('retention_days');
  });

  await knex('app_config')
    .whereIn('key', ['default_retention_days', 'maintenance_interval_hours'])
    .del();
}
