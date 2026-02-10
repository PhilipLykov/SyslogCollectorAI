import { useState, useEffect, useCallback } from 'react';
import {
  type AuditLogEntry,
  type AuditLogResponse,
  fetchAuditLog,
  fetchAuditLogActions,
  getAuditExportUrl,
  getStoredApiKey,
} from '../api';
import { EuDateInput, euToIso } from './EuDateInput';

interface Props {
  onAuthError: () => void;
}

export function AuditLogSection({ onAuthError }: Props) {
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Filter options
  const [actions, setActions] = useState<string[]>([]);
  const [resourceTypes, setResourceTypes] = useState<string[]>([]);

  // Expanded row
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchAuditLog({
        page,
        limit,
        action: actionFilter || undefined,
        resource_type: resourceFilter || undefined,
        search: searchTerm || undefined,
        from: euToIso(fromDate) || undefined,
        to: euToIso(toDate) || undefined,
      });
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [page, limit, actionFilter, resourceFilter, searchTerm, fromDate, toDate, onAuthError]);

  const loadFilters = useCallback(async () => {
    try {
      const result = await fetchAuditLogActions();
      setActions(result.actions);
      setResourceTypes(result.resource_types);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => { loadFilters(); }, [loadFilters]);
  useEffect(() => { load(); }, [load]);

  const fmtDate = (d: string) => {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    const ss = String(dt.getSeconds()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`;
  };

  const handleExport = (format: 'csv' | 'json') => {
    const url = getAuditExportUrl({
      format,
      from: euToIso(fromDate) || undefined,
      to: euToIso(toDate) || undefined,
    });
    const token = getStoredApiKey();
    fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
      .then((res) => {
        if (!res.ok) throw new Error(`Export failed: ${res.status} ${res.statusText}`);
        return res.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `audit_log.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Export failed.'));
  };

  const getActionClass = (action: string) => {
    if (action.includes('fail')) return 'admin-action-fail';
    if (action.includes('delete') || action.includes('revoke') || action.includes('purge')) return 'admin-action-danger';
    if (action.includes('create') || action.includes('login')) return 'admin-action-success';
    return 'admin-action-info';
  };

  return (
    <div className="admin-section">
      <div className="admin-header-row">
        <div>
          <h3 className="section-title">Audit Log</h3>
          <p className="section-desc">
            Immutable record of all administrative actions. Entries cannot be modified or deleted.
          </p>
        </div>
        <div className="admin-export-actions">
          <button className="btn btn-sm btn-outline" onClick={() => handleExport('csv')}>Export CSV</button>
          <button className="btn btn-sm btn-outline" onClick={() => handleExport('json')}>Export JSON</button>
        </div>
      </div>

      {error && <div className="error-msg" role="alert">{error}</div>}

      {/* ── Filters ── */}
      <div className="admin-filters-bar">
        <div className="admin-filter-group">
          <label>Search</label>
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
          />
        </div>
        <div className="admin-filter-group">
          <label>Action</label>
          <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}>
            <option value="">All Actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="admin-filter-group">
          <label>Resource</label>
          <select value={resourceFilter} onChange={(e) => { setResourceFilter(e.target.value); setPage(1); }}>
            <option value="">All Resources</option>
            {resourceTypes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="admin-filter-group">
          <label>From</label>
          <EuDateInput value={fromDate} onChange={(v) => { setFromDate(v); setPage(1); }} />
        </div>
        <div className="admin-filter-group">
          <label>To</label>
          <EuDateInput value={toDate} onChange={(v) => { setToDate(v); setPage(1); }} />
        </div>
        <div className="admin-filter-group admin-filter-action">
          <button className="btn btn-xs btn-outline" onClick={() => {
            setSearchTerm('');
            setActionFilter('');
            setResourceFilter('');
            setFromDate('');
            setToDate('');
            setPage(1);
          }}>
            Clear
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="settings-loading"><div className="spinner" /> Loading audit log…</div>
      ) : data ? (
        <>
          <div className="admin-block">
            <div className="table-responsive">
              <table className="admin-table" aria-label="Audit Log">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>Actor</th>
                    <th>IP</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry: AuditLogEntry) => (
                    <tr key={entry.id}>
                      <td className="admin-date-cell">{fmtDate(entry.at)}</td>
                      <td>
                        <span className={`admin-action-badge ${getActionClass(entry.action)}`}>
                          {entry.action}
                        </span>
                      </td>
                      <td>
                        {entry.resource_type}
                        {entry.resource_id && (
                          <span className="admin-resource-id"> ({entry.resource_id.slice(0, 8)}…)</span>
                        )}
                      </td>
                      <td>{entry.actor ?? entry.user_id?.slice(0, 8) ?? '—'}</td>
                      <td className="admin-date-cell">{entry.ip ?? '—'}</td>
                      <td>
                        {entry.details ? (
                          <>
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                            >
                              {expandedId === entry.id ? 'Hide' : 'Show'}
                            </button>
                            {expandedId === entry.id && (
                              <pre className="admin-detail-pre">
                                {JSON.stringify(entry.details, null, 2)}
                              </pre>
                            )}
                          </>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && (
                    <tr><td colSpan={6} className="admin-empty-cell">No audit log entries found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Pagination ── */}
          <div className="admin-pagination">
            <span className="admin-pagination-info">
              Page {data.page} of {data.total_pages} ({data.total} total entries)
            </span>
            <div className="admin-pagination-actions">
              <button
                className="btn btn-xs btn-outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                className="btn btn-xs btn-outline"
                disabled={page >= (data.total_pages || 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
