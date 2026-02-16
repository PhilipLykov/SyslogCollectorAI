import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { localTimestamp } from '../../config/index.js';
import { CRITERIA } from '../../types/index.js';
import {
  generateNormalPattern,
  patternToRegex,
} from '../pipeline/normalBehavior.js';

/** Default meta-weight for effective score blending (must match metaAnalyze). */
const DEFAULT_W_META = 0.7;

/**
 * Retroactively apply a new normal-behavior template:
 *  1. Zero out event_scores for events matching the pattern within the
 *     configured score display window (default 7 days, from app_config)
 *  2. Recalculate effective_scores for affected windows
 *
 * This ensures the dashboard reflects the change immediately, rather than
 * waiting for the next meta-analysis cycle.
 */
async function retroactivelyApplyTemplate(
  db: Knex,
  patternRegex: string,
  systemId: string | null,
): Promise<{ zeroedEvents: number; updatedWindows: number }> {
  // Use the configured score display window (default 7 days) instead of
  // a hardcoded 24h lookback. This ensures that events within the full
  // dashboard display window get their scores zeroed immediately.
  let windowDays = 7; // default
  try {
    const cfgRow = await db('app_config').where({ key: 'dashboard_config' }).first('value');
    if (cfgRow) {
      const raw = typeof cfgRow.value === 'string' ? JSON.parse(cfgRow.value) : cfgRow.value;
      const d = Number(raw?.score_display_window_days);
      if (Number.isFinite(d) && d >= 1 && d <= 90) windowDays = d;
    }
  } catch { /* use default */ }

  const sinceWindow = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // 1. Zero out event_scores for matching events (PostgreSQL ~* = case-insensitive regex).
  // Cast events.id (UUID) to text — event_scores.event_id is VARCHAR(255).
  const subquery = db('events')
    .select(db.raw('id::text'))
    .where('timestamp', '>=', sinceWindow)
    .whereRaw('message ~* ?', [patternRegex]);

  if (systemId) {
    subquery.where('system_id', systemId);
  }

  const zeroedEvents = await db('event_scores')
    .whereIn('event_id', subquery)
    .where('score', '>', 0)
    .update({ score: 0 });

  if (zeroedEvents === 0) {
    return { zeroedEvents: 0, updatedWindows: 0 };
  }

  // 2. Recalculate effective_scores for recent windows
  const windowQuery = db('windows')
    .where('to_ts', '>=', sinceWindow)
    .select('id', 'system_id', 'from_ts', 'to_ts');

  if (systemId) {
    windowQuery.where('system_id', systemId);
  }

  const windows = await windowQuery;
  let updatedWindows = 0;

  for (const w of windows) {
    let windowUpdated = false;

    for (const criterion of CRITERIA) {
      const existing = await db('effective_scores')
        .where({ window_id: w.id, system_id: w.system_id, criterion_id: criterion.id })
        .first();

      if (!existing) continue;

      // Recalculate max_event_score from event_scores within this window.
      // Use a subquery (not JOIN) for the partitioned events table — more
      // reliable and allows PostgreSQL to prune partitions efficiently.
      // Cast events.id (UUID) to text — event_scores.event_id is VARCHAR(255).
      const windowEventIds = db('events')
        .select(db.raw('id::text'))
        .where('system_id', w.system_id)
        .where('timestamp', '>=', w.from_ts)
        .where('timestamp', '<=', w.to_ts);

      const maxRow = await db('event_scores')
        .whereIn('event_id', windowEventIds)
        .where('criterion_id', criterion.id)
        .max('score as max_score')
        .first();

      const newMaxEvent = Number(maxRow?.max_score ?? 0);
      let metaScore = Number(existing.meta_score) || 0;

      // If ALL events in this window now have score 0 for this criterion,
      // the meta-analysis conclusion (based on those same events) is no longer
      // valid. Zero the meta_score so the effective score drops to 0 as well.
      if (newMaxEvent === 0) {
        metaScore = 0;
      }

      const newEffective = DEFAULT_W_META * metaScore + (1 - DEFAULT_W_META) * newMaxEvent;

      await db('effective_scores')
        .where({ window_id: w.id, system_id: w.system_id, criterion_id: criterion.id })
        .update({
          meta_score: metaScore,
          max_event_score: newMaxEvent,
          effective_value: newEffective,
          updated_at: new Date().toISOString(),
        });

      windowUpdated = true;
    }

    if (windowUpdated) updatedWindows++;
  }

  console.log(
    `[${localTimestamp()}] Retroactive normal-behavior update: zeroed ${zeroedEvents} event_scores, recalculated ${updatedWindows} windows (lookback=${windowDays}d)`,
  );

  return { zeroedEvents, updatedWindows };
}

