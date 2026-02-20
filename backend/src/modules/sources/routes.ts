import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { invalidateSourceCache } from '../ingest/sourceMatch.js';
import type { CreateLogSourceBody, UpdateLogSourceBody } from '../../types/index.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';

/**
 * CRUD for log_sources.
 * Auth: admin scope required. Parameterized queries only (A03).
 */
export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── LIST (all or by system) ─────────────────────────────────
  app.get<{ Querystring: { system_id?: string } }>(
    '/api/v1/sources',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      let query = db('log_sources').orderBy('priority', 'asc');
      if (request.query.system_id) {
        query = query.where({ system_id: request.query.system_id });
      }
      const sources = await query.select('*');
      // Parse selector JSON for response (try/catch per row to avoid one corrupt row crashing the endpoint)
      const result = sources.map((s: any) => {
        let selector = s.selector;
        if (typeof selector === 'string') {
          try { selector = JSON.parse(selector); } catch { /* keep as string */ }
        }
        return { ...s, selector };
      });
      return reply.send(result);
    },
  );

  // ── GET BY ID ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      const source = await db('log_sources').where({ id: request.params.id }).first();
      if (!source) return reply.code(404).send({ error: 'Log source not found' });
      let selector = source.selector;
      if (typeof selector === 'string') {
        try { selector = JSON.parse(selector); } catch { /* keep as string */ }
      }
      return reply.send({ ...source, selector });
    },
  );

  // ── CREATE ──────────────────────────────────────────────────
  app.post<{ Body: CreateLogSourceBody }>(
    '/api/v1/sources',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { system_id, label, selector, priority } = request.body ?? {};

      if (!system_id || typeof system_id !== 'string') {
        return reply.code(400).send({ error: '"system_id" is required.' });
      }
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.code(400).send({ error: '"label" is required and must be a non-empty string.' });
      }
      const isValidSelector = (s: unknown): boolean => {
        if (Array.isArray(s)) {
          return s.length > 0 && s.every(g => g && typeof g === 'object' && !Array.isArray(g));
        }
        return s !== null && typeof s === 'object' && !Array.isArray(s);
      };
      if (!isValidSelector(selector)) {
        return reply.code(400).send({ error: '"selector" must be an object or array of objects.' });
      }

      // Verify system exists
      const system = await db('monitored_systems').where({ id: system_id }).first();
      if (!system) return reply.code(400).send({ error: `System "${system_id}" not found.` });

      const id = uuidv4();
      const now = new Date().toISOString();

      await db('log_sources').insert({
        id,
        system_id,
        label: label.trim(),
        selector: JSON.stringify(selector),
        priority: priority ?? 0,
        created_at: now,
        updated_at: now,
      });

      invalidateSourceCache();
      app.log.info(`[${localTimestamp()}] Log source created: id=${id}, label="${label}"`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_create',
        resource_type: 'log_source',
        resource_id: id,
        details: { label: label.trim(), system_id },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('log_sources').where({ id }).first();
      let createdSelector = created.selector;
      if (typeof createdSelector === 'string') {
        try { createdSelector = JSON.parse(createdSelector); } catch { /* keep as string */ }
      }
      return reply.code(201).send({ ...created, selector: createdSelector });
    },
  );

  // ── UPDATE ──────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: UpdateLogSourceBody }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('log_sources').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Log source not found' });

      const { label, selector, priority } = request.body ?? {};
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      if (label !== undefined) {
        if (typeof label !== 'string' || label.trim().length === 0) {
          return reply.code(400).send({ error: '"label" must be a non-empty string.' });
        }
        updates.label = label.trim();
      }
      if (selector !== undefined) {
        const isValidSelector = (s: unknown): boolean => {
          if (Array.isArray(s)) {
            return s.length > 0 && s.every(g => g && typeof g === 'object' && !Array.isArray(g));
          }
          return s !== null && typeof s === 'object' && !Array.isArray(s);
        };
        if (!isValidSelector(selector)) {
          return reply.code(400).send({ error: '"selector" must be an object or array of objects.' });
        }
        updates.selector = JSON.stringify(selector);
      }
      if (priority !== undefined) {
        const parsedPriority = Number(priority);
        if (!Number.isFinite(parsedPriority)) {
          return reply.code(400).send({ error: '"priority" must be a number.' });
        }
        updates.priority = parsedPriority;
      }

      await db('log_sources').where({ id }).update(updates);
      invalidateSourceCache();

      app.log.info(`[${localTimestamp()}] Log source updated: id=${id}`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_update',
        resource_type: 'log_source',
        resource_id: id,
        details: { ...updates },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('log_sources').where({ id }).first();
      let updatedSelector = updated.selector;
      if (typeof updatedSelector === 'string') {
        try { updatedSelector = JSON.parse(updatedSelector); } catch { /* keep as string */ }
      }
      return reply.send({ ...updated, selector: updatedSelector });
    },
  );

  // ── DELETE ──────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('log_sources').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Log source not found' });

      await db('log_sources').where({ id }).del();
      invalidateSourceCache();

      app.log.info(`[${localTimestamp()}] Log source deleted: id=${id}`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_delete',
        resource_type: 'log_source',
        resource_id: id,
        details: { label: existing.label },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );
}
