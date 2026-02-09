import { useEffect, useState, useCallback } from 'react';
import {
  type AlertHistoryRecord,
  type MonitoredSystem,
  type NotificationChannel,
  type NotificationRule,
  CRITERIA,
  fetchAlertHistory,
  fetchSystems,
  fetchNotificationChannels,
  fetchNotificationRules,
} from '../api';

interface AlertHistoryPanelProps {
  onAuthError: () => void;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', {
      timeZone: 'Europe/Chisinau',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return iso; }
}

function criterionName(id: number | null | undefined): string {
  if (id == null) return '—';
  const c = CRITERIA.find((c) => c.id === Number(id));
  return c?.name ?? `#${id}`;
}

export function AlertHistoryPanel({ onAuthError }: AlertHistoryPanelProps) {
  const [alerts, setAlerts] = useState<AlertHistoryRecord[]>([]);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [stateFilter, setStateFilter] = useState<string>('');
  const [systemFilter, setSystemFilter] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');

      const [alertsData, systemsData, channelsData, rulesData] = await Promise.all([
        fetchAlertHistory({
          state: stateFilter || undefined,
          system_id: systemFilter || undefined,
          limit: 200,
        }),
        fetchSystems(),
        fetchNotificationChannels(),
        fetchNotificationRules(),
      ]);
      setAlerts(alertsData);
      setSystems(systemsData);
      setChannels(channelsData);
      setRules(rulesData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError, stateFilter, systemFilter]);

  useEffect(() => { load(); }, [load]);

  const systemName = (id: string) =>
    systems.find((s) => s.id === id)?.name ?? 'Unknown';

  const channelInfo = (channelId: string) => {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? `${ch.name} (${ch.type})` : 'Unknown';
  };

  const ruleSummary = (ruleId: string) => {
    const r = rules.find((r) => r.id === ruleId);
    if (!r) return '—';
    const tc = r.trigger_config as { min_score?: number; criterion_id?: number };
    const pct = Math.round((tc.min_score ?? 0.5) * 100);
    return `${criterionName(tc.criterion_id)} ≥ ${pct}%`;
  };

  if (loading) {
    return <div className="settings-loading"><div className="spinner" /> Loading alert history…</div>;
  }

  return (
    <div className="alert-history-panel">
      <div className="notif-header">
        <div>
          <h3>Alert History</h3>
          <p className="notif-desc">
            Recent notifications sent by the alerting system. Shows both firing and recovery events.
          </p>
        </div>
        <div className="alert-history-filters">
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="usage-filter-select"
            aria-label="Filter by state"
          >
            <option value="">All states</option>
            <option value="firing">Firing</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            value={systemFilter}
            onChange={(e) => setSystemFilter(e.target.value)}
            className="usage-filter-select"
            aria-label="Filter by system"
          >
            <option value="">All systems</option>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#128203;</div>
          <h4>No alerts yet</h4>
          <p>
            {stateFilter || systemFilter
              ? 'No alerts match the current filters. Try changing the filter.'
              : 'Alerts will appear here once rules are triggered by score thresholds.'}
          </p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="alert-history-table" aria-label="Alert history">
            <thead>
              <tr>
                <th>Time</th>
                <th>State</th>
                <th>Severity</th>
                <th>System</th>
                <th>Criterion</th>
                <th>Rule</th>
                <th>Channel</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td className="usage-ts">{formatDateTime(a.created_at)}</td>
                  <td>
                    <span className={`alert-state-badge ${a.state}`}>
                      {a.state}
                    </span>
                  </td>
                  <td>
                    {a.severity && (
                      <span className={`severity-badge ${a.severity}`}>
                        {a.severity}
                      </span>
                    )}
                  </td>
                  <td>{systemName(a.system_id)}</td>
                  <td>{criterionName(a.criterion_id)}</td>
                  <td className="alert-rule-ref">{ruleSummary(a.rule_id)}</td>
                  <td>{channelInfo(a.channel_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="usage-footer">
        <span className="usage-record-count">{alerts.length} alert{alerts.length !== 1 ? 's' : ''} shown (max 200)</span>
      </div>
    </div>
  );
}
