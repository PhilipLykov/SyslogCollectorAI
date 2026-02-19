import type { Knex } from 'knex';
import type { NormalizedEvent, LogSource, LogSourceSelector } from '../../types/index.js';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

/**
 * Cached log sources, sorted by priority (ascending = evaluated first).
 * Reloaded when the cache is invalidated (e.g. after source create/update/delete).
 *
 * Uses a generation counter to prevent a stale in-flight load from overwriting
 * a newer cache after invalidation.
 */
let _cachedSources: LogSource[] | null = null;
let _loadPromise: Promise<LogSource[]> | null = null;
let _generation = 0;

export function invalidateSourceCache(): void {
  _cachedSources = null;
  _loadPromise = null;
  _generation++;
}

async function loadSources(db: Knex): Promise<LogSource[]> {
  if (_cachedSources) return _cachedSources;

  // Prevent thundering herd: reuse in-flight promise
  if (_loadPromise) return _loadPromise;

  const gen = _generation;

  const promise = (async () => {
    const rows = await db('log_sources').orderBy('priority', 'asc').select('*');
    const sources = rows.map((r: any) => {
      let selector: LogSourceSelector = {};
      try {
        selector = typeof r.selector === 'string' ? JSON.parse(r.selector) : (r.selector ?? {});
      } catch {
        logger.error(`[${localTimestamp()}] Invalid JSON selector for log_source ${r.id}, skipping.`);
      }
      if (!selector || typeof selector !== 'object') {
        selector = {};
      }
      return { ...r, selector };
    });

    // Only write to cache if generation hasn't changed during our load.
    // If invalidateSourceCache() was called while we were loading, our data
    // is potentially stale — discard it and let the next caller retry.
    if (_generation === gen) {
      _cachedSources = sources;
    }

    return sources;
  })().finally(() => {
    // Only clear if this is still the current in-flight promise
    if (_loadPromise === promise) {
      _loadPromise = null;
    }
  });

  _loadPromise = promise;
  return _loadPromise;
}

/**
 * Match a normalized event to a log source by evaluating selectors
 * in priority order. Returns { system_id, log_source_id } or null.
 *
 * Selector matching: each key in the selector must match the corresponding
 * field on the event (case-insensitive substring or exact). An empty selector
 * matches nothing.
 */
export async function matchSource(
  db: Knex,
  event: NormalizedEvent,
): Promise<{ system_id: string; log_source_id: string } | null> {
  const sources = await loadSources(db);

  for (const source of sources) {
    if (matchesSelector(event, source.selector)) {
      return { system_id: source.system_id, log_source_id: source.id };
    }
  }

  return null;
}

function matchesSelector(event: NormalizedEvent, selector: LogSourceSelector): boolean {
  if (!selector || typeof selector !== 'object') return false;

  const entries = Object.entries(selector).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return false; // empty selector matches nothing

  for (const [key, pattern] of entries) {
    let eventValue: unknown = (event as any)[key];

    // If key is not a direct event field, check inside raw
    if (eventValue === undefined && event.raw) {
      eventValue = event.raw[key];
    }

    if (eventValue === undefined || eventValue === null) {
      // Universal wildcard patterns match even missing fields (catch-all support).
      // Without this, a catch-all like {"host": ".*"} fails for events that lack a host field.
      const pat = String(pattern);
      if (pat === '.*' || pat === '^.*$' || pat === '.+' || pat === '^.+$') continue;
      return false;
    }

    const ev = String(eventValue);

    // Selector values are regex patterns (case-insensitive)
    try {
      const regex = new RegExp(String(pattern), 'i');
      if (!regex.test(ev)) return false;
    } catch {
      // If the pattern is not a valid regex, fall back to exact match (case-insensitive)
      if (ev.toLowerCase() !== String(pattern).toLowerCase()) return false;
    }
  }

  return true;
}
