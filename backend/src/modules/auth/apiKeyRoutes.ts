import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { localTimestamp } from '../../config/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { generateApiKey, hashApiKey } from '../../middleware/apiKeys.js';
import type { ApiKeyScope } from '../../types/index.js';

const VALID_SCOPES: ApiKeyScope[] = ['admin', 'ingest', 'read', 'dashboard'];

export async function registerApiKeyRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── GET /api/v1/api-keys ─────────────────────────────────────
  app.get(
    '/api/v1/api-keys',
    { preHandler: requireAuth(PERMISSIONS.API_KEYS_MANAGE) },
    async (_request, reply) => {
      const keys = await db('api_keys')
        .select('id', 'name', 'scope', 'description', 'created_by', 'expires_at', 'last_used_at', 'is_active', 'created_at')
        .orderBy('created_at', 'desc');

      // Enrich with creator username
      const userIds = [...new Set(keys.filter((k: any) => k.created_by).map((k: any) => k.created_by))];
      let usernameMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const users = await db('users').whereIn('id', userIds).select('id', 'username');
        usernameMap = Object.fromEntries(users.map((u: any) => [u.id, u.username]));
      }

      return reply.send(
        keys.map((k: any) => ({
          ...k,
          created_by_username: k.created_by ? usernameMap[k.created_by] ?? null : null,
        })),
      );
    },
  );

  // ── POST /api/v1/api-keys ────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      scope: ApiKeyScope;
      description?: string;
      expires_at?: string;
    };
  }>(
    '/api/v1/api-keys',
    { preHandler: requireAuth(PERMISSIONS.API_KEYS_MANAGE) },
    async (request, reply) => {
      const { name, scope, description, expires_at } = request.body ?? ({} as any);

      if (!name || typeof name !== 'string' || name.trim().length < 1) {
        return reply.code(400).send({ error: 'Name is required.' });
      }
      if (!scope || !VALID_SCOPES.includes(scope)) {
        return reply.code(400).send({ error: `Invalid scope. Valid scopes: ${VALID_SCOPES.join(', ')}` });
      }
      if (expires_at && isNaN(Date.parse(expires_at))) {
        return reply.code(400).send({ error: 'Invalid expires_at date.' });
      }

      const id = uuidv4();
      const plainKey = generateApiKey();
      const keyHash = hashApiKey(plainKey);

      await db('api_keys').insert({
        id,
        key_hash: keyHash,
        scope,
        name: name.trim(),
        description: description?.trim() || null,
        created_by: request.currentUser?.id ?? null,
        expires_at: expires_at ? new Date(expires_at).toISOString() : null,
        is_active: true,
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'api_key_create',
        resource_type: 'api_key',
        resource_id: id,
        details: { name: name.trim(), scope },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] API key created: "${name.trim()}" (${scope}) by ${request.currentUser?.username ?? 'api_key'}`);

      return reply.code(201).send({
        id,
        name: name.trim(),
        scope,
        plain_key: plainKey,   // Shown only once!
        description: description?.trim() || null,
        expires_at: expires_at ? new Date(expires_at).toISOString() : null,
        created_at: new Date().toISOString(),
        message: 'Copy this API key now. It will not be shown again.',
      });
    },
  );

  // ── PUT /api/v1/api-keys/:id ─────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      scope?: ApiKeyScope;
      description?: string;
      expires_at?: string | null;
      is_active?: boolean;
    };
  }>(
    '/api/v1/api-keys/:id',
    { preHandler: requireAuth(PERMISSIONS.API_KEYS_MANAGE) },
    async (request, reply) => {
      const key = await db('api_keys').where({ id: request.params.id }).first();
      if (!key) return reply.code(404).send({ error: 'API key not found.' });

      const { name, scope, description, expires_at, is_active } = request.body ?? ({} as any);
      const updates: Record<string, unknown> = {};

      if (name !== undefined) updates.name = name.trim();
      if (scope !== undefined) {
        if (!VALID_SCOPES.includes(scope)) {
          return reply.code(400).send({ error: `Invalid scope. Valid scopes: ${VALID_SCOPES.join(', ')}` });
        }
        updates.scope = scope;
      }
      if (description !== undefined) updates.description = description?.trim() || null;
      if (expires_at !== undefined) {
        updates.expires_at = expires_at ? new Date(expires_at).toISOString() : null;
      }
      if (is_active !== undefined) updates.is_active = !!is_active;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'No fields to update.' });
      }

      await db('api_keys').where({ id: request.params.id }).update(updates);
      const updated = await db('api_keys')
        .where({ id: request.params.id })
        .select('id', 'name', 'scope', 'description', 'created_by', 'expires_at', 'last_used_at', 'is_active', 'created_at')
        .first();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'api_key_update',
        resource_type: 'api_key',
        resource_id: request.params.id,
        details: updates,
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send(updated);
    },
  );

  // ── DELETE /api/v1/api-keys/:id ──────────────────────────────
  // Soft-revoke: sets is_active = false
  app.delete<{ Params: { id: string } }>(
    '/api/v1/api-keys/:id',
    { preHandler: requireAuth(PERMISSIONS.API_KEYS_MANAGE) },
    async (request, reply) => {
      const key = await db('api_keys').where({ id: request.params.id }).first();
      if (!key) return reply.code(404).send({ error: 'API key not found.' });

      await db('api_keys').where({ id: request.params.id }).update({ is_active: false });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'api_key_revoke',
        resource_type: 'api_key',
        resource_id: request.params.id,
        details: { name: key.name, scope: key.scope },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({ message: `API key "${key.name}" revoked.` });
    },
  );
}
