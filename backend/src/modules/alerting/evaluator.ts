import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { sendNotification, type AlertPayload } from './channels.js';
import { CRITERIA } from '../../types/index.js';

/** Dashboard base URL — used to build deep-links in notification payloads.
 *  Validated at startup: must be http/https or empty. */
const RAW_DASHBOARD_URL = (process.env.DASHBOARD_URL ?? '').trim();
const DASHBOARD_URL = RAW_DASHBOARD_URL && /^https?:\/\//i.test(RAW_DASHBOARD_URL)
  ? RAW_DASHBOARD_URL.replace(/\/+$/, '') // strip trailing slashes
  : '';

if (RAW_DASHBOARD_URL && !DASHBOARD_URL) {
  console.warn(
    `[${localTimestamp()}] DASHBOARD_URL="${RAW_DASHBOARD_URL}" is not a valid http/https URL — deep-links in notifications will be disabled.`,
  );
}

/** Build a dashboard deep-link for a system, safely handling existing query params. */
function buildDashboardLink(systemId: string): string | undefined {
  if (!DASHBOARD_URL) return undefined;
  try {
    const url = new URL(DASHBOARD_URL);
    url.searchParams.set('system', systemId);
    return url.toString();
  } catch {
    return `${DASHBOARD_URL}?system=${systemId}`;
  }
}

/**
 * Alert evaluation loop.
 *
 * For each enabled rule:
 * 1. Find (system, criterion) pairs meeting the trigger condition.
 * 2. Check silences — skip if active.
 * 3. Check state: is this a new firing, repeat, or resolution?
 * 4. Apply throttle: skip if within throttle_interval_seconds.
 * 5. Send notification (firing or resolved).
 * 6. Write alert_history.
 *
 * IMPORTANT: windowId is required. Without it, all historical effective scores
 * would trigger alerts, causing runaway spam.
 */
