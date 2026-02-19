import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { localTimestamp } from '../../config/index.js';
import {
  generateNormalPattern,
  ensureRegexPattern,
  escapeRegex,
} from '../pipeline/normalBehavior.js';
import { recalcEffectiveScores } from '../events/recalcScores.js';
import { logger } from '../../config/logger.js';

/**
 * Retroactively apply a new normal-behavior template:
 *  1. Zero out event_scores for events matching the pattern within the
 *     configured score display window (default 7 days, from app_config)
 *  2. Recalculate effective_scores via the optimized single-CTE function
 *
 * This ensures the dashboard reflects the change immediately, rather than
 * waiting for the next meta-analysis cycle.
 */
async function retroactivelyApplyTemplate(
  db: Knex,
  patternRegex: string,
  systemId: string | null,
  hostPattern?: string | null,
  programPattern?: string | null,
): Promise<{ zeroedEvents: number; updatedWindows: number }> {
  let windowDays = 7;
  try {
    const cfgRow = await db('app_config').where({ key: 'dashboard_config' }).first('value');
    if (cfgRow) {
      const raw = typeof cfgRow.value === 'string' ? JSON.parse(cfgRow.value) : cfgRow.value;
      const d = Number(raw?.score_display_window_days);
      if (Number.isFinite(d) && d >= 1 && d <= 90) windowDays = d;
    }
  } catch { /* use default */ }

  const sinceWindow = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // 1. Zero out event_scores for matching events (fast, single query)
  const subquery = db('events')
    .select(db.raw('id::text'))
    .where('timestamp', '>=', sinceWindow)
    .whereRaw('message ~* ?', [patternRegex]);

  if (systemId) {
    subquery.where('system_id', systemId);
  }
  if (hostPattern) {
    subquery.whereRaw('host ~* ?', [hostPattern]);
  }
  if (programPattern) {
    subquery.whereRaw('program ~* ?', [programPattern]);
  }

  const zeroedEvents = await db('event_scores')
    .whereIn('event_id', subquery)
    .where('score', '>', 0)
    .update({ score: 0 });

  if (zeroedEvents === 0) {
    return { zeroedEvents: 0, updatedWindows: 0 };
  }

  // 2. Recalculate effective_scores in a single CTE query
  const updatedWindows = await recalcEffectiveScores(db, systemId);

  logger.debug(
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
  async function loadEventById(eventId: string): Promise<{
    id: string; message: string; system_id: string;
    host: string | null; program: string | null;
  } | null> {
    const row = await db('events')
      .where({ id: eventId })
      .select('id', 'message', 'system_id', 'host', 'program')
      .first();
    return row ?? null;
  }

  // ── Preview: generate pattern from event ───────────────────
  app.post<{
    Body: { event_id?: string; message?: string; host?: string; program?: string };
  }>(
    '/api/v1/normal-behavior-templates/preview',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const { event_id, message, host, program } = request.body ?? {};

      let originalMessage: string;
      let eventHost: string | null = host ?? null;
      let eventProgram: string | null = program ?? null;

      if (event_id) {
        const event = await loadEventById(event_id);
        if (!event) {
          return reply.code(404).send({ error: 'Event not found' });
        }
        originalMessage = event.message;
        if (!eventHost) eventHost = event.host;
        if (!eventProgram) eventProgram = event.program;
      } else if (message && typeof message === 'string') {
        originalMessage = message;
      } else {
        return reply.code(400).send({ error: 'Provide event_id or message' });
      }

      const generated = generateNormalPattern(originalMessage, eventHost, eventProgram);

      return reply.send({
        original_message: originalMessage,
        suggested_pattern: generated.pattern,
        suggested_host_pattern: generated.host_pattern,
        suggested_program_pattern: generated.program_pattern,
        host: eventHost,
        program: eventProgram,
      });
    },
  );

  // ── Create template ────────────────────────────────────────
  app.post<{
    Body: {
      event_id?: string;
      system_id?: string | null;
      pattern?: string;
      host_pattern?: string | null;
      program_pattern?: string | null;
      message?: string;
      host?: string;
      program?: string;
      notes?: string;
    };
  }>(
    '/api/v1/normal-behavior-templates',
    { preHandler: requireAuth(PERMISSIONS.EVENTS_ACKNOWLEDGE) },
    async (request, reply) => {
      const body = request.body ?? {};
      const username = request.currentUser?.username ?? request.apiKey?.name ?? 'system';

      let pattern: string;
      let hostPattern: string | null = body.host_pattern ?? null;
      let programPattern: string | null = body.program_pattern ?? null;
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

        if (body.pattern) {
          // User provided a custom regex pattern
          pattern = body.pattern;
        } else {
          // Auto-generate regex from event message + metadata
          const generated = generateNormalPattern(originalMessage, event.host, event.program);
          pattern = generated.pattern;
          if (hostPattern === null && generated.host_pattern) hostPattern = generated.host_pattern;
          if (programPattern === null && generated.program_pattern) programPattern = generated.program_pattern;
        }
      } else if (body.pattern) {
        pattern = body.pattern;
        originalMessage = body.message ?? body.pattern;
        // Auto-generate host/program patterns from provided metadata
        if (hostPattern === null && body.host) {
          hostPattern = `^${escapeRegex(body.host)}$`;
        }
        if (programPattern === null && body.program) {
          programPattern = `^${escapeRegex(body.program)}$`;
        }
      } else {
        return reply.code(400).send({ error: 'Provide event_id or pattern' });
      }

      // Validate message pattern
      const trimmedPattern = pattern.trim();
      if (!trimmedPattern) {
        return reply.code(400).send({ error: 'Pattern cannot be empty' });
      }
      if (trimmedPattern.length > 4000) {
        return reply.code(400).send({ error: 'Pattern is too long (max 4000 characters)' });
      }

      // Ensure the pattern is proper regex (convert legacy wildcards if needed)
      const patternRegex = ensureRegexPattern(trimmedPattern);

      // Validate all regexes
      try {
        new RegExp(patternRegex, 'i');
      } catch {
        return reply.code(400).send({ error: 'Invalid message pattern regex. Check syntax.' });
      }
      if (hostPattern) {
        try { new RegExp(hostPattern, 'i'); } catch {
          return reply.code(400).send({ error: 'Invalid host pattern regex. Check syntax.' });
        }
      }
      if (programPattern) {
        try { new RegExp(programPattern, 'i'); } catch {
          return reply.code(400).send({ error: 'Invalid program pattern regex. Check syntax.' });
        }
      }

      // Normalise empty strings to null
      if (hostPattern !== null && hostPattern.trim() === '') hostPattern = null;
      if (programPattern !== null && programPattern.trim() === '') programPattern = null;

      const id = uuidv4();
      await db('normal_behavior_templates').insert({
        id,
        system_id: systemId,
        pattern: patternRegex,
        pattern_regex: patternRegex,
        host_pattern: hostPattern,
        program_pattern: programPattern,
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
        details: {
          pattern: patternRegex, system_id: systemId,
          host_pattern: hostPattern, program_pattern: programPattern,
        },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('normal_behavior_templates').where({ id }).first();
      logger.debug(
        `[${localTimestamp()}] Normal behavior template created by ${username}: regex (system=${systemId ?? 'global'}, host=${hostPattern ?? 'any'}, program=${programPattern ?? 'any'})`,
      );

      // Retroactively zero scores for matching events and recalculate effective scores.
      let retroResult = { zeroedEvents: 0, updatedWindows: 0 };
      try {
        retroResult = await retroactivelyApplyTemplate(db, patternRegex, systemId, hostPattern, programPattern);
      } catch (err) {
        logger.error(
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
      host_pattern?: string | null;
      program_pattern?: string | null;
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
        if (trimmed.length > 4000) {
          return reply.code(400).send({ error: 'Pattern is too long (max 4000 characters)' });
        }
        const regex = ensureRegexPattern(trimmed);
        try {
          new RegExp(regex, 'i');
        } catch {
          return reply.code(400).send({ error: 'Invalid message pattern regex. Check syntax.' });
        }
        updates.pattern = regex;
        updates.pattern_regex = regex;
      }

      if (body.host_pattern !== undefined) {
        const hp = (typeof body.host_pattern === 'string' && body.host_pattern.trim()) ? body.host_pattern.trim() : null;
        if (hp) {
          try { new RegExp(hp, 'i'); } catch {
            return reply.code(400).send({ error: 'Invalid host pattern regex. Check syntax.' });
          }
        }
        updates.host_pattern = hp;
      }

      if (body.program_pattern !== undefined) {
        const pp = (typeof body.program_pattern === 'string' && body.program_pattern.trim()) ? body.program_pattern.trim() : null;
        if (pp) {
          try { new RegExp(pp, 'i'); } catch {
            return reply.code(400).send({ error: 'Invalid program pattern regex. Check syntax.' });
          }
        }
        updates.program_pattern = pp;
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

      logger.debug(
        `[${localTimestamp()}] Normal behavior template deleted: "${existing.pattern}" (id=${id})`,
      );

      return reply.code(204).send();
    },
  );
}
