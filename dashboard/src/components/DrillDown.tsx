import { useEffect, useState, useRef, useCallback } from 'react';
import {
  type DashboardSystem,
  type LogEvent,
  type MetaResult,
  type EventScoreRecord,
  CRITERIA,
  fetchSystemEvents,
  fetchSystemMeta,
  fetchEventScores,
} from '../api';
import { ScoreBars, CRITERIA_LABELS } from './ScoreBar';

interface DrillDownProps {
  system: DashboardSystem;
  onBack: () => void;
  onAuthError: () => void;
}

export function DrillDown({ system, onBack, onAuthError }: DrillDownProps) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [meta, setMeta] = useState<MetaResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Criterion drill-down state
  const [selectedCriterion, setSelectedCriterion] = useState<string | null>(null);
  const [criterionEvents, setCriterionEvents] = useState<EventScoreRecord[]>([]);
  const [criterionLoading, setCriterionLoading] = useState(false);
  const [criterionError, setCriterionError] = useState('');

  // Stable reference for auth error handler
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  const loadData = useCallback(() => {
    setLoading(true);
    setError('');

    Promise.all([
      fetchSystemEvents(system.id, { limit: 100 }),
      fetchSystemMeta(system.id).catch(() => null),
    ])
      .then(([evts, m]) => {
        setEvents(evts);
        setMeta(m);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Authentication')) {
          onAuthErrorRef.current();
          return;
        }
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [system.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Move focus to heading on mount for accessibility
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const toggleRow = (id: string) => {
    setExpandedRow((prev) => (prev === id ? null : id));
  };

  // ── Criterion click handler ─────────────────────────────
  const handleCriterionClick = useCallback(async (slug: string) => {
    // Toggle off if already selected
    if (selectedCriterion === slug) {
      setSelectedCriterion(null);
      setCriterionEvents([]);
      return;
    }

    setSelectedCriterion(slug);
    setCriterionLoading(true);
    setCriterionError('');

    // Find criterion ID from slug
    const criterion = CRITERIA.find((c) => c.slug === slug);
    if (!criterion) {
      setCriterionError(`Unknown criterion: ${slug}`);
      setCriterionLoading(false);
      return;
    }

    try {
      const data = await fetchEventScores(system.id, {
        criterion_id: criterion.id,
        limit: 50,
      });
      setCriterionEvents(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
        return;
      }
      setCriterionError(msg);
    } finally {
      setCriterionLoading(false);
    }
  }, [selectedCriterion, system.id]);

  return (
    <div className="drill-down">
      <button
        className="back-btn"
        onClick={onBack}
        aria-label="Back to systems overview"
      >
        ← Back to overview
      </button>

      <h2 ref={headingRef} tabIndex={-1} className="drill-down-heading">
        {system.name}
      </h2>
      {system.description && (
        <p className="drill-down-description">{system.description}</p>
      )}

      {/* Current scores — clickable for criterion drill-down */}
      {Object.keys(system.scores).length > 0 && (
        <div className="drill-down-scores">
          <p className="drill-down-score-hint">Click a score bar to see the highest-scoring events for that criterion.</p>
          <ScoreBars
            scores={system.scores}
            onCriterionClick={handleCriterionClick}
            selectedCriterion={selectedCriterion}
          />
        </div>
      )}

      {/* ── Criterion drill-down panel ── */}
      {selectedCriterion && (
        <div className="criterion-drilldown">
          <div className="criterion-drilldown-header">
            <h4>
              Events scored for: <span className="criterion-drilldown-name">{CRITERIA_LABELS[selectedCriterion] ?? selectedCriterion}</span>
            </h4>
            <button
              className="btn btn-xs btn-outline"
              onClick={() => { setSelectedCriterion(null); setCriterionEvents([]); }}
            >
              Close
            </button>
          </div>

          {criterionLoading && (
            <div className="settings-loading"><div className="spinner" /> Loading scored events…</div>
          )}
          {criterionError && <div className="error-msg" role="alert">{criterionError}</div>}

          {!criterionLoading && !criterionError && criterionEvents.length === 0 && (
            <div className="criterion-drilldown-empty">
              No events have been scored for this criterion yet. Events are scored by the AI pipeline every 5 minutes.
            </div>
          )}

          {!criterionLoading && criterionEvents.length > 0 && (
            <div className="table-responsive">
              <table className="criterion-events-table" aria-label={`Events scored for ${CRITERIA_LABELS[selectedCriterion]}`}>
                <thead>
                  <tr>
                    <th>Score</th>
                    <th>Severity</th>
                    <th>Time</th>
                    <th>Host</th>
                    <th>Program</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {criterionEvents.map((ev, idx) => {
                    const pct = Math.round(ev.score * 100);
                    return (
                      <tr key={`${ev.event_id}-${idx}`} className="criterion-event-row">
                        <td className="criterion-score-cell">
                          <span
                            className="criterion-score-badge"
                            style={{ color: scoreColorFromValue(ev.score) }}
                          >
                            {pct}%
                          </span>
                        </td>
                        <td>
                          {ev.severity && (
                            <span className={`severity-badge ${ev.severity.toLowerCase()}`}>
                              {ev.severity}
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{safeDate(ev.timestamp)}</td>
                        <td>{ev.host ?? '—'}</td>
                        <td>{ev.program ?? '—'}</td>
                        <td className="criterion-message-cell">{ev.message}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {criterionEvents.length >= 50 && (
                <p className="truncation-notice">Showing the top 50 events by score.</p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="error-msg" role="alert">{error}</div>}
      {loading && (
        <div className="loading" aria-live="polite">
          <div className="spinner" />
          Loading…
        </div>
      )}

      {/* Meta summary */}
      {meta && (
        <div className="meta-summary">
          <h4>Meta Analysis Summary</h4>
          <p>{meta.summary}</p>
          {meta.recommended_action && (
            <p className="recommended-action">
              Recommended: {meta.recommended_action}
            </p>
          )}
          {meta.findings.length > 0 && (
            <ul className="findings-list" role="list">
              {meta.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Events table */}
      {events.length > 0 && (
        <div className="table-responsive">
          <table className="events-table" aria-label={`Recent events for ${system.name}`}>
            <caption className="sr-only">
              Showing {events.length} most recent events for {system.name}
              {events.length >= 100 && ' (limited to 100)'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Severity</th>
                <th scope="col">Host</th>
                <th scope="col">Program</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  className={`event-row ${expandedRow === e.id ? 'expanded' : ''}`}
                  onClick={() => toggleRow(e.id)}
                  tabIndex={0}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      toggleRow(e.id);
                    }
                  }}
                  aria-expanded={expandedRow === e.id}
                  role="row"
                >
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {safeDate(e.timestamp)}
                  </td>
                  <td>
                    {e.severity && (
                      <span className={`severity-badge ${e.severity.toLowerCase()}`}>
                        {e.severity}
                      </span>
                    )}
                  </td>
                  <td>{e.host ?? '—'}</td>
                  <td>{e.program ?? '—'}</td>
                  <td className={expandedRow === e.id ? 'message-expanded' : 'message-truncated'}>
                    {e.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {events.length >= 100 && (
            <p className="truncation-notice">
              Showing the latest 100 events. Use the API for full access.
            </p>
          )}
        </div>
      )}

      {!loading && events.length === 0 && (
        <div className="empty-state">
          <h3>No events</h3>
          <p>No events found for this system yet.</p>
        </div>
      )}
    </div>
  );
}

/** Safely format a date, falling back to the raw string if invalid. */
function safeDate(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** Score colour matching ScoreBar's logic. */
function scoreColorFromValue(value: number): string {
  if (value >= 0.75) return 'var(--red)';
  if (value >= 0.5) return 'var(--orange)';
  if (value >= 0.25) return 'var(--yellow)';
  return 'var(--green)';
}
