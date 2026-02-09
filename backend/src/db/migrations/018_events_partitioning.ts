import type { Knex } from 'knex';

/**
 * Migration 018 — Convert events table to monthly range partitions.
 *
 * PostgreSQL table partitioning by RANGE on the `timestamp` column enables:
 *  - Partition pruning: queries with timestamp filters skip irrelevant months
 *  - Instant old-data cleanup: DROP a partition instead of slow DELETE
 *  - Better index locality: smaller per-partition indexes fit in memory
 *
 * IMPORTANT: This migration moves data from the existing events table into
 * a partitioned table. It should be run during a maintenance window.
 * Take a backup before running this migration.
 *
 * Key changes:
 *  - Primary key becomes (id, timestamp) — required for partitioned tables
 *  - FK from event_scores → events is dropped (application handles integrity)
 *  - All indexes are recreated on the partitioned table
 *  - Monthly partitions are created for existing data + 3 months ahead
 *  - A default partition catches any out-of-range timestamps
 */
export const config = { transaction: false }; // Cannot run in transaction

export async function up(knex: Knex): Promise<void> {
  // ── Guard: check if already partitioned ────────────────────
  const partCheck = await knex.raw(`
    SELECT relkind FROM pg_class
    WHERE relname = 'events' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  `);
  if (partCheck.rows.length > 0 && partCheck.rows[0].relkind === 'p') {
    // Already a partitioned table — skip
    console.log('[Migration 018] events table is already partitioned, skipping.');
    return;
  }

  // ── 1. Determine date range for partitions ─────────────────
  const rangeResult = await knex.raw(`
    SELECT
      COALESCE(MIN(timestamp), NOW() - INTERVAL '1 month') AS min_ts,
      COALESCE(MAX(timestamp), NOW()) AS max_ts,
      COUNT(*) AS total_rows
    FROM events
  `);
  const { min_ts, max_ts, total_rows } = rangeResult.rows[0];
  const totalRows = Number(total_rows);

  console.log(`[Migration 018] Events table has ${totalRows} rows (${min_ts} to ${max_ts})`);

  // ── 2. Drop FK from event_scores → events ──────────────────
  //    (Partitioned tables in PG require PK to include partition key,
  //     so the FK from event_scores(event_id) → events(id) won't work.)
  try {
    // Find the FK constraint name dynamically
    const fkResult = await knex.raw(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'event_scores'::regclass
        AND confrelid = 'events'::regclass
        AND contype = 'f'
    `);
    for (const row of fkResult.rows) {
      await knex.raw(`ALTER TABLE event_scores DROP CONSTRAINT IF EXISTS "${row.conname}"`);
      console.log(`[Migration 018] Dropped FK constraint: ${row.conname}`);
    }
  } catch (err: any) {
    console.warn(`[Migration 018] Could not drop event_scores FK: ${err.message}`);
  }

  // ── 3. Drop all indexes on events (they'll be recreated) ───
  const indexResult = await knex.raw(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'events' AND schemaname = 'public'
      AND indexname NOT LIKE 'events_pkey'
  `);
  for (const row of indexResult.rows) {
    await knex.raw(`DROP INDEX IF EXISTS "${row.indexname}"`);
  }

  // ── 4. Drop all FK constraints FROM events TO other tables ──
  const eventFks = await knex.raw(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'events'::regclass AND contype = 'f'
  `);
  for (const row of eventFks.rows) {
    await knex.raw(`ALTER TABLE events DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    console.log(`[Migration 018] Dropped events FK: ${row.conname}`);
  }

  // ── 5. Drop PK on events ──────────────────────────────────
  try {
    await knex.raw(`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey`);
  } catch {
    // PK might have a different name
    const pkResult = await knex.raw(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'events'::regclass AND contype = 'p'
    `);
    for (const row of pkResult.rows) {
      await knex.raw(`ALTER TABLE events DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }
  }

  // ── 6. Rename old table ───────────────────────────────────
  await knex.raw(`ALTER TABLE events RENAME TO events_old`);
  console.log('[Migration 018] Renamed events → events_old');

  // ── 7. Create partitioned events table ─────────────────────
  await knex.raw(`
    CREATE TABLE events (
      id UUID NOT NULL,
      system_id UUID NOT NULL,
      log_source_id UUID NOT NULL,
      connector_id UUID,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "timestamp" TIMESTAMPTZ NOT NULL,
      message TEXT NOT NULL,
      severity VARCHAR(32),
      host VARCHAR(255),
      source_ip VARCHAR(45),
      service VARCHAR(255),
      facility VARCHAR(64),
      program VARCHAR(255),
      trace_id VARCHAR(128),
      span_id VARCHAR(128),
      raw JSONB,
      normalized_hash VARCHAR(128) NOT NULL,
      external_id VARCHAR(255),
      template_id UUID,
      acknowledged_at TIMESTAMPTZ,
      PRIMARY KEY (id, "timestamp")
    ) PARTITION BY RANGE ("timestamp")
  `);
  console.log('[Migration 018] Created partitioned events table');

  // ── 8. Create monthly partitions ──────────────────────────
  const minDate = new Date(min_ts);
  const maxDate = new Date(max_ts);

  // Start from the first day of the month containing min_ts
  const startYear = minDate.getFullYear();
  const startMonth = minDate.getMonth(); // 0-indexed

  // End 3 months after the month containing max_ts
  const endDate = new Date(maxDate);
  endDate.setMonth(endDate.getMonth() + 4);
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth();

  let partCount = 0;
  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const fromYear = year;
    const fromMonth = month;
    const toMonth = month + 1;
    let toYear = year;
    let actualToMonth = toMonth;

    if (toMonth > 11) {
      actualToMonth = 0;
      toYear = year + 1;
    }

    const partName = `events_y${fromYear}m${String(fromMonth + 1).padStart(2, '0')}`;
    const fromStr = `${fromYear}-${String(fromMonth + 1).padStart(2, '0')}-01`;
    const toStr = `${toYear}-${String(actualToMonth + 1).padStart(2, '0')}-01`;

    await knex.raw(`
      CREATE TABLE IF NOT EXISTS "${partName}"
      PARTITION OF events
      FOR VALUES FROM ('${fromStr}') TO ('${toStr}')
    `);
    partCount++;

    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  // Default partition for any out-of-range timestamps
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS events_default
    PARTITION OF events DEFAULT
  `);

  console.log(`[Migration 018] Created ${partCount} monthly partitions + 1 default`);

  // ── 9. Copy data ────────────────────────────────────────────
  if (totalRows > 0) {
    console.log(`[Migration 018] Copying ${totalRows} rows from events_old...`);

    // PostgreSQL's partition routing handles inserting into the correct partition automatically
    await knex.raw(`
      INSERT INTO events
      SELECT * FROM events_old
    `);

    console.log(`[Migration 018] Copied ${totalRows} rows`);
  }

  // ── 10. Recreate indexes on the partitioned table ──────────
  //     (PostgreSQL auto-creates these on each partition)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_system_ts
    ON events (system_id, "timestamp")
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_normalized_hash_ts
    ON events (normalized_hash, "timestamp")
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_message_fts
    ON events USING gin (to_tsvector('english', message))
  `);

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

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_timestamp
    ON events ("timestamp" DESC)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_source_ip
    ON events (source_ip) WHERE source_ip IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_template
    ON events (template_id) WHERE template_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_unacked
    ON events (acknowledged_at) WHERE acknowledged_at IS NULL
  `);

  // Connector idempotency (unique per partition includes timestamp)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_connector_external
    ON events (connector_id, external_id, "timestamp")
    WHERE connector_id IS NOT NULL AND external_id IS NOT NULL
  `);

  // Index on id for efficient JOINs (since PK is now (id, timestamp))
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_id
    ON events (id)
  `);

  console.log('[Migration 018] Recreated all indexes');

  // ── 11. Drop old table ────────────────────────────────────
  await knex.raw(`DROP TABLE events_old`);
  console.log('[Migration 018] Dropped events_old');

  // ── 12. Record partitioning flag ──────────────────────────
  await knex.raw(`
    INSERT INTO app_config (key, value)
    VALUES ('events_partitioned', '"true"'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = '"true"'::jsonb
  `);

  console.log('[Migration 018] ✓ Events table partitioning complete');
}

export async function down(knex: Knex): Promise<void> {
  // Check if events is actually partitioned
  const partCheck = await knex.raw(`
    SELECT relkind FROM pg_class
    WHERE relname = 'events' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  `);
  if (partCheck.rows.length === 0 || partCheck.rows[0].relkind !== 'p') {
    console.log('[Migration 018 down] events table is not partitioned, skipping.');
    return;
  }

  // ── 1. Create regular events table ────────────────────────
  await knex.raw(`
    CREATE TABLE events_regular (
      id UUID NOT NULL PRIMARY KEY,
      system_id UUID NOT NULL,
      log_source_id UUID NOT NULL,
      connector_id UUID,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "timestamp" TIMESTAMPTZ NOT NULL,
      message TEXT NOT NULL,
      severity VARCHAR(32),
      host VARCHAR(255),
      source_ip VARCHAR(45),
      service VARCHAR(255),
      facility VARCHAR(64),
      program VARCHAR(255),
      trace_id VARCHAR(128),
      span_id VARCHAR(128),
      raw JSONB,
      normalized_hash VARCHAR(128) NOT NULL,
      external_id VARCHAR(255),
      template_id UUID,
      acknowledged_at TIMESTAMPTZ
    )
  `);

  // ── 2. Copy data ──────────────────────────────────────────
  await knex.raw(`INSERT INTO events_regular SELECT * FROM events`);

  // ── 3. Drop partitioned table (cascades partitions) ───────
  await knex.raw(`DROP TABLE events CASCADE`);

  // ── 4. Rename ─────────────────────────────────────────────
  await knex.raw(`ALTER TABLE events_regular RENAME TO events`);

  // ── 5. Recreate FKs ──────────────────────────────────────
  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_system_id_foreign
    FOREIGN KEY (system_id) REFERENCES monitored_systems(id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_log_source_id_foreign
    FOREIGN KEY (log_source_id) REFERENCES log_sources(id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_template_id_foreign
    FOREIGN KEY (template_id) REFERENCES message_templates(id) ON DELETE SET NULL
  `);

  // ── 6. Recreate event_scores FK ───────────────────────────
  await knex.raw(`
    ALTER TABLE event_scores
    ADD CONSTRAINT event_scores_event_id_foreign
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  `);

  // ── 7. Recreate indexes ──────────────────────────────────
  await knex.raw(`CREATE INDEX idx_events_system_ts ON events (system_id, "timestamp")`);
  await knex.raw(`CREATE INDEX idx_events_normalized_hash_ts ON events (normalized_hash, "timestamp")`);
  await knex.raw(`CREATE INDEX idx_events_message_fts ON events USING gin (to_tsvector('english', message))`);
  await knex.raw(`CREATE INDEX idx_events_trace_id ON events (trace_id) WHERE trace_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_events_span_id ON events (span_id) WHERE span_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_events_host ON events (host)`);
  await knex.raw(`CREATE INDEX idx_events_program ON events (program)`);
  await knex.raw(`CREATE INDEX idx_events_severity ON events (severity)`);
  await knex.raw(`CREATE INDEX idx_events_timestamp ON events ("timestamp" DESC)`);
  await knex.raw(`CREATE INDEX idx_events_source_ip ON events (source_ip) WHERE source_ip IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_events_template ON events (template_id) WHERE template_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_events_unacked ON events (acknowledged_at) WHERE acknowledged_at IS NULL`);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_events_connector_external
    ON events (connector_id, external_id) WHERE connector_id IS NOT NULL AND external_id IS NOT NULL
  `);

  // ── 8. Remove flag ────────────────────────────────────────
  await knex('app_config').where({ key: 'events_partitioned' }).del();

  console.log('[Migration 018 down] Events table reverted to regular table');
}
