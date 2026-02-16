import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { localTimestamp } from '../../config/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { hashPassword, validatePasswordPolicy } from '../../middleware/passwords.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import type { UserRow } from '../../types/index.js';

/** Fetch all valid role names from the database. */
async function getValidRoles(): Promise<string[]> {
  const db = getDb();
  try {
    const rows: Array<{ name: string }> = await db('roles').select('name');
    return rows.map((r) => r.name);
  } catch {
    // Fallback if migration hasn't run yet
    return ['administrator', 'auditor', 'monitoring_agent'];
  }
}

/** Fields safe to return to the client (never expose password_hash). */
function sanitizeUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    must_change_password: u.must_change_password,
    last_login_at: u.last_login_at,
    failed_login_count: u.failed_login_count,
    locked_until: u.locked_until,
    created_at: u.created_at,
    updated_at: u.updated_at,
    created_by: u.created_by,
  };
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── GET /api/v1/users ────────────────────────────────────────
  app.get(
    '/api/v1/users',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (_request, reply) => {
      const users: UserRow[] = await db('users').orderBy('username').select('*');
      return reply.send(users.map(sanitizeUser));
    },
  );

  // ── GET /api/v1/users/:id ────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/users/:id',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const user: UserRow | undefined = await db('users').where({ id: request.params.id }).first();
      if (!user) return reply.code(404).send({ error: 'User not found.' });
      return reply.send(sanitizeUser(user));
    },
  );

  // ── POST /api/v1/users ───────────────────────────────────────
  app.post<{
    Body: {
      username: string;
      password: string;
      display_name?: string;
      email?: string;
      role?: string;
      must_change_password?: boolean;
    };
  }>(
    '/api/v1/users',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const { username, password, display_name, email, role, must_change_password } = request.body ?? ({} as any);

      if (!username || typeof username !== 'string' || username.trim().length < 3) {
        return reply.code(400).send({ error: 'Username must be at least 3 characters.' });
      }
      if (!password || typeof password !== 'string') {
        return reply.code(400).send({ error: 'Password is required.' });
      }

      const normalizedUsername = username.trim().toLowerCase();

      // Check uniqueness
      const existing = await db('users').where({ username: normalizedUsername }).first();
      if (existing) {
        return reply.code(409).send({ error: 'Username already exists.' });
      }

      // Validate role
      const validRoles = await getValidRoles();
      if (role && !validRoles.includes(role)) {
        return reply.code(400).send({ error: `Invalid role. Valid roles: ${validRoles.join(', ')}` });
      }
      const userRole = role && validRoles.includes(role) ? role : 'monitoring_agent';

      // Validate password policy
      const policy = validatePasswordPolicy(password);
      if (!policy.valid) {
        return reply.code(400).send({ error: policy.errors.join(' ') });
      }

      const passwordHash = await hashPassword(password);
      const id = uuidv4();

      await db('users').insert({
        id,
        username: normalizedUsername,
        password_hash: passwordHash,
        display_name: display_name?.trim() || null,
        email: email?.trim() || null,
        role: userRole,
        must_change_password: must_change_password ?? true,
        created_by: request.currentUser?.id ?? null,
      });

      const created: UserRow = await db('users').where({ id }).first();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'user_create',
        resource_type: 'user',
        resource_id: id,
        details: { username: normalizedUsername, role: userRole },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] User created: ${normalizedUsername} (${userRole}) by ${request.currentUser?.username ?? 'api_key'}`);

      return reply.code(201).send(sanitizeUser(created));
    },
  );

  // ── PUT /api/v1/users/:id ────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      display_name?: string;
      email?: string;
      role?: string;
    };
  }>(
    '/api/v1/users/:id',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const user: UserRow | undefined = await db('users').where({ id: request.params.id }).first();
      if (!user) return reply.code(404).send({ error: 'User not found.' });

      const { display_name, email, role } = request.body ?? ({} as any);
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (display_name !== undefined) updates.display_name = display_name?.trim() || null;
      if (email !== undefined) updates.email = email?.trim() || null;
      if (role !== undefined) {
        const validRoles = await getValidRoles();
        if (!validRoles.includes(role)) {
          return reply.code(400).send({ error: `Invalid role. Valid roles: ${validRoles.join(', ')}` });
        }
        // Prevent removing last admin
        if (user.role === 'administrator' && role !== 'administrator') {
          const adminCount = await db('users').where({ role: 'administrator', is_active: true }).count('id as cnt').first();
          if (Number(adminCount?.cnt ?? 0) <= 1) {
            return reply.code(400).send({ error: 'Cannot change role of the last active administrator.' });
          }
        }
        updates.role = role;
      }

      await db('users').where({ id: request.params.id }).update(updates);
      const updated: UserRow = await db('users').where({ id: request.params.id }).first();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'user_update',
        resource_type: 'user',
        resource_id: request.params.id,
        details: updates,
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send(sanitizeUser(updated));
    },
  );

  // ── PUT /api/v1/users/:id/reset-password ─────────────────────
  app.put<{ Params: { id: string }; Body: { new_password: string } }>(
    '/api/v1/users/:id/reset-password',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const user: UserRow | undefined = await db('users').where({ id: request.params.id }).first();
      if (!user) return reply.code(404).send({ error: 'User not found.' });

      const { new_password } = request.body ?? ({} as any);
      if (!new_password || typeof new_password !== 'string') {
        return reply.code(400).send({ error: 'new_password is required.' });
      }

      const policy = validatePasswordPolicy(new_password);
      if (!policy.valid) {
        return reply.code(400).send({ error: policy.errors.join(' ') });
      }

      const passwordHash = await hashPassword(new_password);
      await db('users').where({ id: request.params.id }).update({
        password_hash: passwordHash,
        must_change_password: true,
        updated_at: new Date().toISOString(),
      });

      // Invalidate all sessions for this user
      await db('sessions').where({ user_id: request.params.id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'password_reset',
        resource_type: 'user',
        resource_id: request.params.id,
        details: { target_username: user.username },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send({ message: `Password reset for ${user.username}. User must change password on next login.` });
    },
  );

  // ── PUT /api/v1/users/:id/toggle-active ──────────────────────
  app.put<{ Params: { id: string } }>(
    '/api/v1/users/:id/toggle-active',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const user: UserRow | undefined = await db('users').where({ id: request.params.id }).first();
      if (!user) return reply.code(404).send({ error: 'User not found.' });

      // Prevent disabling self
      if (request.currentUser?.id === user.id) {
        return reply.code(400).send({ error: 'Cannot disable your own account.' });
      }

      // Prevent disabling last admin
      if (user.is_active && user.role === 'administrator') {
        const adminCount = await db('users').where({ role: 'administrator', is_active: true }).count('id as cnt').first();
        if (Number(adminCount?.cnt ?? 0) <= 1) {
          return reply.code(400).send({ error: 'Cannot disable the last active administrator.' });
        }
      }

      const newActive = !user.is_active;
      await db('users').where({ id: user.id }).update({
        is_active: newActive,
        updated_at: new Date().toISOString(),
      });

      // If disabling, invalidate all sessions
      if (!newActive) {
        await db('sessions').where({ user_id: user.id }).del();
      }

      const updated: UserRow = await db('users').where({ id: user.id }).first();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: newActive ? 'user_enable' : 'user_disable',
        resource_type: 'user',
        resource_id: user.id,
        details: { username: user.username },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.send(sanitizeUser(updated));
    },
  );

  // ── DELETE /api/v1/users/:id ─────────────────────────────────
  // Soft-delete: sets is_active = false and invalidates sessions.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/users/:id',
    { preHandler: requireAuth(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const user: UserRow | undefined = await db('users').where({ id: request.params.id }).first();
      if (!user) return reply.code(404).send({ error: 'User not found.' });

      if (request.currentUser?.id === user.id) {
        return reply.code(400).send({ error: 'Cannot delete your own account.' });
      }

      if (user.role === 'administrator') {
        const adminCount = await db('users').where({ role: 'administrator', is_active: true }).count('id as cnt').first();
        if (Number(adminCount?.cnt ?? 0) <= 1) {
          return reply.code(400).send({ error: 'Cannot delete the last active administrator.' });
        }
      }

      // Soft delete
      await db('users').where({ id: user.id }).update({ is_active: false, updated_at: new Date().toISOString() });
      await db('sessions').where({ user_id: user.id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'user_delete',
        resource_type: 'user',
        resource_id: user.id,
        details: { username: user.username },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );
}
