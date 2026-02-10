import type { Knex } from 'knex';

/**
 * Migration 020: Create roles and role_permissions tables.
 *
 * Moves role definitions from hardcoded code into the database for
 * GUI-configurable granular permission control.
 */
export async function up(knex: Knex): Promise<void> {
  // ── roles table ─────────────────────────────────────────────
  await knex.schema.createTable('roles', (t) => {
    t.string('name', 64).primary();                 // e.g. 'administrator'
    t.string('display_name', 128).notNullable();     // e.g. 'Administrator'
    t.text('description').defaultTo('');
    t.boolean('is_system').defaultTo(false);          // system roles can't be deleted
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // ── role_permissions table ──────────────────────────────────
  await knex.schema.createTable('role_permissions', (t) => {
    t.string('role_name', 64).notNullable()
      .references('name').inTable('roles')
      .onDelete('CASCADE').onUpdate('CASCADE');
    t.string('permission', 64).notNullable();        // e.g. 'dashboard:view'
    t.primary(['role_name', 'permission']);
  });

  // ── Seed the three default (system) roles ───────────────────
  await knex('roles').insert([
    {
      name: 'administrator',
      display_name: 'Administrator',
      description: 'Full access to all features and settings.',
      is_system: true,
    },
    {
      name: 'auditor',
      display_name: 'Auditor',
      description: 'Read-only access to all data, audit log, and compliance exports.',
      is_system: true,
    },
    {
      name: 'monitoring_agent',
      display_name: 'Monitoring Agent',
      description: 'Dashboard and event viewing, event acknowledgment, and RAG queries.',
      is_system: true,
    },
  ]);

  // ── Seed permissions for each role ──────────────────────────
  const adminPerms = [
    'dashboard:view',
    'events:view',
    'events:acknowledge',
    'systems:view',
    'systems:manage',
    'ai_config:view',
    'ai_config:manage',
    'notifications:view',
    'notifications:manage',
    'database:view',
    'database:manage',
    'privacy:view',
    'privacy:manage',
    'users:manage',
    'roles:manage',
    'api_keys:manage',
    'audit:view',
    'audit:export',
    'rag:use',
    'ai_usage:view',
    'compliance:export',
  ];

  const auditorPerms = [
    'dashboard:view',
    'events:view',
    'systems:view',
    'ai_config:view',
    'notifications:view',
    'database:view',
    'privacy:view',
    'audit:view',
    'audit:export',
    'rag:use',
    'ai_usage:view',
    'compliance:export',
  ];

  const agentPerms = [
    'dashboard:view',
    'events:view',
    'events:acknowledge',
    'systems:view',
    'rag:use',
    'ai_usage:view',
  ];

  const permRows = [
    ...adminPerms.map((p) => ({ role_name: 'administrator', permission: p })),
    ...auditorPerms.map((p) => ({ role_name: 'auditor', permission: p })),
    ...agentPerms.map((p) => ({ role_name: 'monitoring_agent', permission: p })),
  ];

  // Insert in batches to avoid parameter limits
  for (let i = 0; i < permRows.length; i += 50) {
    await knex('role_permissions').insert(permRows.slice(i, i + 50));
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('roles');
}
