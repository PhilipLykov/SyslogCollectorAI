import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { DISCOVERY_DEFAULTS, type DiscoveryConfig } from './groupingEngine.js';
import { computeNormalizedHash } from '../ingest/normalize.js';

export async function registerDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── GET /api/v1/discovery/config ──────────────────────────
  app.get(
    '/api/v1/discovery/config',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_request, reply) => {
      try {
        const row = await db('app_config').where({ key: 'discovery_config' }).first('value');
        let parsed: Record<string, unknown> = {};
        if (row) {
          parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        }
        return reply.send({ ...DISCOVERY_DEFAULTS, ...parsed });
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Failed to load discovery config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to load discovery config.' });
      }
    },
  );

  // ── PUT /api/v1/discovery/config ──────────────────────────
  app.put(
    '/api/v1/discovery/config',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      try {
        const body = request.body as Partial<DiscoveryConfig>;
        const existing = await db('app_config').where({ key: 'discovery_config' }).first('value');
        let current: Record<string, unknown> = { ...DISCOVERY_DEFAULTS };
        if (existing) {
          const parsed = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          if (parsed && typeof parsed === 'object') {
            current = { ...current, ...parsed };
          }
        }

        // Validate and merge
        const allowedKeys = Object.keys(DISCOVERY_DEFAULTS);
        for (const [key, value] of Object.entries(body)) {
          if (allowedKeys.includes(key)) {
            (current as any)[key] = value;
          }
        }

        // Validate specific fields
        if (typeof current.min_events_threshold === 'number' && current.min_events_threshold < 1) {
          return reply.code(400).send({ error: 'min_events_threshold must be >= 1.' });
        }
        if (typeof current.buffer_ttl_hours === 'number' && current.buffer_ttl_hours < 1) {
          return reply.code(400).send({ error: 'buffer_ttl_hours must be >= 1.' });
        }

        await db.raw(`
          INSERT INTO app_config (key, value) VALUES ('discovery_config', ?::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(current)]);

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'discovery_config_update',
          resource_type: 'app_config',
          resource_id: 'discovery_config',
          details: current,
          ip: request.ip,
          user_id: (request as any).currentUser?.id,
          session_id: (request as any).currentSession?.id,
        });

        return reply.send(current);
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Failed to update discovery config: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to update discovery config.' });
      }
    },
  );

  // ── GET /api/v1/discovery/suggestions ─────────────────────
  app.get(
    '/api/v1/discovery/suggestions',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      try {
        const { status } = request.query as { status?: string };
        let query = db('discovery_suggestions')
          .orderBy('event_count', 'desc')
          .orderBy('last_seen_at', 'desc');

        if (status && status !== 'all') {
          query = query.where('status', status);
        } else if (!status) {
          query = query.where('status', 'pending');
        }

        const suggestions = await query.limit(100);

        // Parse JSONB fields
        const parsed = suggestions.map((s: any) => ({
          ...s,
          program_patterns: typeof s.program_patterns === 'string'
            ? JSON.parse(s.program_patterns)
            : s.program_patterns ?? [],
          sample_messages: typeof s.sample_messages === 'string'
            ? JSON.parse(s.sample_messages)
            : s.sample_messages ?? [],
        }));

        return reply.send(parsed);
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Failed to fetch discovery suggestions: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to fetch suggestions.' });
      }
    },
  );

  // ── GET /api/v1/discovery/suggestions/count ───────────────
  app.get(
    '/api/v1/discovery/suggestions/count',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_request, reply) => {
      try {
        const result = await db('discovery_suggestions')
          .where('status', 'pending')
          .count('id as cnt')
          .first();
        return reply.send({ count: Number((result as any)?.cnt ?? 0) });
      } catch {
        return reply.send({ count: 0 });
      }
    },
  );

  // ── POST /api/v1/discovery/suggestions/:id/accept ─────────
  app.post(
    '/api/v1/discovery/suggestions/:id/accept',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as { name?: string; replay_events?: boolean } | undefined;

        const suggestion = await db('discovery_suggestions').where({ id }).first();
        if (!suggestion) return reply.code(404).send({ error: 'Suggestion not found.' });
        if (suggestion.status !== 'pending') return reply.code(409).send({ error: 'Suggestion already processed.' });

        const systemName = body?.name?.trim() || suggestion.suggested_name;
        const systemId = uuidv4();
        const sourceId = uuidv4();
        const now = new Date().toISOString();

        // Build selector — require at least one identifying field
        const selector: Record<string, string> = {};
        if (suggestion.host_pattern) {
          selector.host = `^${escapeRegex(suggestion.host_pattern)}$`;
        }
        if (suggestion.ip_pattern) {
          selector.source_ip = `^${escapeRegex(suggestion.ip_pattern)}$`;
        }

        const programs = typeof suggestion.program_patterns === 'string'
          ? JSON.parse(suggestion.program_patterns)
          : suggestion.program_patterns ?? [];

        if (programs.length === 1) {
          selector.program = `^${escapeRegex(programs[0])}$`;
        }

        if (Object.keys(selector).length === 0) {
          return reply.code(400).send({ error: 'Suggestion has no identifying patterns (host/IP). Cannot create a safe log source.' });
        }

        // Wrap system + source + suggestion status update in a transaction
        await db.transaction(async (trx) => {
          await trx('monitored_systems').insert({
            id: systemId,
            name: systemName,
            description: `Auto-discovered from ${suggestion.host_pattern || suggestion.ip_pattern || 'unknown source'}`,
            created_at: now,
            updated_at: now,
          });

          await trx('log_sources').insert({
            id: sourceId,
            system_id: systemId,
            label: systemName,
            selector: JSON.stringify(selector),
            priority: 50,
            created_at: now,
            updated_at: now,
          });

          await trx('discovery_suggestions')
            .where({ id })
            .update({ status: 'accepted', updated_at: now });
        });

        // Optionally replay buffered events (outside transaction — non-critical)
        if (body?.replay_events) {
          try {
            const buffered = await db('discovery_buffer')
              .modify((qb) => {
                if (suggestion.host_pattern) qb.where('host', suggestion.host_pattern);
                else if (suggestion.ip_pattern) qb.where('source_ip', suggestion.ip_pattern);
              })
              .select('host', 'source_ip', 'program', 'facility', 'severity', 'message_sample', 'received_at')
              .limit(10000);

            if (buffered.length > 0) {
              const CHUNK = 500;
              for (let i = 0; i < buffered.length; i += CHUNK) {
                const chunk = buffered.slice(i, i + CHUNK).map((b: any) => {
                  const msg = b.message_sample || '';
                  return {
                    id: uuidv4(),
                    system_id: systemId,
                    log_source_id: sourceId,
                    message: msg,
                    severity: b.severity || 'info',
                    host: b.host,
                    source_ip: b.source_ip,
                    program: b.program,
                    facility: b.facility,
                    timestamp: b.received_at,
                    received_at: b.received_at,
                    normalized_hash: computeNormalizedHash({
                      timestamp: b.received_at,
                      message: msg,
                      host: b.host ?? null,
                      program: b.program ?? null,
                      source_ip: b.source_ip ?? null,
                      severity: b.severity ?? null,
                      facility: b.facility ?? null,
                      service: null,
                    } as any),
                  };
                });
                await db('events').insert(chunk).onConflict(['normalized_hash', 'timestamp']).ignore();
              }
              logger.info(`[${localTimestamp()}] Discovery: replayed ${buffered.length} buffered events into system ${systemId}`);
            }
          } catch (replayErr: any) {
            logger.warn(`[${localTimestamp()}] Discovery: event replay failed: ${replayErr.message}`);
          }
        }

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'discovery_accept',
          resource_type: 'monitored_system',
          resource_id: systemId,
          details: { suggestion_id: id, system_name: systemName },
          ip: request.ip,
          user_id: (request as any).currentUser?.id,
          session_id: (request as any).currentSession?.id,
        });

        return reply.send({ system_id: systemId, name: systemName });
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Discovery accept failed: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to accept suggestion.' });
      }
    },
  );

  // ── POST /api/v1/discovery/suggestions/:id/merge ──────────
  app.post(
    '/api/v1/discovery/suggestions/:id/merge',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { system_id } = request.body as { system_id: string };

        if (!system_id) return reply.code(400).send({ error: 'system_id is required.' });

        const suggestion = await db('discovery_suggestions').where({ id }).first();
        if (!suggestion) return reply.code(404).send({ error: 'Suggestion not found.' });
        if (suggestion.status !== 'pending') return reply.code(409).send({ error: 'Suggestion already processed.' });

        const system = await db('monitored_systems').where({ id: system_id }).first();
        if (!system) return reply.code(404).send({ error: 'Target system not found.' });

        const now = new Date().toISOString();

        const selector: Record<string, string> = {};
        if (suggestion.host_pattern) {
          selector.host = `^${escapeRegex(suggestion.host_pattern)}$`;
        }
        if (suggestion.ip_pattern) {
          selector.source_ip = `^${escapeRegex(suggestion.ip_pattern)}$`;
        }

        if (Object.keys(selector).length === 0) {
          return reply.code(400).send({ error: 'Suggestion has no identifying patterns (host/IP). Cannot create a safe log source.' });
        }

        await db.transaction(async (trx) => {
          await trx('log_sources').insert({
            id: uuidv4(),
            system_id: system_id,
            label: `${suggestion.suggested_name} (auto-discovered)`,
            selector: JSON.stringify(selector),
            priority: 50,
            created_at: now,
            updated_at: now,
          });

          await trx('discovery_suggestions')
            .where({ id })
            .update({ status: 'merged', merge_target_id: system_id, updated_at: now });
        });

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'discovery_merge',
          resource_type: 'monitored_system',
          resource_id: system_id,
          details: { suggestion_id: id, merged_into: system.name },
          ip: request.ip,
          user_id: (request as any).currentUser?.id,
          session_id: (request as any).currentSession?.id,
        });

        return reply.send({ system_id, name: system.name });
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Discovery merge failed: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to merge suggestion.' });
      }
    },
  );

  // ── POST /api/v1/discovery/suggestions/:id/dismiss ────────
  app.post(
    '/api/v1/discovery/suggestions/:id/dismiss',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { duration?: '24h' | '7d' | 'forever' };
        const { duration } = body;

        const suggestion = await db('discovery_suggestions').where({ id }).first();
        if (!suggestion) return reply.code(404).send({ error: 'Suggestion not found.' });

        const now = new Date();
        let dismissedUntil: string | null = null;
        if (duration === '24h') {
          dismissedUntil = new Date(now.getTime() + 24 * 3600_000).toISOString();
        } else if (duration === '7d') {
          dismissedUntil = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString();
        } else {
          // 'forever' or unspecified: set far future
          dismissedUntil = new Date(now.getTime() + 365 * 10 * 24 * 3600_000).toISOString();
        }

        await db('discovery_suggestions')
          .where({ id })
          .update({
            status: 'dismissed',
            dismissed_until: dismissedUntil,
            updated_at: now.toISOString(),
          });

        await writeAuditLog(db, {
          actor_name: getActorName(request),
          action: 'discovery_dismiss',
          resource_type: 'discovery_suggestion',
          resource_id: id,
          details: { duration: duration || 'forever', suggested_name: suggestion.suggested_name },
          ip: request.ip,
          user_id: (request as any).currentUser?.id,
          session_id: (request as any).currentSession?.id,
        });

        return reply.send({ ok: true });
      } catch (err: any) {
        logger.error(`[${localTimestamp()}] Discovery dismiss failed: ${err.message}`);
        return reply.code(500).send({ error: 'Failed to dismiss suggestion.' });
      }
    },
  );
}

/** Escape special regex characters in a string for use in a regex pattern. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
