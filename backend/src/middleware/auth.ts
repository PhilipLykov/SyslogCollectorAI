import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { findApiKeyByHash } from './apiKeys.js';
import { getDb } from '../db/index.js';
import { localTimestamp } from '../config/index.js';
import {
  type Permission,
  getPermissionsForRole,
  getPermissionsForScope,
  hasPermission,
} from './permissions.js';
import type { ApiKeyRow, UserRow, SessionRow } from '../types/index.js';

const API_KEY_HEADER = 'x-api-key';
const API_KEY_QUERY_PARAM = 'key';
const AUTH_HEADER = 'authorization';

// ── Fastify type augmentation ────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** API key row (backward compat + API key auth). */
    apiKey?: ApiKeyRow | null;
    /** Authenticated user for session-based auth. Full row (includes password_hash for change-pw route). */
    currentUser?: UserRow | null;
    /** Current session row for session-based auth. */
    currentSession?: SessionRow | null;
    /** Resolved permission set for the authenticated principal. */
    grantedPermissions?: ReadonlySet<Permission> | null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Fastify hook factory: dual-mode authentication and authorization.
 *
 * 1. Checks for session token (Authorization: Bearer <token>)
 * 2. Falls back to API key (X-API-Key header or ?key= query param)
 * 3. Resolves role/scope → permissions
 * 4. Checks required permission
 *
 * OWASP: A01 (access control), A07 (auth failures — generic error).
 */
export function requireAuth(permission: Permission | Permission[]) {
  const perms = Array.isArray(permission) ? permission : [permission];
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const db = getDb();

    // ── 1. Try session-based auth (Authorization: Bearer <token>) ──
    const authHeader = request.headers[AUTH_HEADER];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const tokenHash = hashToken(token);

        const session: SessionRow | undefined = await db('sessions')
          .where({ token_hash: tokenHash })
          .where('expires_at', '>', new Date())
          .first();

        if (session) {
          const user: UserRow | undefined = await db('users')
            .where({ id: session.user_id, is_active: true })
            .first();

          if (user) {
            const userPerms = await getPermissionsForRole(user.role);

            if (!perms.some((p) => hasPermission(userPerms, p))) {
              console.log(
                `[${localTimestamp()}] AUTH_FAIL: user "${user.username}" lacks permission "${perms.join(' | ')}"`,
              );
              return reply.code(403).send({ error: 'Insufficient permissions' });
            }

            request.currentUser = user;
            request.currentSession = session;
            request.grantedPermissions = userPerms;
            request.apiKey = null;
            return;
          }
        }

        // Invalid/expired session token
        console.log(`[${localTimestamp()}] AUTH_FAIL: invalid session token from ${request.ip}`);
        return reply.code(401).send({ error: 'Authentication required' });
      }
    }

    // ── 2. Try API key auth (X-API-Key header or ?key= query param) ──
    let rawKey = request.headers[API_KEY_HEADER];
    if ((!rawKey || typeof rawKey !== 'string') && (request.query as any)?.[API_KEY_QUERY_PARAM]) {
      rawKey = (request.query as any)[API_KEY_QUERY_PARAM];
    }

    if (!rawKey || typeof rawKey !== 'string') {
      console.log(`[${localTimestamp()}] AUTH_FAIL: missing credentials from ${request.ip}`);
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const keyRow = await findApiKeyByHash(db, rawKey);

    if (!keyRow) {
      console.log(`[${localTimestamp()}] AUTH_FAIL: invalid API key from ${request.ip}`);
      return reply.code(401).send({ error: 'Authentication required' });
    }

    // Check if key is active
    if (keyRow.is_active === false) {
      console.log(`[${localTimestamp()}] AUTH_FAIL: revoked API key "${keyRow.name}" from ${request.ip}`);
      return reply.code(401).send({ error: 'Authentication required' });
    }

    // Check key expiry
    if (keyRow.expires_at) {
      const expiresAt = new Date(keyRow.expires_at);
      if (expiresAt < new Date()) {
        console.log(`[${localTimestamp()}] AUTH_FAIL: expired API key "${keyRow.name}" from ${request.ip}`);
        return reply.code(401).send({ error: 'Authentication required' });
      }
    }

    // Check IP allowlist
    const allowedIps = keyRow.allowed_ips;
    if (
      Array.isArray(allowedIps) &&
      allowedIps.length > 0 &&
      !allowedIps.includes(request.ip ?? '')
    ) {
      console.log(
        `[${localTimestamp()}] AUTH_FAIL: API key "${keyRow.name}" IP ${request.ip ?? 'unknown'} not in allowlist`,
      );
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    const keyPerms = getPermissionsForScope(keyRow.scope);
    if (!perms.some((p) => hasPermission(keyPerms, p))) {
      console.log(
        `[${localTimestamp()}] AUTH_FAIL: API key scope "${keyRow.scope}" lacks permission "${perms.join(' | ')}" from ${request.ip}`,
      );
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }

    // Update last_used_at (fire-and-forget, don't block the request)
    db('api_keys')
      .where({ id: keyRow.id })
      .update({ last_used_at: new Date() })
      .catch((err) => { console.error(`[${localTimestamp()}] Failed to update api_key last_used_at:`, err.message); });

    request.currentUser = null;
    request.currentSession = null;
    request.grantedPermissions = keyPerms;
    request.apiKey = keyRow;
  };
}

/** Register auth hooks on a Fastify instance for a route prefix. */
export function registerAuthPlugin(app: FastifyInstance): void {
  app.decorateRequest('apiKey', null);
  app.decorateRequest('currentUser', null);
  app.decorateRequest('currentSession', null);
  app.decorateRequest('grantedPermissions', null);
}
