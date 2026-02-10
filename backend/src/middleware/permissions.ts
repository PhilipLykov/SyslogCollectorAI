/**
 * Granular permission constants and role-to-permission mappings.
 *
 * Permissions follow the pattern `resource:action`.
 * Role permissions are stored in the database (roles / role_permissions tables)
 * and cached in memory with a short TTL.
 *
 * API keys map their legacy scope to a permission set so
 * they can coexist with the new user-based auth.
 */

import { getDb } from '../db/index.js';
import { localTimestamp } from '../config/index.js';

// ── Permission constants ─────────────────────────────────────

export const PERMISSIONS = {
  // Dashboard
  DASHBOARD_VIEW: 'dashboard:view',

  // Events
  EVENTS_VIEW: 'events:view',
  EVENTS_ACKNOWLEDGE: 'events:acknowledge',

  // Systems & Sources
  SYSTEMS_VIEW: 'systems:view',
  SYSTEMS_MANAGE: 'systems:manage',

  // AI Configuration
  AI_CONFIG_VIEW: 'ai_config:view',
  AI_CONFIG_MANAGE: 'ai_config:manage',

  // Notifications
  NOTIFICATIONS_VIEW: 'notifications:view',
  NOTIFICATIONS_MANAGE: 'notifications:manage',

  // Database Maintenance
  DATABASE_VIEW: 'database:view',
  DATABASE_MANAGE: 'database:manage',

  // Privacy
  PRIVACY_VIEW: 'privacy:view',
  PRIVACY_MANAGE: 'privacy:manage',

  // User Management
  USERS_MANAGE: 'users:manage',

  // Role Management
  ROLES_MANAGE: 'roles:manage',

  // API Key Management
  API_KEYS_MANAGE: 'api_keys:manage',

  // Audit Log
  AUDIT_VIEW: 'audit:view',
  AUDIT_EXPORT: 'audit:export',

  // RAG / Ask AI
  RAG_USE: 'rag:use',

  // AI Usage / Costs
  AI_USAGE_VIEW: 'ai_usage:view',

  // Compliance Export
  COMPLIANCE_EXPORT: 'compliance:export',

  // Ingest (API key only)
  INGEST: 'ingest',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * All known permissions with human-readable labels and categories.
 * Used by the frontend roles editor.
 */
export const ALL_PERMISSIONS: ReadonlyArray<{
  permission: Permission;
  label: string;
  category: string;
}> = [
  { permission: 'dashboard:view',        label: 'View Dashboard',                category: 'Dashboard' },
  { permission: 'events:view',           label: 'View Events',                   category: 'Events' },
  { permission: 'events:acknowledge',    label: 'Acknowledge Events',            category: 'Events' },
  { permission: 'systems:view',          label: 'View Systems & Sources',        category: 'Systems' },
  { permission: 'systems:manage',        label: 'Manage Systems & Sources',      category: 'Systems' },
  { permission: 'ai_config:view',        label: 'View AI Configuration',         category: 'AI' },
  { permission: 'ai_config:manage',      label: 'Manage AI Configuration',       category: 'AI' },
  { permission: 'notifications:view',    label: 'View Notifications & Alerts',   category: 'Notifications' },
  { permission: 'notifications:manage',  label: 'Manage Notifications & Alerts', category: 'Notifications' },
  { permission: 'database:view',         label: 'View Database Status',          category: 'Database' },
  { permission: 'database:manage',       label: 'Manage Database & Backups',     category: 'Database' },
  { permission: 'privacy:view',          label: 'View Privacy Settings',         category: 'Privacy' },
  { permission: 'privacy:manage',        label: 'Manage Privacy Settings',       category: 'Privacy' },
  { permission: 'users:manage',          label: 'Manage Users',                  category: 'Administration' },
  { permission: 'roles:manage',          label: 'Manage Roles & Permissions',    category: 'Administration' },
  { permission: 'api_keys:manage',       label: 'Manage API Keys',              category: 'Administration' },
  { permission: 'audit:view',            label: 'View Audit Log',               category: 'Audit' },
  { permission: 'audit:export',          label: 'Export Audit Log',             category: 'Audit' },
  { permission: 'rag:use',              label: 'Use RAG / Ask AI',             category: 'AI' },
  { permission: 'ai_usage:view',         label: 'View AI Usage & Costs',        category: 'AI' },
  { permission: 'compliance:export',     label: 'Export Compliance Data',       category: 'Audit' },
  { permission: 'ingest',               label: 'Ingest Events (API key only)',  category: 'Ingest' },
];

// Re-export UserRole from the canonical location
export type { UserRole } from '../types/index.js';

// ── Hardcoded fallback (used if DB is not yet migrated) ──────

const FALLBACK_ROLE_PERMISSIONS: Record<string, ReadonlySet<Permission>> = {
  administrator: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW, PERMISSIONS.EVENTS_ACKNOWLEDGE,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.SYSTEMS_MANAGE,
    PERMISSIONS.AI_CONFIG_VIEW, PERMISSIONS.AI_CONFIG_MANAGE,
    PERMISSIONS.NOTIFICATIONS_VIEW, PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.DATABASE_VIEW, PERMISSIONS.DATABASE_MANAGE,
    PERMISSIONS.PRIVACY_VIEW, PERMISSIONS.PRIVACY_MANAGE,
    PERMISSIONS.USERS_MANAGE, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.API_KEYS_MANAGE,
    PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW, PERMISSIONS.COMPLIANCE_EXPORT,
  ]),
  auditor: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.AI_CONFIG_VIEW,
    PERMISSIONS.NOTIFICATIONS_VIEW, PERMISSIONS.DATABASE_VIEW,
    PERMISSIONS.PRIVACY_VIEW,
    PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW, PERMISSIONS.COMPLIANCE_EXPORT,
  ]),
  monitoring_agent: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW, PERMISSIONS.EVENTS_ACKNOWLEDGE,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW,
  ]),
};