export async function evaluateAlerts(db: Knex, windowId: string): Promise<number> {
  if (!windowId) {
    console.warn(`[${localTimestamp()}] evaluateAlerts called without windowId, skipping.`);
    return 0;
  }

  let sent = 0;

  // Pre-fetch active silences once to avoid N+1 queries per firing pair
  const activeSilences = await loadActiveSilences(db);

  const rules = await db('notification_rules')
    .where('notification_rules.enabled', true)
    .join('notification_channels', 'notification_rules.channel_id', 'notification_channels.id')
    .where('notification_channels.enabled', true)
    .select(
      'notification_rules.*',
      'notification_channels.type as channel_type',
      'notification_channels.config as channel_config',
      'notification_channels.name as channel_name',
    );

  for (const rule of rules) {
    try {
      if (rule.trigger_type !== 'threshold') continue; // schedule rules handled elsewhere

      const triggerConfig = typeof rule.trigger_config === 'string'
        ? JSON.parse(rule.trigger_config)
        : rule.trigger_config;

      const filters = rule.filters
        ? (typeof rule.filters === 'string' ? JSON.parse(rule.filters) : rule.filters)
        : {};

      const channelConfig = typeof rule.channel_config === 'string'
        ? JSON.parse(rule.channel_config)
        : rule.channel_config;

      const minScore = triggerConfig.min_score ?? 0.75;
      const criterionId = triggerConfig.criterion_id;
      const systemIds: string[] = filters.system_ids ?? [];

      // Get effective scores for this window that exceed threshold
      let query = db('effective_scores')
        .where('effective_value', '>=', minScore)
        .where('window_id', windowId);

      if (criterionId) {
        query = query.where('criterion_id', criterionId);
      }

      if (systemIds.length > 0) {
        query = query.whereIn('system_id', systemIds);
      }

      const firingPairs = await query.select('system_id', 'criterion_id', 'effective_value', 'window_id');

      // Track which (system, criterion) pairs are currently firing
      const firingSet = new Set(firingPairs.map((p: any) => `${p.system_id}:${p.criterion_id}`));

      // Process firings
      for (const pair of firingPairs) {
        // Check silence
        if (checkSilenced(activeSilences, rule.id, pair.system_id)) continue;

        // Check last alert state
        const lastAlert = await db('alert_history')
          .where({ rule_id: rule.id, system_id: pair.system_id, criterion_id: pair.criterion_id })
          .orderBy('created_at', 'desc')
          .first();

        const wasFiring = lastAlert?.state === 'firing';

        // State-change-only mode
        if (rule.notify_only_on_state_change && wasFiring) continue;

        // Throttle check
        if (wasFiring && rule.throttle_interval_seconds) {
          const throttleMs = rule.throttle_interval_seconds * 1000;
          const lastAt = new Date(lastAlert.created_at).getTime();
          if (Date.now() - lastAt < throttleMs) continue;
        }

        // Build payload
        const system = await db('monitored_systems').where({ id: pair.system_id }).first();
        const criterion = CRITERIA.find((c) => c.id === Number(pair.criterion_id));
        const severity = scoreSeverity(pair.effective_value);

        const scorePct = (pair.effective_value * 100).toFixed(0);
        const thresholdPct = (minScore * 100).toFixed(0);

        const payload: AlertPayload = {
          title: `[${severity.toUpperCase()}] ${criterion?.name ?? 'Score'} alert — ${system?.name ?? 'Unknown'}`,
          body: `${criterion?.name ?? 'Score'} score reached ${scorePct}% (threshold: ${thresholdPct}%) for system "${system?.name ?? 'Unknown'}".`,
          severity,
          variant: 'firing',
          link: buildDashboardLink(pair.system_id),
          system_name: system?.name,
          criterion: criterion?.name,
        };

        // Send
        try {
          await sendNotification(rule.channel_type, { type: rule.channel_type, ...channelConfig }, payload);
          sent++;
        } catch {
          // Already logged by sendNotification
          continue;
        }

        // Write history
        await db('alert_history').insert({
          id: uuidv4(),
          rule_id: rule.id,
          channel_id: rule.channel_id,
          system_id: pair.system_id,
          window_id: pair.window_id,
          criterion_id: pair.criterion_id,
          state: 'firing',
          severity,
        });
      }

      // Process resolutions
      if (rule.send_recovery) {
        // Find previously firing (system, criterion) pairs for this rule.
        // Check the most recent alert state for each pair.
        const previousFirings = await db('alert_history')
          .where({ rule_id: rule.id })
          .groupBy('system_id', 'criterion_id')
          .select(
            'system_id',
            'criterion_id',
            db.raw('MAX(created_at) as last_at'),
          );

        for (const prev of previousFirings) {
          const key = `${prev.system_id}:${prev.criterion_id}`;

          // Skip if this pair is still firing in the current window
          if (firingSet.has(key)) continue;

          // Get actual last state (the group only gives us the latest timestamp)
          const lastState = await db('alert_history')
            .where({ rule_id: rule.id, system_id: prev.system_id, criterion_id: prev.criterion_id })
            .orderBy('created_at', 'desc')
            .first();

          // Only send resolution if the last state was 'firing'
          if (lastState?.state !== 'firing') continue;

          if (checkSilenced(activeSilences, rule.id, prev.system_id)) continue;

          const system = await db('monitored_systems').where({ id: prev.system_id }).first();
          const criterion = CRITERIA.find((c) => c.id === Number(prev.criterion_id));

          const thresholdPct = (minScore * 100).toFixed(0);

          const payload: AlertPayload = {
            title: `[RESOLVED] ${criterion?.name ?? 'Score'} — ${system?.name ?? 'Unknown'}`,
            body: `${criterion?.name ?? 'Score'} score has dropped below ${thresholdPct}% threshold for system "${system?.name ?? 'Unknown'}". Situation appears to have improved.`,
            severity: 'resolved',
            variant: 'resolved',
            link: buildDashboardLink(prev.system_id),
            system_name: system?.name,
            criterion: criterion?.name,
          };

          try {
            await sendNotification(rule.channel_type, { type: rule.channel_type, ...channelConfig }, payload);
            sent++;
          } catch {
            continue;
          }

          await db('alert_history').insert({
            id: uuidv4(),
            rule_id: rule.id,
            channel_id: rule.channel_id,
            system_id: prev.system_id,
            window_id: windowId,
            criterion_id: prev.criterion_id,
            state: 'resolved',
            severity: 'resolved',
          });
        }
      }
    } catch (err) {
      console.error(`[${localTimestamp()}] Alert evaluation error for rule ${rule.id}:`, err);
    }
  }

  if (sent > 0) {
    console.log(`[${localTimestamp()}] Alert evaluation: ${sent} notifications sent.`);
  }

  return sent;
}

/** Pre-parsed silence with scope extracted once. */
interface ParsedSilence {
  id: string;
  scope: { global?: boolean; system_ids?: string[]; rule_ids?: string[] };
}

/** Load all currently active silences once (called at start of evaluation cycle). */
async function loadActiveSilences(db: Knex): Promise<ParsedSilence[]> {
  const now = new Date().toISOString();
  const rows = await db('silences')
    .where({ enabled: true })
    .where('starts_at', '<=', now)
    .where('ends_at', '>', now); // Exclusive end (silence expires AT ends_at, not after)

  const result: ParsedSilence[] = [];
  for (const silence of rows) {
    try {
      const scope = typeof silence.scope === 'string' ? JSON.parse(silence.scope) : silence.scope;
      result.push({ id: silence.id, scope });
    } catch {
      console.error(`[${localTimestamp()}] Skipping silence ${silence.id}: corrupted scope JSON`);
    }
  }
  return result;
}

/** Synchronous check against pre-fetched silences (no DB hit per call). */
function checkSilenced(silences: ParsedSilence[], ruleId: string, systemId: string): boolean {
  for (const s of silences) {
    if (s.scope.global) return true;
    if (s.scope.system_ids?.includes(systemId)) return true;
    if (s.scope.rule_ids?.includes(ruleId)) return true;
  }
  return false;
}

function scoreSeverity(score: number): string {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}
