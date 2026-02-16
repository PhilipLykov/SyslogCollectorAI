import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import type { CreateSystemBody, UpdateSystemBody } from '../../types/index.js';
import { getEventSource } from '../../services/eventSourceFactory.js';

/**
 * CRUD for monitored_systems.
 * Auth: admin scope required. Parameterized queries only (A03).
 */
export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── LIST ────────────────────────────────────────────────────
  app.get(
    '/api/v1/systems',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_request, reply) => {
      const systems = await db('monitored_systems').orderBy('name').select('*');
      return reply.send(systems);
    },
  );

  // ── GET BY ID ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/systems/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      const system = await db('monitored_systems').where({ id: request.params.id }).first();
      if (!system) return reply.code(404).send({ error: 'System not found' });
      return reply.send(system);
    },
  );

  // ── CREATE ──────────────────────────────────────────────────
  app.post<{ Body: CreateSystemBody }>(
    '/api/v1/systems',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { name, description, retention_days, event_source, es_connection_id, es_config } = request.body ?? {} as any;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: '"name" is required and must be a non-empty string.' });
      }

      // Validate retention_days if provided
      if (retention_days !== undefined && retention_days !== null) {
        const rd = Number(retention_days);
        if (!Number.isFinite(rd) || rd < 0 || rd > 3650) {
          return reply.code(400).send({ error: '"retention_days" must be 0–3650 (0 = keep forever, null = use global default).' });
        }
      }

      // Validate event_source
      const validSources = ['postgresql', 'elasticsearch'];
      const effectiveSource = event_source && validSources.includes(event_source) ? event_source : 'postgresql';

      // Validate ES connection if Elasticsearch source is selected
      if (effectiveSource === 'elasticsearch' && es_connection_id) {
        const esConn = await db('elasticsearch_connections').where({ id: es_connection_id }).first();
        if (!esConn) {
          return reply.code(400).send({ error: 'Selected Elasticsearch connection does not exist.' });
        }
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      await db('monitored_systems').insert({
        id,
        name: name.trim(),
        description: (description ?? '').trim(),
        retention_days: retention_days !== undefined ? retention_days : null,
        event_source: effectiveSource,
        es_connection_id: effectiveSource === 'elasticsearch' ? (es_connection_id ?? null) : null,
        es_config: es_config ? JSON.stringify(es_config) : null,
        created_at: now,
        updated_at: now,
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'system_create',
        resource_type: 'system',
        resource_id: id,
        details: { name: name.trim(), retention_days: retention_days ?? null },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] System created: id=${id}, name="${name}"`);
      const created = await db('monitored_systems').where({ id }).first();
      return reply.code(201).send(created);
    },
  );

  // ── UPDATE ──────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: UpdateSystemBody }>(
    '/api/v1/systems/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('monitored_systems').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'System not found' });

      const { name, description, retention_days, event_source, es_connection_id, es_config } = request.body ?? {} as any;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          return reply.code(400).send({ error: '"name" must be a non-empty string.' });
        }
        updates.name = name.trim();
      }
      if (description !== undefined) {
        updates.description = (typeof description === 'string' ? description : '').trim();
      }
      if (retention_days !== undefined) {
        if (retention_days === null) {
          updates.retention_days = null;
        } else {
          const rd = Number(retention_days);
          if (!Number.isFinite(rd) || rd < 0 || rd > 3650) {
            return reply.code(400).send({ error: '"retention_days" must be 0–3650 (0 = keep forever, null = use global default).' });
          }
          updates.retention_days = rd;
        }
      }

      // Event source updates
      if (event_source !== undefined) {
        const validSources = ['postgresql', 'elasticsearch'];
        if (!validSources.includes(event_source)) {
          return reply.code(400).send({ error: '"event_source" must be "postgresql" or "elasticsearch".' });
        }
        updates.event_source = event_source;
      }
      if (es_connection_id !== undefined) {
        if (es_connection_id !== null) {
          const esConn = await db('elasticsearch_connections').where({ id: es_connection_id }).first();
          if (!esConn) {
            return reply.code(400).send({ error: 'Selected Elasticsearch connection does not exist.' });
          }
        }
        updates.es_connection_id = es_connection_id;
      }
      if (es_config !== undefined) {
        updates.es_config = es_config ? JSON.stringify(es_config) : null;
      }

      await db('monitored_systems').where({ id }).update(updates);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'system_update',
        resource_type: 'system',
        resource_id: id,
        details: { name: updates.name, description: updates.description, retention_days: updates.retention_days },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] System updated: id=${id}`);
      const updated = await db('monitored_systems').where({ id }).first();
      return reply.send(updated);
    },
  );

  // ── DELETE ──────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/systems/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('monitored_systems').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'System not found' });

      // Cascade delete related data to avoid orphaned records
      const eventSource = getEventSource(existing, db);
      await db.transaction(async (trx) => {
        // Delete effective scores (depends on windows)
        await trx('effective_scores').where({ system_id: id }).del();
        // Delete meta results (depends on windows)
        const windowIds = await trx('windows').where({ system_id: id }).pluck('id');
        if (windowIds.length > 0) {
          // Batch the whereIn to avoid hitting SQL parameter limits on large datasets
          for (let i = 0; i < windowIds.length; i += 500) {
            await trx('meta_results').whereIn('window_id', windowIds.slice(i, i + 500)).del();
          }
        }
        // Delete alert_history for this system (explicit — don't rely on FK CASCADE alone)
        await trx('alert_history').where({ system_id: id }).del();
        // Delete windows
        await trx('windows').where({ system_id: id }).del();
        // Delete event scores + events via EventSource abstraction
        await eventSource.cascadeDeleteSystem(id, trx);
        // Delete ES event metadata (if any)
        await trx('es_event_metadata').where({ system_id: id }).del();
        // Delete log sources
        await trx('log_sources').where({ system_id: id }).del();
        // Delete message templates
        await trx('message_templates').where({ system_id: id }).del();
        // Delete the system itself
        await trx('monitored_systems').where({ id }).del();
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'system_delete',
        resource_type: 'system',
        resource_id: id,
        details: { name: existing.name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] System deleted (with cascade): id=${id}`);
      return reply.code(204).send();
    },
  );
}
