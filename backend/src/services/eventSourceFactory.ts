/**
 * Factory for obtaining the correct EventSource implementation
 * based on the monitored system's configuration.
 *
 * - PgEventSource  → default; events stored in PostgreSQL
 * - EsEventSource  → events read from Elasticsearch, metadata in PG
 */

import type { Knex } from 'knex';
import type { EventSource } from './EventSource.js';
import { PgEventSource } from './PgEventSource.js';
import { EsEventSource } from './EsEventSource.js';
import type { EsSystemConfig } from '../types/index.js';
import { localTimestamp } from '../config/index.js';

/** Minimal system shape — avoids importing the full MonitoredSystem type. */
interface SystemLike {
  id?: string;
  event_source?: string;
  es_config?: Record<string, unknown> | null;
  es_connection_id?: string | null;
}

/**
 * Return the appropriate EventSource for a given system.
 *
 * @param system  The monitored system row (may include `event_source`).
 * @param db      Optional Knex instance (defaults to the global singleton).
 */
export function getEventSource(system?: SystemLike | null, db?: Knex): EventSource {
  if (system?.event_source === 'elasticsearch') {
    if (!system.id || !system.es_connection_id || !system.es_config) {
      console.error(
        `[${localTimestamp()}] EventSource: system "${system.id ?? '?'}" is configured ` +
        `for Elasticsearch but missing required fields (es_connection_id=${!!system.es_connection_id}, ` +
        `es_config=${!!system.es_config}). Falling back to PgEventSource — this is likely a misconfiguration.`,
      );
      return new PgEventSource(db);
    }

    // Validate that es_config has the required index_pattern
    const cfg = system.es_config as unknown as EsSystemConfig;
    if (!cfg.index_pattern) {
      console.error(
        `[${localTimestamp()}] EventSource: system "${system.id}" has es_config ` +
        `without index_pattern. Falling back to PgEventSource.`,
      );
      return new PgEventSource(db);
    }

    return new EsEventSource(
      system.id,
      system.es_connection_id,
      cfg,
      db,
    );
  }
  return new PgEventSource(db);
}

/** Convenience: get the default PgEventSource (no system context needed). */
export function getDefaultEventSource(db?: Knex): EventSource {
  return new PgEventSource(db);
}
