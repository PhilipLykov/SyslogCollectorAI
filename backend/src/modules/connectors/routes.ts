import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { getAvailableConnectorTypes } from './registry.js';
import { validateUrl } from './urlValidation.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';

/**
 * Connector config API: CRUD for connectors.
 * Secrets (passwords, tokens) in env or secrets manager, not in DB in plain text (A02).
 * URLs validated for SSRF (A10).
 */
export async function registerConnectorRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get(
    '/api/v1/connectors',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_req, reply) => {
      const connectors = await db('connectors').orderBy('name').select('*');
      return reply.send(connectors.map(parseConfig));
    },
  );

  app.get(
    '/api/v1/connectors/types',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_req, reply) => {
      return reply.send(getAvailableConnectorTypes());
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/connectors/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      const conn = await db('connectors').where({ id: request.params.id }).first();
      if (!conn) return reply.code(404).send({ error: 'Connector not found' });

      // Include cursor info
      const cursor = await db('connector_cursors').where({ connector_id: conn.id }).first();
      return reply.send({ ...parseConfig(conn), cursor: cursor?.cursor_value ?? null });
    },
  );

  app.post(
    '/api/v1/connectors',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { type, name, config, enabled, poll_interval_seconds } = request.body as any;

      if (!type || !name || !config) {
        return reply.code(400).send({ error: 'type, name, and config are required.' });
      }

      // Validate connector type
      const validTypes = getAvailableConnectorTypes();
      if (!validTypes.includes(type) && type !== 'webhook' && type !== 'syslog') {
        return reply.code(400).send({
          error: `Invalid connector type: "${type}". Valid types: ${[...validTypes, 'webhook', 'syslog'].join(', ')}`,
        });
      }

      // Validate URL in config if present (A10)
      try {
        if (config.url) validateUrl(config.url);
      } catch (urlErr: any) {
        return reply.code(400).send({ error: urlErr.message ?? 'Invalid URL' });
      }

      const id = uuidv4();
      await db('connectors').insert({
        id,
        type,
        name,
        config: JSON.stringify(config),
        enabled: enabled ?? true,
        poll_interval_seconds: Math.max(10, Number(poll_interval_seconds) || 300),
      });

      app.log.info(`[${localTimestamp()}] Connector created: ${type}/${name} (${id})`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'connector_create',
        resource_type: 'connector',
        resource_id: id,
        details: { type, name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('connectors').where({ id }).first();
      return reply.code(201).send(parseConfig(created));
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/connectors/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('connectors').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Connector not found' });

      const { name, config, enabled, poll_interval_seconds } = request.body as any;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      if (name !== undefined) updates.name = name;
      if (config !== undefined) {
        try {
          if (config.url) validateUrl(config.url);
        } catch (urlErr: any) {
          return reply.code(400).send({ error: urlErr.message ?? 'Invalid URL' });
        }
        updates.config = JSON.stringify(config);
      }
      if (enabled !== undefined) updates.enabled = enabled;
      if (poll_interval_seconds !== undefined) {
        updates.poll_interval_seconds = Math.max(10, Number(poll_interval_seconds) || 300);
      }

      await db('connectors').where({ id }).update(updates);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'connector_update',
        resource_type: 'connector',
        resource_id: id,
        details: { ...updates },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('connectors').where({ id }).first();
      return reply.send(parseConfig(updated));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/connectors/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await db('connectors').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Connector not found' });

      // Clean up cursor records before deleting the connector (atomic)
      await db.transaction(async (trx) => {
        await trx('connector_cursors').where({ connector_id: id }).del();
        await trx('connectors').where({ id }).del();
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'connector_delete',
        resource_type: 'connector',
        resource_id: id,
        details: { name: existing.name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );
}

function parseConfig(row: any): any {
  if (!row) return row;
  let config = row.config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { /* keep as string */ }
  }
  return { ...row, config };
}
