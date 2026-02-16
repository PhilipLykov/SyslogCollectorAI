/**
 * Elasticsearch connection management API routes.
 *
 * Provides:
 *   - CRUD for elasticsearch_connections
 *   - Test connection (ping + info)
 *   - List indices / aliases
 *   - Preview index data (sample docs)
 *   - Get index field mapping (for auto-detect in system config)
 *   - GET /api/v1/database/info — PG connection info + ES connection summary
 */

import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import {
  getEsClient,
  buildTempClient,
  testEsConnection,
  updateConnectionHealth,
  destroyEsClient,
  type EsConnectionRow,
} from '../../services/esClient.js';

export async function registerElasticsearchRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── List all ES connections ──────────────────────────────────
  app.get(
    '/api/v1/elasticsearch/connections',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_VIEW) },
    async (_request, reply) => {
      const rows = await db('elasticsearch_connections')
        .orderBy('name')
        .select(
          'id', 'name', 'url', 'auth_type',
          'tls_reject_unauthorized', 'request_timeout_ms', 'max_retries',
          'pool_max_connections', 'is_default', 'status', 'last_error',
          'last_health_check_at', 'created_at', 'updated_at',
        );
      // Never return credentials to the frontend
      return reply.send(rows);
    },
  );

  // ── Get single ES connection ─────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/elasticsearch/connections/:id',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_VIEW) },
    async (request, reply) => {
      const row = await db('elasticsearch_connections')
        .where({ id: request.params.id })
        .select(
          'id', 'name', 'url', 'auth_type',
          'tls_reject_unauthorized', 'ca_cert', 'request_timeout_ms', 'max_retries',
          'pool_max_connections', 'is_default', 'status', 'last_error',
          'last_health_check_at', 'created_at', 'updated_at',
        )
        .first();
      if (!row) return reply.code(404).send({ error: 'Connection not found.' });
      return reply.send(row);
    },
  );

  // ── Create ES connection ─────────────────────────────────────
  app.post(
    '/api/v1/elasticsearch/connections',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_MANAGE) },
    async (request, reply) => {
      const body = request.body as any ?? {};
      const { name, url, auth_type, credentials, tls_reject_unauthorized,
        ca_cert, request_timeout_ms, max_retries, pool_max_connections, is_default } = body;

      if (!name || !url) {
        return reply.code(400).send({ error: 'name and url are required.' });
      }
      if (!['none', 'basic', 'api_key', 'cloud_id'].includes(auth_type ?? 'none')) {
        return reply.code(400).send({ error: 'Invalid auth_type. Must be none, basic, api_key, or cloud_id.' });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      // If setting as default, unset current default
      if (is_default) {
        await db('elasticsearch_connections').update({ is_default: false });
      }

      await db('elasticsearch_connections').insert({
        id,
        name,
        url,
        auth_type: auth_type ?? 'none',
        credentials_encrypted: credentials ? JSON.stringify(credentials) : null,
        tls_reject_unauthorized: tls_reject_unauthorized ?? true,
        ca_cert: ca_cert ?? null,
        request_timeout_ms: request_timeout_ms ?? 30000,
        max_retries: max_retries ?? 3,
        pool_max_connections: pool_max_connections ?? 10,
        is_default: is_default ?? false,
        status: 'unknown',
        created_at: now,
        updated_at: now,
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'es_connection_create',
        resource_type: 'elasticsearch_connection',
        resource_id: id,
        details: { name, url, auth_type: auth_type ?? 'none' },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] ES connection created: ${name} (${id})`);

      const created = await db('elasticsearch_connections').where({ id }).first();
      // Strip credentials from response
      const { credentials_encrypted: _creds, ...safe } = created;
      return reply.code(201).send(safe);
    },
  );

  // ── Update ES connection ─────────────────────────────────────
  app.put<{ Params: { id: string } }>(
    '/api/v1/elasticsearch/connections/:id',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as any ?? {};

      const existing = await db('elasticsearch_connections').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Connection not found.' });

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (body.name !== undefined) updates.name = body.name;
      if (body.url !== undefined) updates.url = body.url;
      if (body.auth_type !== undefined) {
        if (!['none', 'basic', 'api_key', 'cloud_id'].includes(body.auth_type)) {
          return reply.code(400).send({ error: 'Invalid auth_type.' });
        }
        updates.auth_type = body.auth_type;
      }
      if (body.credentials !== undefined) {
        updates.credentials_encrypted = body.credentials ? JSON.stringify(body.credentials) : null;
      }
      if (body.tls_reject_unauthorized !== undefined) updates.tls_reject_unauthorized = body.tls_reject_unauthorized;
      if (body.ca_cert !== undefined) updates.ca_cert = body.ca_cert;
      if (body.request_timeout_ms !== undefined) updates.request_timeout_ms = body.request_timeout_ms;
      if (body.max_retries !== undefined) updates.max_retries = body.max_retries;
      if (body.pool_max_connections !== undefined) updates.pool_max_connections = body.pool_max_connections;

      if (body.is_default !== undefined) {
        if (body.is_default) {
          await db('elasticsearch_connections').update({ is_default: false });
        }
        updates.is_default = body.is_default;
      }

      await db('elasticsearch_connections').where({ id }).update(updates);

      // Destroy cached client so it picks up new settings
      await destroyEsClient(id);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'es_connection_update',
        resource_type: 'elasticsearch_connection',
        resource_id: id,
        details: { changed_fields: Object.keys(updates).filter(k => k !== 'updated_at') },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('elasticsearch_connections').where({ id }).first();
      const { credentials_encrypted: _creds, ...safe } = updated;
      return reply.send(safe);
    },
  );

  // ── Delete ES connection ─────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/elasticsearch/connections/:id',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await db('elasticsearch_connections').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Connection not found.' });

      // Check if any systems reference this connection
      const systemsUsingIt = await db('monitored_systems')
        .where({ es_connection_id: id })
        .select('id', 'name');
      if (systemsUsingIt.length > 0) {
        return reply.code(409).send({
          error: `Cannot delete: connection is used by ${systemsUsingIt.length} system(s).`,
          systems: systemsUsingIt.map((s: any) => ({ id: s.id, name: s.name })),
        });
      }

      await destroyEsClient(id);
      await db('elasticsearch_connections').where({ id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'es_connection_delete',
        resource_type: 'elasticsearch_connection',
        resource_id: id,
        details: { name: existing.name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] ES connection deleted: ${existing.name} (${id})`);
      return reply.send({ deleted: true });
    },
  );

  // ── Test ES connection ───────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/elasticsearch/connections/:id/test',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const client = await getEsClient(id, db);
        const result = await testEsConnection(client);

        // Update health in DB
        await updateConnectionHealth(
          id,
          result.ok ? 'connected' : 'error',
          result.ok ? null : (result as any).error,
          db,
        );

        return reply.send(result);
      } catch (err: any) {
        await updateConnectionHealth(id, 'error', err.message, db);
        return reply.send({ ok: false, error: err.message });
      }
    },
  );

  // ── Test with ad-hoc settings (before save) ──────────────────
  app.post(
    '/api/v1/elasticsearch/test',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_MANAGE) },
    async (request, reply) => {
      const body = request.body as Partial<EsConnectionRow> & { credentials?: Record<string, string> };

      try {
        // Build temp client from raw settings
        const tempRow: Partial<EsConnectionRow> = {
          url: body.url,
          auth_type: body.auth_type,
          credentials_encrypted: body.credentials ? JSON.stringify(body.credentials) : null,
          tls_reject_unauthorized: body.tls_reject_unauthorized,
          ca_cert: body.ca_cert,
          request_timeout_ms: body.request_timeout_ms ?? 10000,
          max_retries: 1,
        };

        const client = buildTempClient(tempRow);
        const result = await testEsConnection(client);
        await client.close();
        return reply.send(result);
      } catch (err: any) {
        return reply.send({ ok: false, error: err.message });
      }
    },
  );

  // ── List indices / aliases ───────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { pattern?: string } }>(
    '/api/v1/elasticsearch/connections/:id/indices',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_VIEW) },
    async (request, reply) => {
      const { id } = request.params;
      const pattern = request.query.pattern ?? '*';

      try {
        const client = await getEsClient(id, db);
        const catResult = await client.cat.indices({
          index: pattern,
          format: 'json',
          h: 'index,health,status,docs.count,store.size,creation.date.string',
          s: 'index:asc',
        });

        // Filter out system indices
        const indices = (catResult as any[]).filter(
          (idx: any) => !idx.index?.startsWith('.'),
        );

        return reply.send(indices);
      } catch (err: any) {
        return reply.code(500).send({ error: `Failed to list indices: ${err.message}` });
      }
    },
  );

  // ── Get index field mapping (for auto-detect) ────────────────
  app.get<{ Params: { id: string }; Querystring: { index: string } }>(
    '/api/v1/elasticsearch/connections/:id/mapping',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_VIEW) },
    async (request, reply) => {
      const { id } = request.params;
      const { index } = request.query;

      if (!index) return reply.code(400).send({ error: 'index query parameter is required.' });

      try {
        const client = await getEsClient(id, db);
        const mapping = await client.indices.getMapping({ index });

        // Flatten the mapping to a list of field paths
        const fields: Array<{ path: string; type: string }> = [];
        const flattenProps = (props: Record<string, any>, prefix = '') => {
          for (const [field, config] of Object.entries(props)) {
            const path = prefix ? `${prefix}.${field}` : field;
            if (config.type) {
              fields.push({ path, type: config.type });
            }
            if (config.properties) {
              flattenProps(config.properties, path);
            }
          }
        };

        // Get the mapping from the first index in the result
        const indexNames = Object.keys(mapping);
        if (indexNames.length > 0) {
          const indexMapping = mapping[indexNames[0]];
          if (indexMapping?.mappings?.properties) {
            flattenProps(indexMapping.mappings.properties);
          }
        }

        return reply.send({ index: indexNames[0] ?? index, fields });
      } catch (err: any) {
        return reply.code(500).send({ error: `Failed to get mapping: ${err.message}` });
      }
    },
  );

  // ── Preview index data (sample docs) ─────────────────────────
  app.get<{ Params: { id: string }; Querystring: { index: string; size?: string } }>(
    '/api/v1/elasticsearch/connections/:id/preview',
    { preHandler: requireAuth(PERMISSIONS.ELASTICSEARCH_VIEW) },
    async (request, reply) => {
      const { id } = request.params;
      const { index } = request.query;
      const rawSize = Number(request.query.size ?? 5);
      const size = Number.isFinite(rawSize) ? Math.min(Math.max(1, rawSize), 20) : 5;

      if (!index) return reply.code(400).send({ error: 'index query parameter is required.' });

      try {
        const client = await getEsClient(id, db);
        const body = await client.search({
          index,
          size,
          sort: [{ _id: 'desc' }],
        });

        const docs = body.hits.hits.map((hit: any) => ({
          _id: hit._id,
          _index: hit._index,
          _source: hit._source,
        }));

        return reply.send({
          index,
          total: typeof body.hits.total === 'number' ? body.hits.total : body.hits.total?.value ?? 0,
          sample: docs,
        });
      } catch (err: any) {
        return reply.code(500).send({ error: `Failed to preview index: ${err.message}` });
      }
    },
  );

  // ── Database Info (PG + ES summary) ──────────────────────────
  app.get(
    '/api/v1/database/info',
    { preHandler: requireAuth(PERMISSIONS.DATABASE_VIEW) },
    async (_request, reply) => {
      // PostgreSQL info
      let pgInfo: Record<string, unknown> = {};
      try {
        const versionResult = await db.raw('SELECT version()');
        const pgVersion = versionResult.rows?.[0]?.version ?? 'unknown';

        const dbSizeResult = await db.raw(
          `SELECT pg_size_pretty(pg_database_size(current_database())) as size`,
        );
        const dbSize = dbSizeResult.rows?.[0]?.size ?? 'unknown';

        const dbNameResult = await db.raw('SELECT current_database() as db_name');
        const dbName = dbNameResult.rows?.[0]?.db_name ?? 'unknown';

        // Check partitioning status
        let partitioned = false;
        try {
          const partResult = await db.raw(`
            SELECT count(*) as cnt FROM pg_inherits
            WHERE inhparent = 'events'::regclass
          `);
          partitioned = Number(partResult.rows?.[0]?.cnt ?? 0) > 0;
        } catch { /* table may not exist or not be partitioned */ }

        // Table sizes
        const tableSizes = await db.raw(`
          SELECT relname as table_name,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
          FROM pg_class c
          LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 10
        `);

        pgInfo = {
          version: pgVersion,
          database: dbName,
          size: dbSize,
          host: process.env.DB_HOST ?? 'localhost',
          port: process.env.DB_PORT ?? '5432',
          partitioned,
          top_tables: tableSizes.rows ?? [],
        };
      } catch (err: any) {
        pgInfo = { error: err.message };
      }

      // Elasticsearch connections summary
      let esInfo: Record<string, unknown> = {};
      try {
        const esConns = await db('elasticsearch_connections')
          .select('id', 'name', 'url', 'status', 'last_health_check_at', 'is_default');
        esInfo = {
          connections: esConns,
          total: esConns.length,
        };
      } catch {
        esInfo = { connections: [], total: 0 };
      }

      return reply.send({
        postgresql: pgInfo,
        elasticsearch: esInfo,
      });
    },
  );
}
