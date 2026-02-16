import type { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { localTimestamp } from '../../config/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS, getPermissionsForRole } from '../../middleware/permissions.js';
import {
  verifyPassword,
  hashPassword,
  validatePasswordPolicy,
  isAccountLocked,
  computeLockout,
  resetLockout,
} from '../../middleware/passwords.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import type { UserRow } from '../../types/index.js';

const SESSION_EXPIRY_HOURS = 24;
const MAX_SESSIONS_PER_USER = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateSessionToken(): string {
  return randomBytes(48).toString('hex');
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── POST /api/v1/auth/login ──────────────────────────────────
  app.post<{ Body: { username: string; password: string } }>(
    '/api/v1/auth/login',
    async (request, reply) => {
      const { username, password } = request.body ?? ({} as any);

      if (!username || !password) {
        return reply.code(400).send({ error: 'Username and password are required.' });
      }

      const user: UserRow | undefined = await db('users')
        .where({ username: username.trim().toLowerCase() })
        .first();

      if (!user) {
        // Generic error to avoid user enumeration (OWASP A07)
        await writeAuditLog(db, {
          actor_name: (username ?? '').trim().toLowerCase(),
          action: 'login_fail',
          resource_type: 'auth',
          details: { username: username.trim().toLowerCase(), reason: 'unknown_user' },
          ip: request.ip,
        });
        return reply.code(401).send({ error: 'Invalid username or password.' });
      }

      // Check account active
      if (!user.is_active) {
        await writeAuditLog(db, {
          actor_name: username,
          action: 'login_fail',
          resource_type: 'auth',
          details: { reason: 'account_disabled' },
          ip: request.ip,
          user_id: user.id,
        });
        return reply.code(401).send({ error: 'Invalid username or password.' });
      }

      // Check lockout
      const lockout = isAccountLocked(user.locked_until ?? null);
      if (lockout.locked) {
        await writeAuditLog(db, {
          actor_name: username,
          action: 'login_fail',
          resource_type: 'auth',
          details: { reason: 'account_locked', remaining_seconds: Math.ceil(lockout.remainingMs / 1000) },
          ip: request.ip,
          user_id: user.id,
        });
        const minutes = Math.ceil(lockout.remainingMs / 60000);
        return reply.code(429).send({
          error: `Account is temporarily locked. Try again in ${minutes} minute(s).`,
        });
      }

      // Verify password
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        const lockState = computeLockout(user.failed_login_count);
        await db('users').where({ id: user.id }).update(lockState);

        await writeAuditLog(db, {
          actor_name: username,
          action: 'login_fail',
          resource_type: 'auth',
          details: {
            reason: 'invalid_password',
            failed_count: lockState.failed_login_count,
            locked: !!lockState.locked_until,
          },
          ip: request.ip,
          user_id: user.id,
        });

        return reply.code(401).send({ error: 'Invalid username or password.' });
      }

      // ── Success: create session ──────────────────────────────
      // Reset lockout
      await db('users').where({ id: user.id }).update({
        ...resetLockout(),
        last_login_at: new Date().toISOString(),
      });

      // Enforce max sessions per user
      const existingSessions = await db('sessions')
        .where({ user_id: user.id })
        .orderBy('created_at', 'asc');

      if (existingSessions.length >= MAX_SESSIONS_PER_USER) {
        // Remove oldest sessions to make room
        const toRemove = existingSessions.slice(0, existingSessions.length - MAX_SESSIONS_PER_USER + 1);
        await db('sessions').whereIn('id', toRemove.map((s: any) => s.id)).del();
      }

      const plainToken = generateSessionToken();
      const tokenHash = hashToken(plainToken);
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

      const sessionId = uuidv4();
      await db('sessions').insert({
        id: sessionId,
        user_id: user.id,
        token_hash: tokenHash,
        ip: request.ip,
        user_agent: (request.headers['user-agent'] ?? '').slice(0, 500),
        expires_at: expiresAt.toISOString(),
      });

      await writeAuditLog(db, {
        actor_name: username,
        action: 'login',
        resource_type: 'auth',
        ip: request.ip,
        user_id: user.id,
        session_id: sessionId,
      });

      const permissions = Array.from(await getPermissionsForRole(user.role));

      return reply.send({
        token: plainToken,
        expires_at: expiresAt.toISOString(),
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          email: user.email,
          role: user.role,
          must_change_password: user.must_change_password,
          permissions,
        },
      });
    },
  );

  // ── POST /api/v1/auth/logout ─────────────────────────────────
  app.post(
    '/api/v1/auth/logout',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      if (request.currentSession) {
        await db('sessions').where({ id: request.currentSession.id }).del();

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'logout',
          resource_type: 'auth',
          ip: request.ip,
          user_id: request.currentUser?.id,
          session_id: request.currentSession.id,
        });
      }

      return reply.send({ message: 'Logged out successfully.' });
    },
  );

  // ── GET /api/v1/auth/me ──────────────────────────────────────
  app.get(
    '/api/v1/auth/me',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      if (request.currentUser) {
        const permissions = Array.from(await getPermissionsForRole(request.currentUser.role));
        return reply.send({
          user: {
            id: request.currentUser.id,
            username: request.currentUser.username,
            display_name: request.currentUser.display_name,
            email: request.currentUser.email,
            role: request.currentUser.role,
            must_change_password: request.currentUser.must_change_password,
            permissions,
          },
        });
      }

      // API key auth -- return minimal info
      if (request.apiKey) {
        const permissions = Array.from(request.grantedPermissions ?? []);
        return reply.send({
          api_key: {
            id: request.apiKey.id,
            name: request.apiKey.name,
            scope: request.apiKey.scope,
            permissions,
          },
        });
      }

      return reply.code(401).send({ error: 'Authentication required' });
    },
  );

  // ── PUT /api/v1/auth/change-password ─────────────────────────
  app.put<{ Body: { current_password: string; new_password: string } }>(
    '/api/v1/auth/change-password',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(400).send({ error: 'Password change is only available for user sessions, not API keys.' });
      }

      const { current_password, new_password } = request.body ?? ({} as any);

      if (!current_password || !new_password) {
        return reply.code(400).send({ error: 'Both current_password and new_password are required.' });
      }

      // Verify current password
      const valid = await verifyPassword(current_password, request.currentUser.password_hash);
      if (!valid) {
        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'password_change_fail',
          resource_type: 'user',
          resource_id: request.currentUser.id,
          details: { reason: 'invalid_current_password' },
          ip: request.ip,
          user_id: request.currentUser.id,
        });
        return reply.code(401).send({ error: 'Current password is incorrect.' });
      }

      // Validate new password policy
      const policy = validatePasswordPolicy(new_password);
      if (!policy.valid) {
        return reply.code(400).send({ error: policy.errors.join(' ') });
      }

      // Hash and update
      const newHash = await hashPassword(new_password);
      await db('users').where({ id: request.currentUser.id }).update({
        password_hash: newHash,
        must_change_password: false,
        updated_at: new Date().toISOString(),
      });

      // Invalidate all OTHER sessions (keep current)
      await db('sessions')
        .where({ user_id: request.currentUser.id })
        .whereNot({ id: request.currentSession?.id ?? '' })
        .del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'password_change',
        resource_type: 'user',
        resource_id: request.currentUser.id,
        ip: request.ip,
        user_id: request.currentUser.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({ message: 'Password changed successfully. Other sessions have been invalidated.' });
    },
  );
}