/**
 * Normal Behavior Templates — CRUD API.
 *
 * Allows users to mark event patterns as "normal behavior" so they
 * are excluded from future AI scoring and meta-analysis.
 */
export async function registerNormalBehaviorRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /** Load an event by ID directly from the events table. */
  async function loadEventById(eventId: string): Promise<{ id: string; message: string; system_id: string } | null> {
    const row = await db('events')
      .where({ id: eventId })
      .select('id', 'message', 'system_id')
      .first();
    return row ?? null;
  }

  // ── Preview: generate pattern from event ───────────────────
  app.post<{
    Body: { event_id?: string; message?: string };
  }>(
    '/api/v1/normal-behavior-templates/preview',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { event_id, message } = request.body ?? {};

      let originalMessage: string;

      if (event_id) {
        const event = await loadEventById(event_id);
        if (!event) {
          return reply.code(404).send({ error: 'Event not found' });
        }
        originalMessage = event.message;
      } else if (message && typeof message === 'string') {
        originalMessage = message;
      } else {
        return reply.code(400).send({ error: 'Provide event_id or message' });
      }

      const suggestedPattern = generateNormalPattern(originalMessage);

      return reply.send({
        original_message: originalMessage,
        suggested_pattern: suggestedPattern,
      });
    },
  );

  // ── Create template ────────────────────────────────────────
  app.post<{
    Body: {
      event_id?: string;
      system_id?: string | null;
      pattern?: string;
      message?: string;
      notes?: string;
    };
  }>(
    '/api/v1/normal-behavior-templates',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body ?? {};
      const username = request.currentUser?.username ?? request.apiKey?.name ?? 'system';

      let pattern: string;
      let originalMessage: string;
      let originalEventId: string | null = null;
      let systemId: string | null = body.system_id ?? null;

      if (body.event_id) {
        const event = await loadEventById(body.event_id);
        if (!event) {
          return reply.code(404).send({ error: 'Event not found' });
        }

        originalMessage = event.message;
        originalEventId = body.event_id;
        if (!systemId) systemId = event.system_id;
        pattern = body.pattern ?? generateNormalPattern(originalMessage);
      } else if (body.pattern) {
        pattern = body.pattern;
        originalMessage = body.message ?? body.pattern;
      } else {
        return reply.code(400).send({ error: 'Provide event_id or pattern' });
      }

      // Validate pattern
      const trimmedPattern = pattern.trim();
      if (!trimmedPattern) {
        return reply.code(400).send({ error: 'Pattern cannot be empty' });
      }
      if (trimmedPattern.length > 2000) {
        return reply.code(400).send({ error: 'Pattern is too long (max 2000 characters)' });
      }

      // Compile and validate regex
      let patternRegex: string;
      try {
        patternRegex = patternToRegex(trimmedPattern);
        new RegExp(patternRegex); // validate
      } catch {
        return reply.code(400).send({ error: 'Generated regex is invalid. Try simplifying the pattern.' });
      }

      const id = uuidv4();
      await db('normal_behavior_templates').insert({
        id,
        system_id: systemId,
        pattern: trimmedPattern,
        pattern_regex: patternRegex,
        original_message: originalMessage,
        original_event_id: originalEventId,
        created_by: username,
        enabled: true,
        notes: body.notes ?? null,
      });

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'normal_behavior_template_create',
        resource_type: 'normal_behavior_template',
        resource_id: id,
        details: { pattern: trimmedPattern, system_id: systemId },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('normal_behavior_templates').where({ id }).first();
      console.log(
        `[${localTimestamp()}] Normal behavior template created by ${username}: "${trimmedPattern}" (system=${systemId ?? 'global'})`,
      );

      // Retroactively zero scores for matching events and recalculate effective scores.
      // This is best-effort: template creation always succeeds even if retroactive update fails.
      let retroResult = { zeroedEvents: 0, updatedWindows: 0 };
      try {
        retroResult = await retroactivelyApplyTemplate(db, patternRegex, systemId);
      } catch (err) {
        console.error(
          `[${localTimestamp()}] Retroactive score update failed (template ${id} still created): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return reply.code(201).send({
        ...created,
        retroactive: {
          zeroed_events: retroResult.zeroedEvents,
          updated_windows: retroResult.updatedWindows,
        },
      });
    },
  );

  // ── List templates ─────────────────────────────────────────
  app.get<{
    Querystring: { system_id?: string; enabled?: string };
  }>(
    '/api/v1/normal-behavior-templates',
    { preHandler: requireAuth(PERMISSIONS.DASHBOARD_VIEW) },
    async (request, reply) => {
      let query = db('normal_behavior_templates').orderBy('created_at', 'desc');

      if (request.query.system_id) {
        query = query.where(function () {
          this.where('system_id', request.query.system_id).orWhereNull('system_id');
        });
      }

      if (request.query.enabled === 'true') {
        query = query.where({ enabled: true });
      } else if (request.query.enabled === 'false') {
        query = query.where({ enabled: false });
      }

      const templates = await query.select('*');
      return reply.send(templates);
    },
  );

  // ── Update template ────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      pattern?: string;
      enabled?: boolean;
      notes?: string;
      system_id?: string | null;
    };
  }>(
    '/api/v1/normal-behavior-templates/:id',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};

      const existing = await db('normal_behavior_templates').where({ id }).first();
      if (!existing) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      const updates: Record<string, unknown> = {};

      if (body.pattern !== undefined && body.pattern !== existing.pattern) {
        const trimmed = body.pattern.trim();
        if (!trimmed) {
          return reply.code(400).send({ error: 'Pattern cannot be empty' });
        }
        if (trimmed.length > 2000) {
          return reply.code(400).send({ error: 'Pattern is too long (max 2000 characters)' });
        }
        try {
          const regex = patternToRegex(trimmed);
          new RegExp(regex); // validate
          updates.pattern = trimmed;
          updates.pattern_regex = regex;
        } catch {
          return reply.code(400).send({ error: 'Generated regex is invalid. Try simplifying the pattern.' });
        }
      }

      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.notes !== undefined) updates.notes = body.notes;
      if (body.system_id !== undefined) updates.system_id = body.system_id;

      if (Object.keys(updates).length === 0) {
        return reply.send(existing);
      }

      await db('normal_behavior_templates').where({ id }).update(updates);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'normal_behavior_template_update',
        resource_type: 'normal_behavior_template',
        resource_id: id,
        details: updates,
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('normal_behavior_templates').where({ id }).first();
      return reply.send(updated);
    },
  );

  // ── Delete template ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/normal-behavior-templates/:id',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await db('normal_behavior_templates').where({ id }).first();
      if (!existing) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      await db('normal_behavior_templates').where({ id }).delete();

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'normal_behavior_template_delete',
        resource_type: 'normal_behavior_template',
        resource_id: id,
        details: { pattern: existing.pattern, system_id: existing.system_id },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      console.log(
        `[${localTimestamp()}] Normal behavior template deleted: "${existing.pattern}" (id=${id})`,
      );

      return reply.code(204).send();
    },
  );
}
