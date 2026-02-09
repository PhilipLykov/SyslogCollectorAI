import type { Knex } from 'knex';

/**
 * Migration 013 — RAG chat history.
 *
 * Persists every Ask AI Q&A so users can review past conversations
 * across sessions and page reloads.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('rag_history', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('question').notNullable();
    t.text('answer').notNullable();
    t.uuid('system_id').nullable().references('id').inTable('monitored_systems').onDelete('SET NULL');
    t.text('system_name').nullable();            // denormalized so history survives system deletion
    t.timestamp('from_filter').nullable();        // user-supplied time filter (if any)
    t.timestamp('to_filter').nullable();
    t.integer('context_used').notNullable().defaultTo(0);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rag_history_created
    ON rag_history (created_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rag_history_system
    ON rag_history (system_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_rag_history_system');
  await knex.raw('DROP INDEX IF EXISTS idx_rag_history_created');
  await knex.schema.dropTableIfExists('rag_history');
}
