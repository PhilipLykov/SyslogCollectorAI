import { useEffect, useState, useCallback } from 'react';
import {
  type MonitoredSystem,
  type LogSource,
  fetchSystems,
  fetchSources,
  createSystem,
  updateSystem,
  deleteSystem,
  createSource,
  updateSource,
  deleteSource,
} from '../api';
import { SystemForm } from './SystemForm';
import { SourceForm } from './SourceForm';
import { ConfirmDialog } from './ConfirmDialog';
import { AiConfigSection } from './AiConfigSection';
import { NotificationsSection } from './NotificationsSection';
import { DatabaseMaintenanceSection } from './DatabaseMaintenanceSection';
import { PrivacySection } from './PrivacySection';

interface SettingsViewProps {
  onAuthError: () => void;
}

type SettingsTab = 'systems' | 'ai-model' | 'notifications' | 'database' | 'privacy';

type Modal =
  | { kind: 'create-system' }
  | { kind: 'edit-system'; system: MonitoredSystem }
  | { kind: 'delete-system'; system: MonitoredSystem }
  | { kind: 'create-source'; systemId: string }
  | { kind: 'edit-source'; source: LogSource }
  | { kind: 'delete-source'; source: LogSource }
  | null;

export function SettingsView({ onAuthError }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('systems');
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);

  const selectedSystem = systems.find((s) => s.id === selectedSystemId) ?? null;

  // ── Load systems ────────────────────────────────────────────
  const loadSystems = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchSystems();
      setSystems(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  // ── Load sources for selected system ────────────────────────
  const loadSources = useCallback(async (systemId: string) => {
    try {
      setSourcesLoading(true);
      const data = await fetchSources(systemId);
      setSources(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
        return;
      }
      setError(msg);
    } finally {
      setSourcesLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    loadSystems();
  }, [loadSystems]);

  useEffect(() => {
    if (selectedSystemId) {
      loadSources(selectedSystemId);
    } else {
      setSources([]);
    }
  }, [selectedSystemId, loadSources]);

  // ── System CRUD handlers ────────────────────────────────────
  const handleCreateSystem = async (name: string, description: string, retentionDays: number | null) => {
    setSaving(true);
    setError('');
    try {
      const created = await createSystem({ name, description, retention_days: retentionDays });
      setSystems((prev) => [...prev, created]);
      setSelectedSystemId(created.id);
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSystem = async (id: string, name: string, description: string, retentionDays: number | null) => {
    setSaving(true);
    setError('');
    try {
      const updated = await updateSystem(id, { name, description, retention_days: retentionDays });
      setSystems((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSystem = async (id: string) => {
    setSaving(true);
    setError('');
    try {
      await deleteSystem(id);
      setSystems((prev) => prev.filter((s) => s.id !== id));
      if (selectedSystemId === id) {
        setSelectedSystemId(null);
        setSources([]);
      }
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Source CRUD handlers ────────────────────────────────────
  const handleCreateSource = async (
    systemId: string,
    label: string,
    selector: Record<string, string>,
    priority: number,
  ) => {
    setSaving(true);
    setError('');
    try {
      const created = await createSource({ system_id: systemId, label, selector, priority });
      setSources((prev) => [...prev, created]);
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSource = async (
    id: string,
    label: string,
    selector: Record<string, string>,
    priority: number,
  ) => {
    setSaving(true);
    setError('');
    try {
      const updated = await updateSource(id, { label, selector, priority });
      setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSource = async (id: string) => {
    setSaving(true);
    setError('');
    try {
      await deleteSource(id);
      setSources((prev) => prev.filter((s) => s.id !== id));
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────
  return (
    <div className="settings-view">
      {/* ── Sub-navigation tabs ── */}
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          className={`settings-tab${activeTab === 'systems' ? ' active' : ''}`}
          onClick={() => setActiveTab('systems')}
          role="tab"
          aria-selected={activeTab === 'systems'}
        >
          Systems &amp; Sources
        </button>
        <button
          className={`settings-tab${activeTab === 'ai-model' ? ' active' : ''}`}
          onClick={() => setActiveTab('ai-model')}
          role="tab"
          aria-selected={activeTab === 'ai-model'}
        >
          AI Model
        </button>
        <button
          className={`settings-tab${activeTab === 'notifications' ? ' active' : ''}`}
          onClick={() => setActiveTab('notifications')}
          role="tab"
          aria-selected={activeTab === 'notifications'}
        >
          Notifications
        </button>
        <button
          className={`settings-tab${activeTab === 'database' ? ' active' : ''}`}
          onClick={() => setActiveTab('database')}
          role="tab"
          aria-selected={activeTab === 'database'}
        >
          Database
        </button>
        <button
          className={`settings-tab${activeTab === 'privacy' ? ' active' : ''}`}
          onClick={() => setActiveTab('privacy')}
          role="tab"
          aria-selected={activeTab === 'privacy'}
        >
          Privacy
        </button>
      </div>

      {/* ── Tab content ── */}
      {activeTab === 'ai-model' ? (
        <AiConfigSection onAuthError={onAuthError} />
      ) : activeTab === 'notifications' ? (
        <NotificationsSection onAuthError={onAuthError} />
      ) : activeTab === 'database' ? (
        <DatabaseMaintenanceSection onAuthError={onAuthError} />
      ) : activeTab === 'privacy' ? (
        <PrivacySection onAuthError={onAuthError} />
      ) : (
        /* ── Systems & Sources tab (existing content) ── */
        <>
          {error && (
            <div className="error-msg" role="alert">
              {error}
              <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">
                &times;
              </button>
            </div>
          )}

          <div className="settings-layout">
            {/* ── Left panel: systems list ── */}
            <aside className="settings-sidebar">
              <div className="settings-sidebar-header">
                <h3>Monitored Systems</h3>
                <button
                  className="btn btn-sm"
                  onClick={() => setModal({ kind: 'create-system' })}
                  aria-label="Add monitored system"
                >
                  + Add
                </button>
              </div>

              {loading ? (
                <div className="settings-loading">
                  <div className="spinner" />
                  Loading…
                </div>
              ) : systems.length === 0 ? (
                <div className="settings-empty">
                  <p>No systems configured yet.</p>
                  <p className="settings-empty-hint">Click "+ Add" to create your first monitored system.</p>
                </div>
              ) : (
                <ul className="settings-system-list" role="listbox" aria-label="Monitored systems">
                  {systems.map((s) => (
                    <li
                      key={s.id}
                      className={`settings-system-item${selectedSystemId === s.id ? ' active' : ''}`}
                      onClick={() => setSelectedSystemId(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedSystemId(s.id);
                        }
                      }}
                      role="option"
                      aria-selected={selectedSystemId === s.id}
                      tabIndex={0}
                    >
                      <span className="settings-system-name">{s.name}</span>
                      {s.description && (
                        <span className="settings-system-desc">{s.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </aside>

            {/* ── Right panel: system detail & sources ── */}
            <main className="settings-main">
              {!selectedSystem ? (
                <div className="settings-placeholder">
                  <div className="settings-placeholder-icon" aria-hidden="true">&#9881;</div>
                  <h3>Select a system</h3>
                  <p>Choose a monitored system from the left panel to view and manage its log sources.</p>
                </div>
              ) : (
                <>
                  {/* System info header */}
                  <div className="settings-system-header">
                    <div className="settings-system-info">
                      <h3>{selectedSystem.name}</h3>
                      {selectedSystem.description && (
                        <p className="settings-system-header-desc">{selectedSystem.description}</p>
                      )}
                      <span className="settings-system-id">ID: {selectedSystem.id}</span>
                    </div>
                    <div className="settings-system-actions">
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => setModal({ kind: 'edit-system', system: selectedSystem })}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setModal({ kind: 'delete-system', system: selectedSystem })}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Sources section */}
                  <div className="settings-sources-section">
                    <div className="settings-sources-header">
                      <h4>Log Sources</h4>
                      <button
                        className="btn btn-sm"
                        onClick={() => setModal({ kind: 'create-source', systemId: selectedSystem.id })}
                      >
                        + Add Source
                      </button>
                    </div>

                    {sourcesLoading ? (
                      <div className="settings-loading">
                        <div className="spinner" />
                        Loading sources…
                      </div>
                    ) : sources.length === 0 ? (
                      <div className="settings-sources-empty">
                        <p>No log sources configured for this system.</p>
                        <p className="settings-empty-hint">
                          Log sources define which incoming events belong to this system.
                          Each source has a selector (field-matching rules) and a priority (lower = matched first).
                        </p>
                      </div>
                    ) : (
                      <div className="table-responsive">
                        <table className="settings-sources-table" aria-label="Log sources">
                          <thead>
                            <tr>
                              <th>Label</th>
                              <th>Selector</th>
                              <th>Priority</th>
                              <th className="col-actions">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sources.map((src) => (
                              <tr key={src.id}>
                                <td className="source-label-cell">{src.label}</td>
                                <td className="source-selector-cell">
                                  <code className="selector-code">
                                    {formatSelector(src.selector)}
                                  </code>
                                </td>
                                <td>{src.priority}</td>
                                <td className="col-actions">
                                  <button
                                    className="btn btn-xs btn-outline"
                                    onClick={() => setModal({ kind: 'edit-source', source: src })}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="btn btn-xs btn-danger-outline"
                                    onClick={() => setModal({ kind: 'delete-source', source: src })}
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Selector help */}
                    <details className="settings-help">
                      <summary>How selectors work</summary>
                      <div className="settings-help-content">
                        <p>
                          A <strong>selector</strong> is a set of field-matching rules. Each key is a log event field
                          (e.g. <code>host</code>, <code>service</code>, <code>program</code>, <code>facility</code>)
                          and its value is a <strong>regex pattern</strong> that must match.
                        </p>
                        <p>Examples:</p>
                        <ul>
                          <li><code>{'{"host": ".*"}'}</code> — matches all hosts (catch-all)</li>
                          <li><code>{'{"host": "^web-\\\\d+"}'}</code> — matches hosts like web-01, web-02</li>
                          <li><code>{'{"service": "nginx", "host": "prod-.*"}'}</code> — matches nginx on prod servers</li>
                        </ul>
                        <p>
                          <strong>Priority</strong> controls evaluation order (lower = evaluated first).
                          The first matching source wins. Use a low priority for specific selectors and
                          a high priority (e.g. 100) for catch-all rules.
                        </p>
                      </div>
                    </details>
                  </div>
                </>
              )}
            </main>
          </div>

          {/* ── Modals ── */}
          {modal?.kind === 'create-system' && (
            <SystemForm
              title="Create Monitored System"
              onSave={(name, desc, retention) => handleCreateSystem(name, desc, retention)}
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}

          {modal?.kind === 'edit-system' && (
            <SystemForm
              title="Edit System"
              initialName={modal.system.name}
              initialDescription={modal.system.description}
              initialRetentionDays={modal.system.retention_days}
              onSave={(name, desc, retention) => handleUpdateSystem(modal.system.id, name, desc, retention)}
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}

          {modal?.kind === 'delete-system' && (
            <ConfirmDialog
              title="Delete System"
              message={`Are you sure you want to delete "${modal.system.name}"? This will permanently remove all its log sources, events, scores, and analysis data. This action cannot be undone.`}
              confirmLabel="Delete System"
              danger
              onConfirm={() => handleDeleteSystem(modal.system.id)}
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}

          {modal?.kind === 'create-source' && (
            <SourceForm
              title="Add Log Source"
              onSave={(label, selector, priority) =>
                handleCreateSource(modal.systemId, label, selector, priority)
              }
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}

          {modal?.kind === 'edit-source' && (
            <SourceForm
              title="Edit Log Source"
              initialLabel={modal.source.label}
              initialSelector={modal.source.selector}
              initialPriority={modal.source.priority}
              onSave={(label, selector, priority) =>
                handleUpdateSource(modal.source.id, label, selector, priority)
              }
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}

          {modal?.kind === 'delete-source' && (
            <ConfirmDialog
              title="Delete Log Source"
              message={`Are you sure you want to delete the source "${modal.source.label}"? Events already collected will remain, but new events will no longer match this source.`}
              confirmLabel="Delete Source"
              danger
              onConfirm={() => handleDeleteSource(modal.source.id)}
              onCancel={() => setModal(null)}
              saving={saving}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Format selector object for display. */
function formatSelector(selector: Record<string, string>): string {
  const entries = Object.entries(selector);
  if (entries.length === 0) return '{}';
  return entries.map(([k, v]) => `${k}: "${v}"`).join(', ');
}
