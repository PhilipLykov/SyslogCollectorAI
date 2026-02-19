import type { ConnectorAdapter } from './interface.js';
import type { NormalizedEvent } from '../../types/index.js';
import { logger } from '../../config/logger.js';
import { resolveEnvRef } from './envRef.js';
import { validateUrl } from './urlValidation.js';

/**
 * Pull connector for Grafana Loki.
 *
 * Polls the LogQL query_range API with a time filter.
 * Maps log streams to normalized events.
 *
 * Config: { url, query, auth_header_ref? }
 * query example: '{job="syslog"}'
 */
export class LokiConnector implements ConnectorAdapter {
  readonly type = 'pull_loki';

  async fetchLogs(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<{ events: NormalizedEvent[]; newCursor: string | null }> {
    const url = (config.url ?? '') as string;
    const query = (config.query ?? '{job="syslog"}') as string;
    const authRef = config.auth_header_ref as string | undefined;

    if (!url) throw new Error('Loki URL not configured');
    validateUrl(url);

    // Loki uses nanosecond timestamps
    const startNs = cursor
      ? cursor
      : String((Date.now() - 5 * 60 * 1000) * 1_000_000);
    const endNs = String(Date.now() * 1_000_000);

    const params = new URLSearchParams({
      query,
      start: startNs,
      end: endNs,
      limit: '1000',
      direction: 'forward',
    });

    const headers: Record<string, string> = {};
    if (authRef) {
      const val = resolveEnvRef(authRef);
      if (val) headers.Authorization = val;
    }

    const res = await fetch(`${url}/loki/api/v1/query_range?${params}`, {
      headers,
      redirect: 'error', // SSRF: prevent redirects to internal IPs
    });

    if (!res.ok) throw new Error(`Loki ${res.status}: ${await res.text()}`);

    const data = await res.json() as any;
    const streams = data.data?.result ?? [];

    const events: NormalizedEvent[] = [];
    let maxTs = startNs;

    for (const stream of streams) {
      const labels = stream.stream ?? {};
      for (const [ts, line] of stream.values ?? []) {
        try {
          const tsBI = BigInt(ts);
          events.push({
            timestamp: new Date(Number(tsBI / 1_000_000n)).toISOString(),
            message: line,
            severity: labels.level ?? labels.severity,
            host: labels.host ?? labels.hostname ?? labels.instance,
            service: labels.job ?? labels.service,
            facility: labels.facility,
            program: labels.app ?? labels.program,
            raw: labels,
          });
          if (tsBI > BigInt(maxTs)) maxTs = ts;
        } catch {
          // Skip entries with non-numeric timestamps to avoid blocking the connector
          logger.warn(`Loki: skipping entry with invalid timestamp: ${String(ts).slice(0, 50)}`);
        }
      }
    }

    // Next cursor = last timestamp + 1 nanosecond (avoid re-fetch)
    const newCursor = events.length > 0
      ? String(BigInt(maxTs) + 1n)
      : endNs;

    return { events, newCursor };
  }
}
