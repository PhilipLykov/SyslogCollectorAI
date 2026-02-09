import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import {
  type LogEvent,
  type SearchEventsParams,
  type SearchEventsResponse,
  type EventFacets,
  searchEvents,
  fetchEventFacets,
} from '../api';
import { TracePanel } from './TracePanel';

interface Props {
  onAuthError: () => void;
}

const PAGE_SIZE = 50;

function safeDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function EventExplorerView({ onAuthError }: Props) {
  // ── Facets (for filter dropdowns) ────────────────────────
  const [facets, setFacets] = useState<EventFacets | null>(null);

  // ── Search state ─────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'fulltext' | 'contains'>('fulltext');
  const [systemFilter, setSystemFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [hostFilter, setHostFilter] = useState('');
  const [programFilter, setProgramFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortBy, setSortBy] = useState('timestamp');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  // ── Results ──────────────────────────────────────────────
  const [result, setResult] = useState<SearchEventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // ── Filter-click trigger (triggers re-search after state updates) ─
  const [filterTrigger, setFilterTrigger] = useState(0);

  // ── Trace panel ──────────────────────────────────────────
  const [traceValue, setTraceValue] = useState<string | null>(null);
  const [traceAnchorTime, setTraceAnchorTime] = useState<string | undefined>(undefined);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load facets on mount
  useEffect(() => {
    fetchEventFacets()
      .then(setFacets)
      .catch((err) => {
        if (err.message?.includes('Authentication')) onAuthError();
      });
  }, [onAuthError]);

  // Focus search on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    async (pageOverride?: number) => {
      setLoading(true);
      setError('');
      setExpandedRow(null);
      const targetPage = pageOverride ?? page;

      const params: SearchEventsParams = {
        page: targetPage,
        limit: PAGE_SIZE,
        sort_by: sortBy,
        sort_dir: sortDir,
      };
      if (query.trim()) {
        params.q = query.trim();
        params.q_mode = searchMode;
      }
      if (systemFilter) params.system_id = systemFilter;
      if (severityFilter) params.severity = severityFilter;
      if (hostFilter) params.host = hostFilter;
      if (programFilter) params.program = programFilter;
      if (fromDate) params.from = new Date(fromDate).toISOString();
      if (toDate) params.to = new Date(toDate).toISOString();

      try {
        const data = await searchEvents(params);
        setResult(data);
        setPage(targetPage);
        setHasSearched(true);
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
    },
    [query, searchMode, systemFilter, severityFilter, hostFilter, programFilter, fromDate, toDate, sortBy, sortDir, page, onAuthError],
  );

  const handleSearch = () => {
    setPage(1);
    doSearch(1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(column);
      setSortDir('desc');
    }
  };

  // When sort changes, auto re-search if we already have results
  useEffect(() => {
    if (hasSearched) {
      doSearch(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy, sortDir]);

  // When a filter is clicked (from table values), re-search after state batches
  useEffect(() => {
    if (filterTrigger > 0 && hasSearched) {
      doSearch(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTrigger]);

  const handlePageChange = (newPage: number) => {
    doSearch(newPage);
  };

  const toggleRow = (id: string) => {
    setExpandedRow((prev) => (prev === id ? null : id));
  };

  const handleClickFilter = (field: 'host' | 'program' | 'severity', value: string) => {
    if (field === 'host') setHostFilter(value);
    else if (field === 'program') setProgramFilter(value);
    else if (field === 'severity') setSeverityFilter(value);
    setFiltersExpanded(true);
    // Increment trigger — React batches the state updates,
    // so by the time the useEffect fires, doSearch has the new values.
    setFilterTrigger((t) => t + 1);
  };

  const handleTrace = (event: LogEvent) => {
    const value = event.trace_id || '';
    setTraceValue(value || null);
    setTraceAnchorTime(event.timestamp);
  };

  const handleTraceFromInput = (event: LogEvent) => {
    const defaultVal = event.trace_id || '';
    const input = window.prompt('Enter correlation value to trace:', defaultVal);
    if (input && input.trim()) {
      setTraceValue(input.trim());
      setTraceAnchorTime(event.timestamp);
    }
  };

  const clearFilters = () => {
    setQuery('');
    setSystemFilter('');
    setSeverityFilter('');
    setHostFilter('');
    setProgramFilter('');
    setFromDate('');
    setToDate('');
    setSortBy('timestamp');
    setSortDir('desc');
    setPage(1);
  };

  const sortIndicator = (col: string) => {
    if (sortBy !== col) return ' \u21C5';
    return sortDir === 'desc' ? ' \u2193' : ' \u2191';
  };

  const totalPages = result ? Math.ceil(result.total / result.limit) : 0;

  return (
    <div className="event-explorer">
      {/* ── Search bar ───────────────────────────────────── */}
      <div className="ee-search-bar">
        <div className="ee-search-input-group">
          <input
            ref={searchInputRef}
            type="text"
            className="ee-search-input"
            placeholder="Search events... (e.g. error, connection refused, CallID)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search events"
          />
          <select
            className="ee-mode-select"
            value={searchMode}
            onChange={(e) => setSearchMode(e.target.value as 'fulltext' | 'contains')}
            title="Search mode"
          >
            <option value="fulltext">Full-text</option>
            <option value="contains">Contains</option>
          </select>
          <button className="btn btn-accent" onClick={handleSearch} disabled={loading}>
            {loading ? '...' : 'Search'}
          </button>
        </div>
        <div className="ee-search-actions">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => setFiltersExpanded((p) => !p)}
          >
            {filtersExpanded ? 'Hide Filters' : 'Filters'}
          </button>
          <button className="btn btn-sm btn-outline" onClick={clearFilters} title="Clear all filters">
            Clear
          </button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      {filtersExpanded && (
        <div className="ee-filter-row">
          <div className="ee-filter-group">
            <label>System</label>
            <select value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)}>
              <option value="">All systems</option>
              {facets?.systems.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="ee-filter-group">
            <label>Severity</label>
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
              <option value="">All</option>
              {facets?.severities.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="ee-filter-group">
            <label>Host</label>
            <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)}>
              <option value="">All</option>
              {facets?.hosts.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <div className="ee-filter-group">
            <label>Program</label>
            <select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
              <option value="">All</option>
              {facets?.programs.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="ee-filter-group">
            <label>From</label>
            <input
              type="datetime-local"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="ee-filter-group">
            <label>To</label>
            <input
              type="datetime-local"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────── */}
      {error && <div className="error-msg" role="alert">{error}</div>}

      {/* ── Results info ─────────────────────────────────── */}
      {result && (
        <div className="ee-results-info">
          <span>
            {result.total.toLocaleString()} event{result.total !== 1 ? 's' : ''} found
          </span>
          {totalPages > 1 && (
            <span className="ee-page-info">
              Page {result.page} of {totalPages}
            </span>
          )}
        </div>
      )}

      {/* ── Results table ────────────────────────────────── */}
      {result && result.events.length > 0 && (
        <div className="table-responsive">
          <table className="events-table ee-table" aria-label="Event search results">
            <thead>
              <tr>
                <th
                  className="sortable-header"
                  onClick={() => handleSort('timestamp')}
                  title="Sort by time"
                >
                  Time{sortIndicator('timestamp')}
                </th>
                <th>System</th>
                <th
                  className="sortable-header"
                  onClick={() => handleSort('severity')}
                  title="Sort by severity"
                >
                  Severity{sortIndicator('severity')}
                </th>
                <th
                  className="sortable-header"
                  onClick={() => handleSort('host')}
                  title="Sort by host"
                >
                  Host{sortIndicator('host')}
                </th>
                <th
                  className="sortable-header"
                  onClick={() => handleSort('program')}
                  title="Sort by program"
                >
                  Program{sortIndicator('program')}
                </th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {result.events.map((e) => (
                <Fragment key={e.id}>
                  {/* Main row */}
                  <tr
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
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {safeDate(e.timestamp)}
                    </td>
                    <td>
                      <span className="ee-system-tag">{e.system_name ?? '\u2014'}</span>
                    </td>
                    <td>
                      {e.severity && (
                        <span
                          className={`severity-badge ${e.severity.toLowerCase()}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleClickFilter('severity', e.severity!);
                          }}
                          title="Click to filter"
                          style={{ cursor: 'pointer' }}
                        >
                          {e.severity}
                        </span>
                      )}
                    </td>
                    <td
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (e.host) handleClickFilter('host', e.host);
                      }}
                      title={e.host ? 'Click to filter by this host' : undefined}
                    >
                      <span className={e.host ? 'ee-clickable-value' : ''}>{e.host ?? '\u2014'}</span>
                    </td>
                    <td
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (e.program) handleClickFilter('program', e.program);
                      }}
                      title={e.program ? 'Click to filter by this program' : undefined}
                    >
                      <span className={e.program ? 'ee-clickable-value' : ''}>{e.program ?? '\u2014'}</span>
                    </td>
                    <td className={expandedRow === e.id ? 'message-expanded' : 'message-truncated'}>
                      {e.message}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedRow === e.id && (
                    <tr className="ee-detail-row">
                      <td colSpan={6}>
                        <div className="ee-detail-content">
                          <div className="ee-detail-grid">
                            <div className="ee-detail-field">
                              <strong>Event ID:</strong> <code>{e.id}</code>
                            </div>
                            <div className="ee-detail-field">
                              <strong>System:</strong> {e.system_name ?? e.system_id}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Received:</strong> {e.received_at ? safeDate(e.received_at) : '\u2014'}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Service:</strong> {e.service ?? '\u2014'}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Facility:</strong> {e.facility ?? '\u2014'}
                            </div>
                            {e.trace_id && (
                              <div className="ee-detail-field">
                                <strong>Trace ID:</strong>{' '}
                                <code
                                  className="ee-trace-link"
                                  onClick={() => {
                                    setTraceValue(e.trace_id!);
                                    setTraceAnchorTime(e.timestamp);
                                  }}
                                  title="Click to trace"
                                >
                                  {e.trace_id}
                                </code>
                              </div>
                            )}
                            {e.span_id && (
                              <div className="ee-detail-field">
                                <strong>Span ID:</strong> <code>{e.span_id}</code>
                              </div>
                            )}
                            {e.external_id && (
                              <div className="ee-detail-field">
                                <strong>External ID:</strong> <code>{e.external_id}</code>
                              </div>
                            )}
                          </div>

                          <div className="ee-detail-message">
                            <strong>Full message:</strong>
                            <pre>{e.message}</pre>
                          </div>

                          {e.raw && (
                            <div className="ee-detail-raw">
                              <strong>Raw data:</strong>
                              <pre>{typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw, null, 2)}</pre>
                            </div>
                          )}

                          <div className="ee-detail-actions">
                            {e.trace_id ? (
                              <button
                                className="btn btn-sm btn-accent"
                                onClick={() => handleTrace(e)}
                              >
                                Trace (trace_id)
                              </button>
                            ) : null}
                            <button
                              className="btn btn-sm btn-outline"
                              onClick={() => handleTraceFromInput(e)}
                            >
                              Trace custom value...
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────── */}
      {result && result.events.length === 0 && (
        <div className="empty-state">
          <h3>No events found</h3>
          <p>Try adjusting your search query or filters.</p>
        </div>
      )}

      {/* ── No search yet ────────────────────────────────── */}
      {!result && !loading && !error && (
        <div className="empty-state">
          <h3>Event Explorer</h3>
          <p>
            Search across all systems. Use the search bar above or expand filters to narrow results.
            Press Enter or click Search to begin.
          </p>
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────── */}
      {loading && (
        <div className="loading" aria-live="polite">
          <div className="spinner" />
          Searching events...
        </div>
      )}

      {/* ── Pagination ───────────────────────────────────── */}
      {result && totalPages > 1 && (
        <div className="ee-pagination">
          <button
            className="btn btn-sm btn-outline"
            disabled={page <= 1}
            onClick={() => handlePageChange(page - 1)}
          >
            Previous
          </button>
          <span className="ee-page-display">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn-sm btn-outline"
            disabled={!result.has_more}
            onClick={() => handlePageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}

      {/* ── Trace Panel ──────────────────────────────────── */}
      {traceValue !== null && (
        <TracePanel
          value={traceValue}
          anchorTime={traceAnchorTime}
          onClose={() => setTraceValue(null)}
          onAuthError={onAuthError}
        />
      )}
    </div>
  );
}
