import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitored_systems', (table) => {
    table.string('tz_name', 64).nullable().defaultTo(null);
  });
  console.log('[Migration 030] Added tz_name column to monitored_systems');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitored_systems', (table) => {
    table.dropColumn('tz_name');
  });
}
