import { useEffect, useState, useCallback } from 'react';
import { type LlmUsageRecord, type LlmUsageTotals, type LlmUsageResponse, fetchLlmUsage, fetchSystems, type MonitoredSystem } from '../api';

interface LlmUsageViewProps {
  onAuthError: () => void;
}

type DateRange = '24h' | '7d' | '30d' | 'all';

function formatCost(raw: number | string | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  const cost = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(cost)) return '—';
  if (cost < 0.000001) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(count: number | null): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return '—';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    // new Date('garbage') returns Invalid Date (NaN), doesn't throw
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', {
      timeZone: 'Europe/Chisinau',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function getDateFrom(range: DateRange): string | undefined {
  if (range === 'all') return undefined;
  const now = new Date();
  const hours = range === '24h' ? 24 : range === '7d' ? 168 : 720;
  return new Date(now.getTime() - hours * 3600_000).toISOString();
}

export function LlmUsageView({ onAuthError }: LlmUsageViewProps) {
  const [records, setRecords] = useState<LlmUsageRecord[]>([]);
  const [totals, setTotals] = useState<LlmUsageTotals | null>(null);
  const [model, setModel] = useState('');
  const [pricing, setPricing] = useState<{ input: number; output: number } | null>(null);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('7d');
  const [systemFilter, setSystemFilter] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const opts: { from?: string; system_id?: string } = {};
      const from = getDateFrom(dateRange);
      if (from) opts.from = from;
      if (systemFilter) opts.system_id = systemFilter;

      const data: LlmUsageResponse = await fetchLlmUsage(opts);
      setRecords(data.records);
      setTotals(data.totals);
      setModel(data.current_model);
      setPricing(data.pricing);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication') || msg.includes('401')) {
        onAuthError();
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [dateRange, systemFilter, onAuthError]);

  // Load systems list for filter dropdown
  useEffect(() => {
    fetchSystems()
      .then(setSystems)
      .catch(() => { /* swallow — filter just won't be populated */ });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalInput = Number(totals?.total_input ?? 0);
  const totalOutput = Number(totals?.total_output ?? 0);
  const totalRequests = Number(totals?.total_requests ?? 0);
  const totalCost = totals?.total_cost ?? null;

  return (
    <div className="usage-view">
      <div className="usage-header">
        <div className="usage-header-info">
          <h2>AI Usage Log</h2>
          {model && (
            <span className="usage-model-badge">
              Current model: <strong>{model}</strong>
              {pricing && (
                <span className="usage-pricing-hint">
                  {' '}(${pricing.input}/M in, ${pricing.output}/M out)
                </span>
              )}
            </span>
          )}
        </div>
        <div className="usage-filters">
          <select
            className="usage-filter-select"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRange)}
            aria-label="Time range filter"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          <select
            className="usage-filter-select"
            value={systemFilter}
            onChange={(e) => setSystemFilter(e.target.value)}
            aria-label="System filter"
          >
            <option value="">All systems</option>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            className="btn btn-sm btn-outline"
            onClick={loadData}
            disabled={loading}
            aria-label="Refresh usage data"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-msg" role="alert">{error}</div>}

      {/* Summary cards */}
      <div className="usage-summary">
        <div className="usage-summary-card">
          <div className="usage-summary-label">Total Requests</div>
          <div className="usage-summary-value">{totalRequests.toLocaleString()}</div>
        </div>
        <div className="usage-summary-card">
          <div className="usage-summary-label">Tokens In</div>
          <div className="usage-summary-value">{formatTokens(totalInput)}</div>
        </div>
        <div className="usage-summary-card">
          <div className="usage-summary-label">Tokens Out</div>
          <div className="usage-summary-value">{formatTokens(totalOutput)}</div>
        </div>
        <div className="usage-summary-card usage-summary-cost">
          <div className="usage-summary-label">Estimated Cost</div>
          <div className="usage-summary-value">{formatCost(totalCost)}</div>
        </div>
      </div>

      {/* Records table */}
      {loading && records.length === 0 ? (
        <div className="loading" aria-live="polite">
          <div className="spinner" />
          Loading usage data...
        </div>
      ) : records.length === 0 ? (
        <div className="usage-empty">
          <h3>No AI usage recorded yet</h3>
          <p>
            Usage data will appear here once the AI scoring pipeline has processed events.
            Make sure <code>OPENAI_API_KEY</code> is configured in your backend environment.
          </p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="usage-table" aria-label="LLM API usage log">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>System</th>
                <th>Model</th>
                <th className="col-num">Events</th>
                <th className="col-num">Tokens In</th>
                <th className="col-num">Tokens Out</th>
                <th className="col-num">Requests</th>
                <th className="col-num">Est. Cost</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="usage-ts">{formatDateTime(r.created_at)}</td>
                  <td>
                    <span className={`usage-type-badge ${r.run_type}`}>
                      {r.run_type === 'per_event' ? 'Event Scoring' : r.run_type === 'meta' ? 'Meta Analysis' : r.run_type}
                    </span>
                  </td>
                  <td className="usage-system">{r.system_name ?? '—'}</td>
                  <td className="usage-model">{r.model}</td>
                  <td className="col-num">{r.event_count}</td>
                  <td className="col-num">{r.token_input.toLocaleString()}</td>
                  <td className="col-num">{r.token_output.toLocaleString()}</td>
                  <td className="col-num">{r.request_count}</td>
                  <td className="col-num col-cost">{formatCost(r.cost_estimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {records.length > 0 && (
        <div className="usage-footer">
          <span className="usage-disclaimer">
            Cost estimates are approximate, based on published OpenAI pricing. Actual billing may differ.
          </span>
          <span className="usage-record-count">
            Showing {records.length} record{records.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