// ── In-memory cache for DB-backed permissions ────────────────

interface CacheEntry {
  permissions: ReadonlySet<Permission>;
  ts: number;
}

const roleCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Invalidate the in-memory permission cache for a specific role or all roles.
 */
export function invalidateRoleCache(roleName?: string): void {
  if (roleName) {
    roleCache.delete(roleName);
  } else {
    roleCache.clear();
  }
}

/**
 * Get the permission set for a user role.
 * Reads from database with in-memory caching.
 * Falls back to hardcoded map if the roles table doesn't exist yet.
 */
export async function getPermissionsForRole(role: string): Promise<ReadonlySet<Permission>> {
  // Check cache
  const cached = roleCache.get(role);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.permissions;
  }

  try {
    const db = getDb();
    const rows: Array<{ permission: string }> = await db('role_permissions')
      .where({ role_name: role })
      .select('permission');

    const perms = new Set<Permission>(rows.map((r) => r.permission as Permission));

    roleCache.set(role, { permissions: perms, ts: Date.now() });
    return perms;
  } catch (err) {
    // Table may not exist yet (pre-migration) — use fallback
    console.warn(`[${localTimestamp()}] WARN: Could not read role_permissions from DB, using fallback. ${err}`);
    return FALLBACK_ROLE_PERMISSIONS[role] ?? new Set();
  }
}

/**
 * Synchronous fallback for contexts where async is not possible.
 * Returns cached permissions or hardcoded fallback.
 */
export function getPermissionsForRoleSync(role: string): ReadonlySet<Permission> {
  const cached = roleCache.get(role);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.permissions;
  return FALLBACK_ROLE_PERMISSIONS[role] ?? new Set();
}

// ── API key scope → Permission mapping ───────────────────────
// Backward compatibility: map legacy scopes to permissions

export const API_KEY_SCOPE_PERMISSIONS: Record<string, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW, PERMISSIONS.EVENTS_ACKNOWLEDGE,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.SYSTEMS_MANAGE,
    PERMISSIONS.AI_CONFIG_VIEW, PERMISSIONS.AI_CONFIG_MANAGE,
    PERMISSIONS.NOTIFICATIONS_VIEW, PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.DATABASE_VIEW, PERMISSIONS.DATABASE_MANAGE,
    PERMISSIONS.PRIVACY_VIEW, PERMISSIONS.PRIVACY_MANAGE,
    PERMISSIONS.USERS_MANAGE, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.API_KEYS_MANAGE,
    PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW, PERMISSIONS.COMPLIANCE_EXPORT,
    PERMISSIONS.INGEST,
  ]),
  ingest: new Set<Permission>([PERMISSIONS.INGEST]),
  read: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW,
  ]),
  dashboard: new Set<Permission>([
    PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.EVENTS_VIEW,
    PERMISSIONS.SYSTEMS_VIEW, PERMISSIONS.RAG_USE, PERMISSIONS.AI_USAGE_VIEW,
  ]),
};

/**
 * Check if a set of granted permissions includes the required permission.
 */
export function hasPermission(
  granted: ReadonlySet<Permission>,
  required: Permission,
): boolean {
  return granted.has(required);
}

/**
 * Get the permission set for an API key scope.
 */
export function getPermissionsForScope(scope: string): ReadonlySet<Permission> {
  return API_KEY_SCOPE_PERMISSIONS[scope] ?? new Set();
}
