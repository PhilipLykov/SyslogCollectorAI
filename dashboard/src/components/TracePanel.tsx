import { useEffect, useState, useCallback } from 'react';
import { type LogEvent, type TraceEventsResponse, traceEvents } from '../api';

interface Props {
  value: string;
  anchorTime?: string;
  onClose: () => void;
  onAuthError: () => void;
}

/** Deterministic color from system name. */
function systemColor(name: string): string {
  const COLORS = [
    '#818cf8', '#4ade80', '#fb923c', '#f87171', '#facc15',
    '#38bdf8', '#c084fc', '#34d399', '#fbbf24', '#f472b6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

/** Format ISO string as DD.MM.YYYY HH:MM:SS (EU format). */
function formatEuDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  } catch {
    return iso;
  }
}

function formatEuTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return iso;
  }
}

/** Highlight occurrences of `term` in `text`. */
function highlightText(text: string, term: string): React.ReactNode[] {
  if (!term) return [text];
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  let start = 0;
  let idx = lower.indexOf(termLower, start);
  let key = 0;
  while (idx !== -1) {
    if (idx > start) {
      parts.push(text.slice(start, idx));
    }
    parts.push(
      <mark key={key++} className="trace-highlight">
        {text.slice(idx, idx + term.length)}
      </mark>,
    );
    start = idx + term.length;
    idx = lower.indexOf(termLower, start);
  }
  if (start < text.length) {
    parts.push(text.slice(start));
  }
  return parts;
}

export function TracePanel({ value, anchorTime, onClose, onAuthError }: Props) {
  const [traceInput, setTraceInput] = useState(value);
  const [field, setField] = useState<'all' | 'trace_id' | 'message'>('all');
  const [windowHours, setWindowHours] = useState(24);
  const [data, setData] = useState<TraceEventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  const doTrace = useCallback(async () => {
    if (!traceInput.trim()) return;
    setLoading(true);
    setError('');
    setExpandedEvent(null);

    try {
      const result = await traceEvents({
        value: traceInput.trim(),
        field,
        anchor_time: anchorTime,
        window_hours: windowHours,
      });
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [traceInput, field, anchorTime, windowHours, onAuthError]);

  // Auto-trace on open
  useEffect(() => {
    if (value) {
      doTrace();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleEvent = (id: string) => {
    setExpandedEvent((prev) => (prev === id ? null : id));
  };

  return (
    <div className="trace-overlay" onClick={onClose}>
      <div className="trace-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="trace-header">
          <h3>Event Trace</h3>
          <button className="btn btn-sm btn-outline" onClick={onClose} aria-label="Close trace panel">
            Close
          </button>
        </div>

        {/* Search controls */}
        <div className="trace-controls">
          <div className="trace-input-row">
            <input
              type="text"
              className="trace-search-input"
              value={traceInput}
              onChange={(e) => setTraceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doTrace(); }}
              placeholder="Correlation value (CallID, trace_id, etc.)"
            />
            <select
              value={field}
              onChange={(e) => setField(e.target.value as 'all' | 'trace_id' | 'message')}
              className="trace-field-select"
            >
              <option value="all">All fields</option>
              <option value="trace_id">trace_id only</option>
              <option value="message">Message only</option>
            </select>
            <select
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
              className="trace-window-select"
              title="Time window"
            >
              <option value={1}>+/- 1h</option>
              <option value={6}>+/- 6h</option>
              <option value={12}>+/- 12h</option>
              <option value={24}>+/- 24h</option>
              <option value={48}>+/- 48h</option>
              <option value={168}>+/- 7d</option>
            </select>
            <button className="btn btn-accent" onClick={doTrace} disabled={loading}>
              {loading ? '...' : 'Trace'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && <div className="error-msg" role="alert">{error}</div>}

        {/* Loading */}
        {loading && (
          <div className="loading" style={{ padding: '20px' }}>
            <div className="spinner" />
            Tracing...
          </div>
        )}

        {/* Results */}
        {data && !loading && (
          <div className="trace-results">
            {/* Summary */}
            <div className="trace-summary">
              <span>
                <strong>{data.total}</strong> event{data.total !== 1 ? 's' : ''} found
                across <strong>{data.systems.length}</strong> system{data.systems.length !== 1 ? 's' : ''}
              </span>
              <span className="trace-window-label">
                {formatEuDate(data.window.from)} — {formatEuDate(data.window.to)}
              </span>
            </div>

            {/* System legend */}
            {data.systems.length > 1 && (
              <div className="trace-legend">
                {data.systems.map((sg) => (
                  <span key={sg.system_id} className="trace-legend-item">
                    <span
                      className="trace-legend-dot"
                      style={{ backgroundColor: systemColor(sg.system_name) }}
                    />
                    {sg.system_name} ({sg.events.length})
                  </span>
                ))}
              </div>
            )}

            {/* Timeline */}
            <div className="trace-timeline">
              {data.events.map((evt: LogEvent) => (
                <div
                  key={evt.id}
                  className={`trace-event ${expandedEvent === evt.id ? 'expanded' : ''}`}
                  onClick={() => toggleEvent(evt.id)}
                >
                  <div
                    className="trace-event-marker"
                    style={{ backgroundColor: systemColor(evt.system_name ?? '') }}
                  />
                  <div className="trace-event-content">
                    <div className="trace-event-header">
                      <span className="trace-event-time">{formatEuTime(evt.timestamp)}</span>
                      <span className="trace-event-system">{evt.system_name}</span>
                      {evt.severity && (
                        <span className={`severity-badge ${evt.severity.toLowerCase()}`}>
                          {evt.severity}
                        </span>
                      )}
                      <span className="trace-event-host">{evt.host ?? ''}</span>
                      <span className="trace-event-program">{evt.program ?? ''}</span>
                    </div>
                    <div className="trace-event-message">
                      {highlightText(evt.message, traceInput.trim())}
                    </div>

                    {expandedEvent === evt.id && (
                      <div className="trace-event-detail">
                        <div className="ee-detail-grid">
                          <div className="ee-detail-field">
                            <strong>Event ID:</strong> <code>{evt.id}</code>
                          </div>
                          <div className="ee-detail-field">
                            <strong>Timestamp:</strong> {formatEuDate(evt.timestamp)}
                          </div>
                          {evt.trace_id && (
                            <div className="ee-detail-field">
                              <strong>Trace ID:</strong> <code>{evt.trace_id}</code>
                            </div>
                          )}
                          {evt.span_id && (
                            <div className="ee-detail-field">
                              <strong>Span ID:</strong> <code>{evt.span_id}</code>
                            </div>
                          )}
                          {evt.service && (
                            <div className="ee-detail-field">
                              <strong>Service:</strong> {evt.service}
                            </div>
                          )}
                          {evt.facility && (
                            <div className="ee-detail-field">
                              <strong>Facility:</strong> {evt.facility}
                            </div>
                          )}
                        </div>
                        {evt.raw && (
                          <div className="ee-detail-raw" style={{ marginTop: '8px' }}>
                            <strong>Raw:</strong>
                            <pre>{typeof evt.raw === 'string' ? evt.raw : JSON.stringify(evt.raw, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {data.events.length === 0 && (
              <div className="empty-state" style={{ padding: '20px' }}>
                <p>No correlated events found in this time window.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
