import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // discovery_buffer: lightweight staging for unmatched events
  await knex.schema.createTable('discovery_buffer', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('host', 255).nullable();
    table.string('source_ip', 45).nullable();
    table.string('program', 255).nullable();
    table.string('facility', 64).nullable();
    table.string('severity', 32).nullable();
    table.text('message_sample').nullable();
    table.timestamp('received_at', { useTz: true }).defaultTo(knex.fn.now());
    table.jsonb('raw_fields').nullable();
    table.index(['host', 'source_ip', 'program'], 'idx_discovery_buffer_grouping');
    table.index(['received_at'], 'idx_discovery_buffer_received_at');
  });

  // discovery_suggestions: computed suggestions from the grouping engine
  await knex.schema.createTable('discovery_suggestions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('group_key', 512).notNullable().unique();
    table.string('suggested_name', 255).notNullable();
    table.string('host_pattern', 255).nullable();
    table.string('ip_pattern', 45).nullable();
    table.jsonb('program_patterns').nullable();
    table.jsonb('sample_messages').nullable();
    table.integer('event_count').notNullable().defaultTo(0);
    table.timestamp('first_seen_at', { useTz: true }).notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable();
    table.string('status', 32).notNullable().defaultTo('pending');
    table.timestamp('dismissed_until', { useTz: true }).nullable();
    table.uuid('merge_target_id').nullable().references('id').inTable('monitored_systems').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    table.index(['status'], 'idx_discovery_suggestions_status');
  });

  console.log('[Migration 031] Created discovery_buffer and discovery_suggestions tables');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('discovery_suggestions');
  await knex.schema.dropTableIfExists('discovery_buffer');
}
