import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchDiscoveryConfig,
  updateDiscoveryConfig,
  fetchDiscoverySuggestions,
  acceptDiscoverySuggestion,
  mergeDiscoverySuggestion,
  dismissDiscoverySuggestion,
  fetchSystems,
  type DiscoveryConfig,
  type DiscoverySuggestion,
  type MonitoredSystem,
} from '../api';

interface DiscoveryPanelProps {
  onAuthError: () => void;
}

export function DiscoveryPanel({ onAuthError }: DiscoveryPanelProps) {
  const [config, setConfig] = useState<DiscoveryConfig | null>(null);
  const [suggestions, setSuggestions] = useState<DiscoverySuggestion[]>([]);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [expandedSamples, setExpandedSamples] = useState<Set<string>>(new Set());
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [ignoreText, setIgnoreText] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await fetchDiscoveryConfig();
      setConfig(cfg);
      setIgnoreText((cfg.ignore_patterns ?? []).join('\n'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError('Failed to load discovery config.');
    }
  }, [onAuthError]);

  const loadSuggestions = useCallback(async () => {
    try {
      const data = await fetchDiscoverySuggestions(statusFilter);
      setSuggestions(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError('Failed to load suggestions.');
    }
  }, [statusFilter, onAuthError]);

  const loadSystems = useCallback(async () => {
    try {
      const data = await fetchSystems();
      setSystems(data);
    } catch { /* ignore */ }
  }, []);

  // Initial load — config + systems + suggestions
  useEffect(() => {
    setLoading(true);
    Promise.all([loadConfig(), loadSuggestions(), loadSystems()])
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch suggestions only when statusFilter changes (not full reload)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) { isInitialMount.current = false; return; }
    loadSuggestions();
  }, [loadSuggestions]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const patterns = ignoreText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const updated = await updateDiscoveryConfig({ ...config, ignore_patterns: patterns });
      setConfig(updated);
      setSuccess('Configuration saved.');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Failed to save config.');
    } finally {
      setSaving(false);
    }
  };

  const handleAccept = async (s: DiscoverySuggestion) => {
    setError('');
    try {
      const name = editingNames[s.id] || s.suggested_name;
      await acceptDiscoverySuggestion(s.id, { name, replay_events: false });
      setSuccess(`System "${name}" created.`);
      setTimeout(() => setSuccess(''), 3000);
      await loadSuggestions();
      await loadSystems();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Failed to accept suggestion.');
    }
  };

  const handleMerge = async (s: DiscoverySuggestion) => {
    const targetId = mergeTargets[s.id];
    if (!targetId) { setError('Select a system to merge into.'); return; }
    setError('');
    try {
      const result = await mergeDiscoverySuggestion(s.id, targetId);
      setSuccess(`Merged into "${result.name}".`);
      setTimeout(() => setSuccess(''), 3000);
      await loadSuggestions();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Failed to merge suggestion.');
    }
  };

  const handleDismiss = async (s: DiscoverySuggestion, duration: '24h' | '7d' | 'forever') => {
    setError('');
    try {
      await dismissDiscoverySuggestion(s.id, duration);
      await loadSuggestions();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Failed to dismiss suggestion.');
    }
  };

  const toggleSamples = (id: string) => {
    setExpandedSamples(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) return <div className="loading"><div className="spinner" /> Loading discovery settings...</div>;

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1rem' }}>
      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')}>&times;</button>
        </div>
      )}
      {success && <div className="success-msg" role="status">{success}</div>}

      {/* ── Configuration ── */}
      <h3>Auto-Discovery Configuration</h3>
      {config && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} />
              <span style={{ fontWeight: 600 }}>Enable Auto-Discovery</span>
            </label>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={config.group_by_host} onChange={e => setConfig({ ...config, group_by_host: e.target.checked })} disabled={!config.enabled} />
              Group by hostname
            </label>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={config.group_by_ip} onChange={e => setConfig({ ...config, group_by_ip: e.target.checked })} disabled={!config.enabled} />
              Group by source IP
            </label>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={config.split_by_program} onChange={e => setConfig({ ...config, split_by_program: e.target.checked })} disabled={!config.enabled} />
              Split by program
            </label>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={config.auto_accept} onChange={e => setConfig({ ...config, auto_accept: e.target.checked })} disabled={!config.enabled} />
              Auto-accept suggestions
              {config.auto_accept && <span style={{ color: 'var(--danger, #e74c3c)', fontSize: '0.78rem', marginLeft: '0.3rem' }}>(creates systems automatically)</span>}
            </label>
          </div>
          <div>
            <div className="form-group" style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85rem' }}>Min events threshold</label>
              <input type="number" min={1} value={config.min_events_threshold} onChange={e => setConfig({ ...config, min_events_threshold: Number(e.target.value) || 1 })} disabled={!config.enabled} style={{ width: '120px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85rem' }}>Min rate per hour</label>
              <input type="number" min={0} value={config.min_rate_per_hour} onChange={e => setConfig({ ...config, min_rate_per_hour: Number(e.target.value) || 0 })} disabled={!config.enabled} style={{ width: '120px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85rem' }}>Buffer TTL (hours)</label>
              <input type="number" min={1} value={config.buffer_ttl_hours} onChange={e => setConfig({ ...config, buffer_ttl_hours: Number(e.target.value) || 1 })} disabled={!config.enabled} style={{ width: '120px' }} />
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="form-group" style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85rem' }}>Ignore patterns (one regex per line)</label>
              <textarea rows={3} value={ignoreText} onChange={e => setIgnoreText(e.target.value)} disabled={!config.enabled} style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.82rem' }} placeholder={'^scanner-.*\n10\\.0\\.0\\.1'} />
            </div>
            <button className="btn" onClick={handleSaveConfig} disabled={saving}>
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}

      {/* ── Suggestions ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem', marginTop: '1.5rem' }}>
        <h3 style={{ margin: 0 }}>Discovered Sources</h3>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {['pending', 'accepted', 'dismissed', 'all'].map(st => (
            <button key={st} className={`btn btn-sm${statusFilter === st ? '' : ' btn-outline'}`} onClick={() => { setStatusFilter(st); }} style={{ textTransform: 'capitalize' }}>
              {st}
            </button>
          ))}
        </div>
        <button className="btn btn-sm btn-outline" onClick={loadSuggestions} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {suggestions.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {statusFilter === 'pending'
            ? 'No pending suggestions. Unmatched events will appear here after the grouping engine runs.'
            : `No ${statusFilter} suggestions.`}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th>Suggested Name</th>
                <th>Host / IP</th>
                <th>Programs</th>
                <th>Events</th>
                <th>First Seen</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map(s => (
                <tr key={s.id}>
                  <td>
                    {statusFilter === 'pending' ? (
                      <input
                        type="text"
                        value={editingNames[s.id] ?? s.suggested_name}
                        onChange={e => setEditingNames(prev => ({ ...prev, [s.id]: e.target.value }))}
                        style={{ width: '180px', fontSize: '0.83rem', padding: '2px 6px' }}
                      />
                    ) : (
                      <span>{s.suggested_name}</span>
                    )}
                  </td>
                  <td>
                    {s.host_pattern && <span title="Host">{s.host_pattern}</span>}
                    {s.host_pattern && s.ip_pattern && ' / '}
                    {s.ip_pattern && <span title="IP" style={{ opacity: 0.8 }}>{s.ip_pattern}</span>}
                  </td>
                  <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(s.program_patterns ?? []).join(', ') || '\u2014'}
                  </td>
                  <td>
                    {s.event_count}
                    {s.sample_messages?.length > 0 && (
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => toggleSamples(s.id)}
                        style={{ marginLeft: '0.3rem', fontSize: '0.72rem', padding: '1px 5px' }}
                      >
                        {expandedSamples.has(s.id) ? 'Hide' : 'Samples'}
                      </button>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
                    {s.first_seen_at ? new Date(s.first_seen_at).toLocaleString() : '\u2014'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
                    {s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : '\u2014'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {s.status === 'pending' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                        <button className="btn btn-sm" onClick={() => handleAccept(s)}>Accept</button>
                        <select
                          value={mergeTargets[s.id] ?? ''}
                          onChange={e => setMergeTargets(prev => ({ ...prev, [s.id]: e.target.value }))}
                          style={{ fontSize: '0.78rem', padding: '2px 4px', maxWidth: '130px' }}
                        >
                          <option value="">Merge into...</option>
                          {systems.map(sys => (
                            <option key={sys.id} value={sys.id}>{sys.name}</option>
                          ))}
                        </select>
                        {mergeTargets[s.id] && (
                          <button className="btn btn-sm btn-outline" onClick={() => handleMerge(s)}>Merge</button>
                        )}
                        <select
                          onChange={e => { if (e.target.value) handleDismiss(s, e.target.value as '24h' | '7d' | 'forever'); e.target.value = ''; }}
                          style={{ fontSize: '0.78rem', padding: '2px 4px' }}
                          defaultValue=""
                        >
                          <option value="" disabled>Dismiss...</option>
                          <option value="24h">24 hours</option>
                          <option value="7d">7 days</option>
                          <option value="forever">Forever</option>
                        </select>
                      </div>
                    )}
                    {s.status === 'accepted' && <span style={{ color: 'var(--success, #27ae60)' }}>Accepted</span>}
                    {s.status === 'dismissed' && <span style={{ color: 'var(--text-muted)' }}>Dismissed</span>}
                    {s.status === 'merged' && <span style={{ color: 'var(--info, #3498db)' }}>Merged</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {suggestions.map(s => expandedSamples.has(s.id) && s.sample_messages?.length > 0 && (
            <div key={`samples-${s.id}`} style={{ margin: '0.5rem 0', padding: '0.5rem', background: 'var(--surface, #1e1e2e)', borderRadius: '6px', fontSize: '0.78rem' }}>
              <strong>{s.suggested_name} - Sample Messages:</strong>
              {s.sample_messages.map((msg, i) => (
                <pre key={i} style={{ margin: '0.3rem 0', padding: '0.3rem', background: 'var(--bg, #0d0d1a)', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{msg}</pre>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
