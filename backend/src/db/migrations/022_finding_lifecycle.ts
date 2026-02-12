import type { Knex } from 'knex';

/**
 * Migration 022 — Finding Lifecycle Enhancements
 *
 * 1. Add `resolution_evidence` (TEXT) — LLM's explanation for resolving a finding.
 * 2. Add `reopen_count` (INTEGER) — how many times a resolved finding was reopened.
 * 3. Add `is_flapping` (BOOLEAN) — flagged when reopen_count >= flapping threshold.
 * 4. Normalize existing event severity aliases to canonical forms.
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. New columns on findings ──────────────────────────────
  const hasResolutionEvidence = await knex.schema.hasColumn('findings', 'resolution_evidence');
  if (!hasResolutionEvidence) {
    await knex.schema.alterTable('findings', (t) => {
      t.text('resolution_evidence').nullable().defaultTo(null);
    });
  }

  const hasReopenCount = await knex.schema.hasColumn('findings', 'reopen_count');
  if (!hasReopenCount) {
    await knex.schema.alterTable('findings', (t) => {
      t.integer('reopen_count').notNullable().defaultTo(0);
    });
  }

  const hasIsFlapping = await knex.schema.hasColumn('findings', 'is_flapping');
  if (!hasIsFlapping) {
    await knex.schema.alterTable('findings', (t) => {
      t.boolean('is_flapping').notNullable().defaultTo(false);
    });
  }

  // ── 2. Normalize existing severity aliases in events table ──
  // Map non-canonical syslog severity names to their canonical forms.
  // Uses case-insensitive matching (LOWER) to catch any casing variant
  // (e.g. "Err", "ERR", "err" all → "error").
  const severityUpdates: [string, string[]][] = [
    ['error',     ['err']],
    ['warning',   ['warn']],
    ['critical',  ['crit', 'fatal']],
    ['emergency', ['emerg', 'panic']],
    ['info',      ['informational', 'information']],
    ['debug',     ['trace', 'verbose']],
  ];

  for (const [canonical, aliases] of severityUpdates) {
    await knex('events')
      .whereRaw('LOWER(severity) IN (' + aliases.map(() => '?').join(', ') + ')', aliases)
      .update({ severity: canonical });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasResolutionEvidence = await knex.schema.hasColumn('findings', 'resolution_evidence');
  if (hasResolutionEvidence) {
    await knex.schema.alterTable('findings', (t) => {
      t.dropColumn('resolution_evidence');
    });
  }

  const hasReopenCount = await knex.schema.hasColumn('findings', 'reopen_count');
  if (hasReopenCount) {
    await knex.schema.alterTable('findings', (t) => {
      t.dropColumn('reopen_count');
    });
  }

  const hasIsFlapping = await knex.schema.hasColumn('findings', 'is_flapping');
  if (hasIsFlapping) {
    await knex.schema.alterTable('findings', (t) => {
      t.dropColumn('is_flapping');
    });
  }

  // Note: severity alias normalization is not reversed — the canonical forms are correct.
}
