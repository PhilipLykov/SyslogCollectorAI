import { useState, useEffect, useCallback } from 'react';
import {
  type ApiKeyInfo,
  type CreateApiKeyResponse,
  fetchApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
} from '../api';

const SCOPES = [
  { value: 'admin', label: 'Admin (full access)' },
  { value: 'ingest', label: 'Ingest (event ingestion only)' },
  { value: 'read', label: 'Read (dashboard + events read-only)' },
  { value: 'dashboard', label: 'Dashboard (dashboard read-only)' },
];

interface Props {
  onAuthError: () => void;
}

export function ApiKeyManagementSection({ onAuthError }: Props) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState('ingest');
  const [newDescription, setNewDescription] = useState('');
  const [newExpires, setNewExpires] = useState('');
  const [creating, setCreating] = useState(false);

  // Newly created key (shown once)
  const [createdKey, setCreatedKey] = useState<CreateApiKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchApiKeys();
      setKeys(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setCreating(true);
    try {
      const result = await createApiKey({
        name: newName.trim(),
        scope: newScope,
        description: newDescription.trim() || undefined,
        expires_at: newExpires || undefined,
      });
      setCreatedKey(result);
      setShowCreate(false);
      setNewName('');
      setNewScope('ingest');
      setNewDescription('');
      setNewExpires('');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ApiKeyInfo) => {
    if (!confirm(`Revoke API key "${key.name}"? This cannot be undone.`)) return;
    setError('');
    setSuccess('');
    try {
      await revokeApiKey(key.id);
      setSuccess(`API key "${key.name}" revoked.`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleActive = async (key: ApiKeyInfo) => {
    setError('');
    setSuccess('');
    try {
      await updateApiKey(key.id, { is_active: !key.is_active });
      setSuccess(`API key "${key.name}" ${key.is_active ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="spinner" />
        Loading API keys…
      </div>
    );
  }

  return (
    <div className="admin-section">
      <h3 className="section-title">API Key Management</h3>
      <p className="section-desc">
        Create and manage API keys for programmatic access. Keys are shown only once at creation — store them securely.
      </p>

      {error && <div className="error-msg" role="alert">{error}</div>}
      {success && <div className="success-msg" role="status">{success}</div>}

      {/* ── Newly Created Key Banner ── */}
      {createdKey && (
        <div className="admin-key-created-banner">
          <div className="admin-key-created-title">API Key Created — Copy it now! It will not be shown again.</div>
          <div className="admin-key-created-row">
            <code className="admin-key-created-value">{createdKey.plain_key}</code>
            <button className="btn btn-sm" onClick={() => copyToClipboard(createdKey.plain_key)}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button className="btn btn-xs btn-outline" onClick={() => setCreatedKey(null)} style={{ marginTop: '8px' }}>
            Dismiss
          </button>
        </div>
      )}

      {/* ── Create Key ── */}
      <div className="admin-block">
        <button type="button" className="prompt-toggle" onClick={() => { setShowCreate(!showCreate); setCreatedKey(null); }}>
          <span className={`prompt-chevron${showCreate ? ' open' : ''}`}>&#9654;</span>
          Create New API Key
          <span className="prompt-custom-badge">{keys.length} key(s)</span>
        </button>

        {showCreate && (
          <form className="admin-form-panel" onSubmit={handleCreate}>
            <div className="admin-form-grid">
              <div className="form-group">
                <label>Name *</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} required placeholder="e.g., Syslog Forwarder" />
              </div>
              <div className="form-group">
                <label>Scope *</label>
                <select value={newScope} onChange={(e) => setNewScope(e.target.value)}>
                  {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Description</label>
                <input type="text" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Optional description" />
              </div>
              <div className="form-group">
                <label>Expires At</label>
                <input type="datetime-local" value={newExpires} onChange={(e) => setNewExpires(e.target.value)} />
                <span className="field-hint">Leave empty for no expiration.</span>
              </div>
            </div>
            <div className="admin-form-actions">
              <button type="submit" className="btn btn-sm" disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create API Key'}
              </button>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      {/* ── Keys Table ── */}
      <div className="admin-block">
        <div className="table-responsive">
          <table className="admin-table" aria-label="API Keys">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Description</th>
                <th>Status</th>
                <th>Created By</th>
                <th>Expires</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.is_active ? '' : 'admin-row-inactive'}>
                  <td><strong>{k.name}</strong></td>
                  <td>
                    <span className={`admin-scope-badge admin-scope-${k.scope}`}>{k.scope}</span>
                  </td>
                  <td className="admin-desc-cell">{k.description || '—'}</td>
                  <td>
                    <span className={`db-status-badge ${k.is_active ? 'db-status-success' : 'db-status-failed'}`}>
                      {k.is_active ? 'Active' : 'Revoked'}
                    </span>
                    {k.expires_at && new Date(k.expires_at) < new Date() && (
                      <span className="db-status-badge db-status-completed_with_errors" style={{ marginLeft: '4px' }}>Expired</span>
                    )}
                  </td>
                  <td>{k.created_by_username || '—'}</td>
                  <td className="admin-date-cell">{fmtDate(k.expires_at)}</td>
                  <td className="admin-date-cell">{fmtDate(k.last_used_at)}</td>
                  <td>
                    <div className="admin-action-group">
                      <button
                        className="btn btn-xs btn-outline"
                        onClick={() => handleToggleActive(k)}
                      >
                        {k.is_active ? 'Disable' : 'Enable'}
                      </button>
                      {k.is_active && (
                        <button className="btn btn-xs btn-danger-outline" onClick={() => handleRevoke(k)}>Revoke</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr><td colSpan={8} className="admin-empty-cell">No API keys found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
