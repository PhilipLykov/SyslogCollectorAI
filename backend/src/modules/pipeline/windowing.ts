import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { getEventSource } from '../../services/eventSourceFactory.js';

const DEFAULT_WINDOW_MINUTES = 5;

/**
 * Create time-based windows for each monitored system.
 * Tumbling windows: each window covers [from_ts, to_ts) with no overlap.
 *
 * If the gap since the last window exceeds windowMinutes, multiple windows
 * are created to avoid oversized windows that degrade meta-analysis quality.
 *
 * Returns newly created window IDs.
 */
export async function createWindows(
  db: Knex,
  options?: { windowMinutes?: number },
): Promise<Array<{ id: string; system_id: string; from_ts: string; to_ts: string }>> {
  const windowMinutes = options?.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const windowMs = windowMinutes * 60 * 1000;
  const now = new Date();
  // Get all monitored systems (with full row for EventSource dispatch)
  const systems = await db('monitored_systems').select('*');
  const created: Array<{ id: string; system_id: string; from_ts: string; to_ts: string }> = [];

  for (const system of systems) {
    try {
      const eventSource = getEventSource(system, db);
      // Find the latest window end for this system
      const lastWindow = await db('windows')
        .where({ system_id: system.id })
        .orderBy('to_ts', 'desc')
        .first();

      let fromTime: number;
      if (lastWindow) {
        fromTime = new Date(lastWindow.to_ts).getTime();
      } else {
        // First window: start from windowMinutes ago
        fromTime = now.getTime() - windowMs;
      }

      // Create multiple windows if the gap is larger than windowMinutes
      while (fromTime + windowMs <= now.getTime()) {
        const from_ts = new Date(fromTime).toISOString();
        const to_ts = new Date(fromTime + windowMs).toISOString();

        // Check if there are events in this range — via EventSource abstraction
        const eventCount = await eventSource.countEventsInTimeRange(system.id, from_ts, to_ts);

        if (eventCount > 0) {
          const id = uuidv4();
          await db('windows').insert({
            id,
            system_id: system.id,
            from_ts,
            to_ts,
            trigger: 'time',
          });

          created.push({ id, system_id: system.id, from_ts, to_ts });
        }

        fromTime += windowMs;
      }
    } catch (err: any) {
      // Per-system error handling: log and continue with other systems.
      // Prevents one failing system (e.g. ES connection down) from blocking all.
      console.error(
        `[${localTimestamp()}] Windowing: error processing system "${system.name}" (${system.id}): ${err.message}`,
      );
    }
  }

  if (created.length > 0) {
    console.log(`[${localTimestamp()}] Windows created: ${created.length}`);
  }

  return created;
}
