import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { sendNotification, type AlertPayload } from './channels.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';

/**
 * Alerting API: CRUD for channels, rules, silences; alert history; test notification.
 * Auth: admin scope required. Parameterized queries (A03).
 */
export async function registerAlertingRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ═══ NOTIFICATION CHANNELS ═════════════════════════════════

  app.get(
    '/api/v1/notification-channels',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_VIEW) },
    async (_req, reply) => {
      const channels = await db('notification_channels').orderBy('name').select('*');
      return reply.send(channels.map(parseJsonFields));
    },
  );

  app.post(
    '/api/v1/notification-channels',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const { type, name, config, enabled, scope } = request.body as any;

      if (!type || !name || !config) {
        return reply.code(400).send({ error: 'type, name, and config are required.' });
      }

      const validTypes = ['webhook', 'pushover', 'ntfy', 'gotify', 'telegram'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` });
      }

      const id = uuidv4();
      await db('notification_channels').insert({
        id,
        type,
        name,
        config: JSON.stringify(config),
        enabled: enabled ?? true,
        scope: scope ?? 'global',
      });

      app.log.info(`[${localTimestamp()}] Channel created: ${type}/${name} (${id})`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'channel_create',
        resource_type: 'notification_channel',
        resource_id: id,
        details: { type, name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('notification_channels').where({ id }).first();
      return reply.code(201).send(parseJsonFields(created));
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/notification-channels/:id',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('notification_channels').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Channel not found' });

      const { name, config, enabled, scope } = request.body as any;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (name !== undefined) updates.name = name;
      if (config !== undefined) updates.config = JSON.stringify(config);
      if (enabled !== undefined) updates.enabled = enabled;
      if (scope !== undefined) updates.scope = scope;

      await db('notification_channels').where({ id }).update(updates);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'channel_update',
        resource_type: 'notification_channel',
        resource_id: id,
        details: { ...updates },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('notification_channels').where({ id }).first();
      return reply.send(parseJsonFields(updated));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/notification-channels/:id',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('notification_channels').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Channel not found' });

      // Check if any rules reference this channel
      const referencingRules = await db('notification_rules').where({ channel_id: id }).count('id as cnt').first();
      if (Number(referencingRules?.cnt ?? 0) > 0) {
        return reply.code(409).send({
          error: 'Cannot delete channel: it is referenced by notification rules. Delete the rules first.',
        });
      }

      await db('notification_channels').where({ id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'channel_delete',
        resource_type: 'notification_channel',
        resource_id: id,
        details: { name: existing.name },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );

  // ── Test notification ──────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/notification-channels/:id/test',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const channel = await db('notification_channels').where({ id: request.params.id }).first();
      if (!channel) return reply.code(404).send({ error: 'Channel not found' });

      let config = channel.config;
      if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch {
          return reply.code(500).send({ error: 'Channel config is corrupted. Update the channel and try again.' });
        }
      }
      const payload: AlertPayload = {
        title: 'Test Notification — LogSentinel AI',
        body: `This is a test notification sent at ${localTimestamp()}. If you see this message, the notification channel "${channel.name}" is configured correctly and working.`,
        severity: 'medium',
        variant: 'firing',
        system_name: 'Test System',
        criterion: 'IT Security',
      };

      try {
        await sendNotification(channel.type, { type: channel.type, ...config }, payload);
        return reply.send({ status: 'ok', message: 'Test notification sent successfully.' });
      } catch (err: any) {
        return reply.code(500).send({ error: err.message ?? 'Failed to send test notification.' });
      }
    },
  );

  // ═══ NOTIFICATION RULES ════════════════════════════════════

  app.get(
    '/api/v1/notification-rules',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_VIEW) },
    async (_req, reply) => {
      const rules = await db('notification_rules').orderBy('created_at', 'desc').select('*');
      return reply.send(rules.map(parseJsonFields));
    },
  );

  app.post(
    '/api/v1/notification-rules',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const body = request.body as any;

      if (!body.channel_id || !body.trigger_type || !body.trigger_config) {
        return reply.code(400).send({ error: 'channel_id, trigger_type, and trigger_config are required.' });
      }

      const validTriggerTypes = ['threshold'];
      if (!validTriggerTypes.includes(body.trigger_type)) {
        return reply.code(400).send({
          error: `trigger_type must be one of: ${validTriggerTypes.join(', ')}`,
        });
      }

      // Verify channel exists
      const channel = await db('notification_channels').where({ id: body.channel_id }).first();
      if (!channel) return reply.code(400).send({ error: 'Channel not found.' });

      const id = uuidv4();
      await db('notification_rules').insert({
        id,
        channel_id: body.channel_id,
        trigger_type: body.trigger_type,
        trigger_config: JSON.stringify(body.trigger_config),
        filters: body.filters ? JSON.stringify(body.filters) : null,
        throttle_interval_seconds: body.throttle_interval_seconds ?? null,
        send_recovery: body.send_recovery ?? true,
        notify_only_on_state_change: body.notify_only_on_state_change ?? true,
        template_title: body.template_title ?? null,
        template_body: body.template_body ?? null,
        enabled: body.enabled ?? true,
      });

      app.log.info(`[${localTimestamp()}] Rule created: ${body.trigger_type} (${id})`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'rule_create',
        resource_type: 'notification_rule',
        resource_id: id,
        details: { trigger_type: body.trigger_type, channel_id: body.channel_id },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('notification_rules').where({ id }).first();
      return reply.code(201).send(parseJsonFields(created));
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/notification-rules/:id',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('notification_rules').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Rule not found' });

      const body = request.body as any;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      if (body.trigger_config !== undefined) updates.trigger_config = JSON.stringify(body.trigger_config);
      if (body.filters !== undefined) updates.filters = body.filters ? JSON.stringify(body.filters) : null;
      if (body.throttle_interval_seconds !== undefined) updates.throttle_interval_seconds = body.throttle_interval_seconds;
      if (body.send_recovery !== undefined) updates.send_recovery = body.send_recovery;
      if (body.notify_only_on_state_change !== undefined) updates.notify_only_on_state_change = body.notify_only_on_state_change;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.template_title !== undefined) updates.template_title = body.template_title;
      if (body.template_body !== undefined) updates.template_body = body.template_body;

      await db('notification_rules').where({ id }).update(updates);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'rule_update',
        resource_type: 'notification_rule',
        resource_id: id,
        details: { ...updates },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('notification_rules').where({ id }).first();
      return reply.send(parseJsonFields(updated));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/notification-rules/:id',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const existing = await db('notification_rules').where({ id: request.params.id }).first();
      if (!existing) return reply.code(404).send({ error: 'Rule not found' });
      await db('notification_rules').where({ id: request.params.id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'rule_delete',
        resource_type: 'notification_rule',
        resource_id: request.params.id,
        details: { trigger_type: existing.trigger_type },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );

  // ═══ SILENCES ══════════════════════════════════════════════

  app.get(
    '/api/v1/silences',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_VIEW) },
    async (_req, reply) => {
      const silences = await db('silences').orderBy('starts_at', 'desc').select('*');
      return reply.send(silences.map(parseJsonFields));
    },
  );

  app.post(
    '/api/v1/silences',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const body = request.body as any;

      if (!body.starts_at || !body.ends_at || !body.scope) {
        return reply.code(400).send({ error: 'starts_at, ends_at, and scope are required.' });
      }

      // Validate scope: must have at least one of global, system_ids, or rule_ids.
      // An empty scope {} is ambiguous (silences nothing) — reject it.
      const scope = body.scope;
      if (typeof scope !== 'object' || Array.isArray(scope)) {
        return reply.code(400).send({ error: 'scope must be a non-array object.' });
      }
      if (!scope.global && !scope.system_ids?.length && !scope.rule_ids?.length) {
        return reply.code(400).send({
          error: 'scope must specify at least one of: global (true), system_ids (non-empty array), or rule_ids (non-empty array).',
        });
      }

      // Validate date strings
      if (isNaN(Date.parse(body.starts_at)) || isNaN(Date.parse(body.ends_at))) {
        return reply.code(400).send({ error: 'starts_at and ends_at must be valid ISO date strings.' });
      }

      if (new Date(body.ends_at) <= new Date(body.starts_at)) {
        return reply.code(400).send({ error: 'ends_at must be after starts_at.' });
      }

      const id = uuidv4();
      await db('silences').insert({
        id,
        name: body.name ?? null,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        scope: JSON.stringify(body.scope),
        comment: body.comment ?? null,
        enabled: body.enabled ?? true,
      });

      app.log.info(`[${localTimestamp()}] Silence created: ${id}`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'silence_create',
        resource_type: 'silence',
        resource_id: id,
        details: { starts_at: body.starts_at, ends_at: body.ends_at },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('silences').where({ id }).first();
      return reply.code(201).send(parseJsonFields(created));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/silences/:id',
    { preHandler: requireAuth(PERMISSIONS.NOTIFICATIONS_MANAGE) },
    async (request, reply) => {
      const existing = await db('silences').where({ id: request.params.id }).first();
      if (!existing) return reply.code(404).send({ error: 'Silence not found' });
      await db('silences').where({ id: request.params.id }).del();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'silence_delete',
        resource_type: 'silence',
        resource_id: request.params.id,
        details: {},
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );

  // ═══ ALERT HISTORY ═════════════════════════════════════════

  app.get<{ Querystring: { system_id?: string; rule_id?: string; state?: string; from?: string; to?: string; limit?: string } }>(
    '/api/v1/alerts',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      let query = db('alert_history').orderBy('created_at', 'desc');

      if (request.query.system_id) query = query.where({ system_id: request.query.system_id });
      if (request.query.rule_id) query = query.where({ rule_id: request.query.rule_id });
      if (request.query.state) query = query.where({ state: request.query.state });
      if (request.query.from) query = query.where('created_at', '>=', request.query.from);
      if (request.query.to) query = query.where('created_at', '<=', request.query.to);

      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 100;
      query = query.limit(limit);

      const alerts = await query.select('*');
      return reply.send(alerts);
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────

function parseJsonFields(row: any): any {
  if (!row) return row;
  const result = { ...row };
  for (const key of ['config', 'trigger_config', 'filters', 'scope']) {
    if (typeof result[key] === 'string') {
      try { result[key] = JSON.parse(result[key]); } catch { /* keep as string */ }
    }
  }
  return result;
}
