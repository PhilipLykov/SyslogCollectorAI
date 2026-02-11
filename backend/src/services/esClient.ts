/**
 * Elasticsearch client manager.
 *
 * Maintains a pool of ES Client instances keyed by connection ID.
 * Connection settings are loaded from the `elasticsearch_connections` table
 * and can be updated at runtime via the UI.
 *
 * Credentials are stored as JSON in `credentials_encrypted` — a future
 * enhancement may add symmetric encryption at rest. For now the column
 * is plaintext JSON (still only in PostgreSQL, never exposed to the browser).
 */

import { Client } from '@elastic/elasticsearch';

// ClientOptions is not re-exported from the ESM entry in v9.x;
// infer it from the Client constructor signature instead.
type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;
import type { Knex } from 'knex';
import { getDb } from '../db/index.js';
import { localTimestamp } from '../config/index.js';
import type { ElasticsearchConnection } from '../types/index.js';

// Re-export the type under the alias the routes file uses
export type EsConnectionRow = ElasticsearchConnection;

// ── In-memory client pool ────────────────────────────────────

interface PoolEntry {
  client: Client;
  connRow: ElasticsearchConnection;
  /** ISO timestamp when the client was created / last refreshed. */
  createdAt: string;
}

const clientPool = new Map<string, PoolEntry>();

// ── Helpers ──────────────────────────────────────────────────

/** Parse credentials JSON safely. */
function parseCredentials(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[${localTimestamp()}] ES: failed to parse credentials JSON`);
    return {};
  }
}

/** Build @elastic/elasticsearch ClientOptions from a connection row (or partial). */
function buildClientOptions(conn: Partial<ElasticsearchConnection>): ClientOptions {
  const opts: ClientOptions = {
    node: conn.url,
    maxRetries: conn.max_retries ?? 3,
    requestTimeout: conn.request_timeout_ms ?? 30000,
    tls: {
      rejectUnauthorized: conn.tls_reject_unauthorized ?? true,
    },
  };

  // Custom CA certificate
  if (conn.ca_cert) {
    opts.tls = { ...opts.tls, ca: conn.ca_cert };
  }

  // Authentication
  const creds = parseCredentials(conn.credentials_encrypted);

  switch (conn.auth_type) {
    case 'basic':
      if (creds.username && creds.password) {
        opts.auth = { username: creds.username, password: creds.password };
      }
      break;
    case 'api_key':
      if (creds.api_key) {
        opts.auth = { apiKey: creds.api_key };
      }
      break;
    case 'cloud_id':
      if (creds.cloud_id) {
        opts.cloud = { id: creds.cloud_id };
        if (creds.api_key) {
          opts.auth = { apiKey: creds.api_key };
        } else if (creds.username && creds.password) {
          opts.auth = { username: creds.username, password: creds.password };
        }
      }
      break;
    case 'none':
    default:
      // No auth
      break;
  }

  return opts;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get (or create) an ES Client for the given connection ID.
 * Reads the connection row from PG on first call and caches it.
 *
 * @param connectionId  UUID of the elasticsearch_connections row.
 * @param db            Optional Knex instance (defaults to the global singleton).
 */
export async function getEsClient(connectionId: string, db?: Knex): Promise<Client> {
  const cached = clientPool.get(connectionId);
  if (cached) return cached.client;

  const knex = db ?? getDb();
  const row: ElasticsearchConnection | undefined = await knex('elasticsearch_connections')
    .where({ id: connectionId })
    .first();

  if (!row) {
    throw new Error(`Elasticsearch connection "${connectionId}" not found`);
  }

  const client = new Client(buildClientOptions(row));
  clientPool.set(connectionId, {
    client,
    connRow: row,
    createdAt: new Date().toISOString(),
  });

  // Sanitize URL before logging to prevent credential leakage (OWASP A02)
  let safeUrl = row.url;
  try {
    const u = new URL(row.url);
    if (u.username || u.password) { u.username = '***'; u.password = '***'; }
    safeUrl = u.toString();
  } catch { safeUrl = '<invalid-url>'; }

  console.log(`[${localTimestamp()}] ES: created client for connection "${row.name}" (${safeUrl})`);
  return client;
}

/**
 * Build a temporary (non-cached) ES Client from raw connection settings.
 * Used for testing connections before they are saved.
 */
export function buildTempClient(config: Partial<ElasticsearchConnection>): Client {
  return new Client(buildClientOptions(config));
}

/**
 * Test an Elasticsearch connection by calling the info endpoint.
 *
 * @param client  An existing ES Client instance to test.
 * @returns       Test result with cluster info on success.
 */
export async function testEsConnection(
  client: Client,
): Promise<{ ok: boolean; cluster_name?: string; version?: string; error?: string }> {
  try {
    const info = await client.info();
    return {
      ok: true,
      cluster_name: info.cluster_name,
      version: info.version?.number,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err.message ?? String(err),
    };
  }
}

/**
 * Update the health status of an ES connection in the database.
 */
export async function updateConnectionHealth(
  connectionId: string,
  status: 'unknown' | 'connected' | 'error',
  lastError: string | null,
  db?: Knex,
): Promise<void> {
  const knex = db ?? getDb();
  await knex('elasticsearch_connections')
    .where({ id: connectionId })
    .update({
      status,
      last_error: lastError,
      last_health_check_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
}

/**
 * Destroy (close and remove from cache) a client for the given connection ID.
 * Called when a connection is deleted or its settings change.
 */
export async function destroyEsClient(connectionId: string): Promise<void> {
  const entry = clientPool.get(connectionId);
  if (entry) {
    try {
      await entry.client.close();
    } catch (err) {
      console.warn(`[${localTimestamp()}] ES: error closing client "${connectionId}": ${err}`);
    }
    clientPool.delete(connectionId);
  }
}

/**
 * Close all cached ES clients (used during graceful shutdown).
 */
export async function closeAllEsClients(): Promise<void> {
  const ids = Array.from(clientPool.keys());
  for (const id of ids) {
    await destroyEsClient(id);
  }
}

/**
 * Get a client for a specific monitored system.
 * Reads the system's es_connection_id and returns the corresponding client.
 */
export async function getEsClientForSystem(systemId: string, db?: Knex): Promise<Client> {
  const knex = db ?? getDb();
  const system = await knex('monitored_systems')
    .where({ id: systemId })
    .select('es_connection_id')
    .first();

  if (!system?.es_connection_id) {
    throw new Error(`System "${systemId}" has no Elasticsearch connection configured`);
  }

  return getEsClient(system.es_connection_id, knex);
}
