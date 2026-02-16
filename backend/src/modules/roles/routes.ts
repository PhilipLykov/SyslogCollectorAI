import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { localTimestamp } from '../../config/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS, ALL_PERMISSIONS, invalidateRoleCache } from '../../middleware/permissions.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';

interface RoleRow {
  name: string;
  display_name: string;
  description: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export async function registerRoleRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── GET /api/v1/roles ──────────────────────────────────────
  // Returns all roles with their permissions.
  app.get(
    '/api/v1/roles',
    { preHandler: requireAuth([PERMISSIONS.USERS_MANAGE, PERMISSIONS.ROLES_MANAGE]) },
    async (_request, reply) => {
      const roles: RoleRow[] = await db('roles').orderBy('name').select('*');
      const allPerms: Array<{ role_name: string; permission: string }> = await db('role_permissions').select('*');

      const permMap = new Map<string, string[]>();
      for (const row of allPerms) {
        const arr = permMap.get(row.role_name) ?? [];
        arr.push(row.permission);
        permMap.set(row.role_name, arr);
      }

      const result = roles.map((r) => ({
        name: r.name,
        display_name: r.display_name,
        description: r.description,
        is_system: r.is_system,
        permissions: permMap.get(r.name) ?? [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      return reply.send(result);
    },
  );

  // ── GET /api/v1/roles/permissions ──────────────────────────
  // Returns the master list of all known permissions with labels and categories.
  app.get(
    '/api/v1/roles/permissions',
    { preHandler: requireAuth([PERMISSIONS.USERS_MANAGE, PERMISSIONS.ROLES_MANAGE]) },
    async (_request, reply) => {
      return reply.send(ALL_PERMISSIONS);
    },
  );

  // ── POST /api/v1/roles ─────────────────────────────────────
  // Create a new custom role.
  app.post<{
    Body: {
      name: string;
      display_name: string;
      description?: string;
      permissions?: string[];
    };
  }>(
    '/api/v1/roles',
    { preHandler: requireAuth(PERMISSIONS.ROLES_MANAGE) },
    async (request, reply) => {
      const { name, display_name, description, permissions } = request.body ?? ({} as any);

      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return reply.code(400).send({ error: 'Role name must be at least 2 characters.' });
      }

      // Sanitize name: lowercase, underscores only
      const roleName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

      if (!display_name || typeof display_name !== 'string' || display_name.trim().length < 2) {
        return reply.code(400).send({ error: 'Display name must be at least 2 characters.' });
      }

      // Check uniqueness
      const existing = await db('roles').where({ name: roleName }).first();
      if (existing) {
        return reply.code(409).send({ error: `Role "${roleName}" already exists.` });
      }

      // Validate permissions
      const validPermNames: string[] = ALL_PERMISSIONS.map((p) => p.permission as string);
      const rolePerms: string[] = [];
      if (Array.isArray(permissions)) {
        const invalid = permissions.filter((p: string) => !validPermNames.includes(p));
        if (invalid.length > 0) {
          return reply.code(400).send({ error: `Unknown permissions: ${invalid.join(', ')}` });
        }
        rolePerms.push(...permissions);
      }

      await db.transaction(async (trx) => {
        await trx('roles').insert({
          name: roleName,
          display_name: display_name.trim(),
          description: (description ?? '').trim(),
          is_system: false,
        });

        if (rolePerms.length > 0) {
          await trx('role_permissions').insert(
            rolePerms.map((p: string) => ({ role_name: roleName, permission: p })),
          );
        }
      });

      invalidateRoleCache(roleName);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'role_create',
        resource_type: 'role',
        resource_id: roleName,
        details: { display_name: display_name.trim(), permissions: rolePerms },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] Role created: ${roleName} by ${request.currentUser?.username ?? 'api_key'}`);

      const created = await db('roles').where({ name: roleName }).first();
      return reply.code(201).send({
        ...created,
        permissions: rolePerms,
      });
    },
  );

  // ── PUT /api/v1/roles/:name ────────────────────────────────
  // Update a role's display name, description, and permissions.
  app.put<{
    Params: { name: string };
    Body: {
      display_name?: string;
      description?: string;
      permissions?: string[];
    };
  }>(
    '/api/v1/roles/:name',
    { preHandler: requireAuth(PERMISSIONS.ROLES_MANAGE) },
    async (request, reply) => {
      const roleName = request.params.name;
      const role: RoleRow | undefined = await db('roles').where({ name: roleName }).first();
      if (!role) return reply.code(404).send({ error: 'Role not found.' });

      const { display_name, description, permissions } = request.body ?? ({} as any);
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (display_name !== undefined) {
        if (typeof display_name !== 'string' || display_name.trim().length < 2) {
          return reply.code(400).send({ error: 'Display name must be at least 2 characters.' });
        }
        updates.display_name = display_name.trim();
      }

      if (description !== undefined) {
        updates.description = (description ?? '').trim();
      }

      // Validate permissions before transaction
      let rolePerms: string[] | null = null;
      if (Array.isArray(permissions)) {
        const validPermNames: string[] = ALL_PERMISSIONS.map((p) => p.permission as string);
        const invalid = permissions.filter((p: string) => !validPermNames.includes(p));
        if (invalid.length > 0) {
          return reply.code(400).send({ error: `Unknown permissions: ${invalid.join(', ')}` });
        }
        rolePerms = permissions;

        // Prevent stripping all permissions from administrator role
        if (role.is_system && roleName === 'administrator' && rolePerms.length === 0) {
          return reply.code(400).send({ error: 'Cannot remove all permissions from the administrator role.' });
        }
      }

      await db.transaction(async (trx) => {
        await trx('roles').where({ name: roleName }).update(updates);

        // Update permissions if provided
        if (rolePerms !== null) {
          await trx('role_permissions').where({ role_name: roleName }).del();
          if (rolePerms.length > 0) {
            await trx('role_permissions').insert(
              rolePerms.map((p) => ({ role_name: roleName, permission: p })),
            );
          }
        }
      });

      invalidateRoleCache(roleName);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'role_update',
        resource_type: 'role',
        resource_id: roleName,
        details: { ...updates, permissions: permissions ?? 'unchanged' },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      // Return updated role with permissions
      const updated = await db('roles').where({ name: roleName }).first();
      const perms: Array<{ permission: string }> = await db('role_permissions')
        .where({ role_name: roleName })
        .select('permission');

      return reply.send({
        ...updated,
        permissions: perms.map((p) => p.permission),
      });
    },
  );

  // ── DELETE /api/v1/roles/:name ─────────────────────────────
  // Delete a custom role. System roles cannot be deleted.
  app.delete<{ Params: { name: string } }>(
    '/api/v1/roles/:name',
    { preHandler: requireAuth(PERMISSIONS.ROLES_MANAGE) },
    async (request, reply) => {
      const roleName = request.params.name;
      const role: RoleRow | undefined = await db('roles').where({ name: roleName }).first();
      if (!role) return reply.code(404).send({ error: 'Role not found.' });

      if (role.is_system) {
        return reply.code(400).send({ error: 'System roles cannot be deleted. You can modify their permissions instead.' });
      }

      // Check if any users are assigned to this role
      const usersWithRole = await db('users').where({ role: roleName }).count('id as cnt').first();
      if (Number(usersWithRole?.cnt ?? 0) > 0) {
        return reply.code(400).send({
          error: `Cannot delete role "${roleName}" — ${usersWithRole?.cnt} user(s) are still assigned to it. Reassign them first.`,
        });
      }

      // Delete permissions and role (cascade handles role_permissions)
      await db('roles').where({ name: roleName }).del();

      invalidateRoleCache(roleName);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'role_delete',
        resource_type: 'role',
        resource_id: roleName,
        details: { display_name: role.display_name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      app.log.info(`[${localTimestamp()}] Role deleted: ${roleName} by ${request.currentUser?.username ?? 'api_key'}`);

      return reply.code(204).send();
    },
  );
}
