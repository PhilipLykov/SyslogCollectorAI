import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';

/** Escape LIKE/ILIKE wildcards in user input. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── GET /api/v1/audit-log ────────────────────────────────────
  // Paginated, filterable audit log. Read-only — no DELETE endpoint.
  app.get<{
    Querystring: {
      page?: string;
      limit?: string;
      action?: string;
      resource_type?: string;
      actor?: string;
      user_id?: string;
      from?: string;
      to?: string;
      search?: string;
    };
  }>(
    '/api/v1/audit-log',
    { preHandler: requireAuth(PERMISSIONS.AUDIT_VIEW) },
    async (request, reply) => {
      const page = Math.max(1, Number(request.query.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
      const offset = (page - 1) * limit;

      let query = db('audit_log')
        .leftJoin('users', 'audit_log.user_id', 'users.id')
        .select(
          'audit_log.*',
          'users.username as username',
          'users.display_name as display_name',
        )
        .orderBy('audit_log.at', 'desc');
      let countQuery = db('audit_log');

      // Filters
      if (request.query.action) {
        query = query.where('action', request.query.action);
        countQuery = countQuery.where('action', request.query.action);
      }
      if (request.query.resource_type) {
        query = query.where('resource_type', request.query.resource_type);
        countQuery = countQuery.where('resource_type', request.query.resource_type);
      }
      if (request.query.actor) {
        query = query.where('actor', 'ilike', `%${escapeLike(request.query.actor)}%`);
        countQuery = countQuery.where('actor', 'ilike', `%${escapeLike(request.query.actor)}%`);
      }
      if (request.query.user_id) {
        query = query.where('user_id', request.query.user_id);
        countQuery = countQuery.where('user_id', request.query.user_id);
      }
      if (request.query.from) {
        query = query.where('at', '>=', request.query.from);
        countQuery = countQuery.where('at', '>=', request.query.from);
      }
      if (request.query.to) {
        query = query.where('at', '<=', request.query.to);
        countQuery = countQuery.where('at', '<=', request.query.to);
      }
      if (request.query.search) {
        const term = `%${request.query.search}%`;
        query = query.where(function () {
          this.where('action', 'ilike', term)
            .orWhere('resource_type', 'ilike', term)
            .orWhere('actor', 'ilike', term)
            .orWhereRaw("CAST(details AS text) ILIKE ?", [term]);
        });
        countQuery = countQuery.where(function () {
          this.where('action', 'ilike', term)
            .orWhere('resource_type', 'ilike', term)
            .orWhere('actor', 'ilike', term)
            .orWhereRaw("CAST(details AS text) ILIKE ?", [term]);
        });
      }

      const [rows, totalResult] = await Promise.all([
        query.clone().offset(offset).limit(limit),
        countQuery.count('id as cnt').first(),
      ]);

      const total = Number(totalResult?.cnt ?? 0);

      // Parse JSON details (safely handle corrupted data)
      const items = rows.map((r: any) => {
        let details = r.details;
        if (typeof details === 'string') {
          try { details = JSON.parse(details); } catch { /* keep as raw string */ }
        }
        return { ...r, details };
      });

      return reply.send({
        items,
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      });
    },
  );

  // ── GET /api/v1/audit-log/export ─────────────────────────────
  // CSV or JSON export for compliance. Auditor + admin only.
  app.get<{
    Querystring: {
      format?: 'csv' | 'json';
      from?: string;
      to?: string;
      action?: string;
      resource_type?: string;
    };
  }>(
    '/api/v1/audit-log/export',
    { preHandler: requireAuth(PERMISSIONS.AUDIT_EXPORT) },
    async (request, reply) => {
      const format = request.query.format || 'json';

      let query = db('audit_log').orderBy('at', 'desc');
      if (request.query.from) query = query.where('at', '>=', request.query.from);
      if (request.query.to) query = query.where('at', '<=', request.query.to);
      if (request.query.action) query = query.where('action', request.query.action);
      if (request.query.resource_type) query = query.where('resource_type', request.query.resource_type);

      // Limit export to 50,000 rows for memory safety
      const rows = await query.limit(50000);

      if (format === 'csv') {
        const header = 'id,at,actor,user_id,session_id,action,resource_type,resource_id,details,ip\n';
        const csvRows = rows.map((r: any) => {
          const details = typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? '');
          return [
            r.id,
            r.at,
            `"${(r.actor ?? '').replace(/"/g, '""')}"`,
            r.user_id ?? '',
            r.session_id ?? '',
            r.action,
            r.resource_type,
            r.resource_id ?? '',
            `"${details.replace(/"/g, '""')}"`,
            r.ip ?? '',
          ].join(',');
        });

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="audit_log_${new Date().toISOString().slice(0, 10)}.csv"`);
        return reply.send(header + csvRows.join('\n'));
      }

      // JSON format (safely handle corrupted data)
      const items = rows.map((r: any) => {
        let details = r.details;
        if (typeof details === 'string') {
          try { details = JSON.parse(details); } catch { /* keep as raw string */ }
        }
        return { ...r, details };
      });

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="audit_log_${new Date().toISOString().slice(0, 10)}.json"`);
      return reply.send(items);
    },
  );

  // ── GET /api/v1/audit-log/actions ────────────────────────────
  // List distinct actions for filter dropdowns
  app.get(
    '/api/v1/audit-log/actions',
    { preHandler: requireAuth(PERMISSIONS.AUDIT_VIEW) },
    async (_request, reply) => {
      const actions = await db('audit_log').distinct('action').orderBy('action');
      const resourceTypes = await db('audit_log').distinct('resource_type').orderBy('resource_type');
      return reply.send({
        actions: actions.map((r: any) => r.action),
        resource_types: resourceTypes.map((r: any) => r.resource_type),
      });
    },
  );
}
