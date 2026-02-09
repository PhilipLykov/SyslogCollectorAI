import { useEffect, useState, useCallback } from 'react';
import {
  type MaintenanceConfigResponse,
  type MaintenanceLogEntry,
  type MaintenanceRunResult,
  type BackupConfig,
  type BackupFileInfo,
  type BackupRunResult,
  fetchMaintenanceConfig,
  updateMaintenanceConfig,
  triggerMaintenanceRun,
  fetchMaintenanceHistory,
  fetchBackupConfig,
  updateBackupConfig,
  triggerBackup,
  fetchBackupList,
  getBackupDownloadUrl,
  getApiKeyForDownload,
  deleteBackup,
} from '../api';

interface DatabaseMaintenanceSectionProps {
  onAuthError: () => void;
}

/** Format an ISO date to EU format DD-MM-YYYY HH:mm:ss */
function formatEuDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export function DatabaseMaintenanceSection({ onAuthError }: DatabaseMaintenanceSectionProps) {
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<MaintenanceConfigResponse | null>(null);
  const [history, setHistory] = useState<MaintenanceLogEntry[]>([]);

  // Editable config
  const [retentionDays, setRetentionDays] = useState('90');
  const [intervalHours, setIntervalHours] = useState('6');

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');

  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MaintenanceRunResult | null>(null);

  const [showHistory, setShowHistory] = useState(false);

  // Backup state
  const [showBackup, setShowBackup] = useState(false);
  const [backupConfig, setBackupConfig] = useState<BackupConfig | null>(null);
  const [backupList, setBackupList] = useState<BackupFileInfo[]>([]);
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupIntervalHours, setBackupIntervalHours] = useState('24');
  const [backupRetentionCount, setBackupRetentionCount] = useState('7');
  const [backupFormat, setBackupFormat] = useState<'custom' | 'plain'>('custom');
  const [backupSaving, setBackupSaving] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');
  const [backupError, setBackupError] = useState('');
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupResult, setBackupResult] = useState<BackupRunResult | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [cfgResp, histResp] = await Promise.all([
        fetchMaintenanceConfig(),
        fetchMaintenanceHistory(20),
      ]);
      setConfigData(cfgResp);
      setRetentionDays(String(cfgResp.config.default_retention_days));
      setIntervalHours(String(cfgResp.config.maintenance_interval_hours));
      setHistory(histResp);

      // Load backup config
      try {
        const bCfg = await fetchBackupConfig();
        setBackupConfig(bCfg.config);
        setBackupEnabled(bCfg.config.backup_enabled);
        setBackupIntervalHours(String(bCfg.config.backup_interval_hours));
        setBackupRetentionCount(String(bCfg.config.backup_retention_count));
        setBackupFormat(bCfg.config.backup_format);
        const bList = await fetchBackupList();
        setBackupList(bList);
      } catch {
        // Backup endpoints might not exist yet — non-critical
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
        return;
      }
      setSaveError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    const rd = Number(retentionDays);
    const ih = Number(intervalHours);
    if (!Number.isFinite(rd) || rd < 1 || rd > 3650) {
      setSaveError('Default retention days must be 1–3650.');
      return;
    }
    if (!Number.isFinite(ih) || ih < 1 || ih > 168) {
      setSaveError('Maintenance interval must be 1–168 hours.');
      return;
    }

    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    try {
      await updateMaintenanceConfig({
        default_retention_days: rd,
        maintenance_interval_hours: ih,
      });
      setSaveMsg('Settings saved.');
      setTimeout(() => setSaveMsg(''), 3000);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    if (!confirm('Run database maintenance now? This will delete events older than the retention period, run VACUUM ANALYZE and REINDEX. This may take a few minutes for large databases.')) {
      return;
    }
    setRunning(true);
    setRunResult(null);
    setSaveError('');
    try {
      const result = await triggerMaintenanceRun();
      setRunResult(result);
      await load(); // reload to refresh stats and history
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Maintenance run failed: ${msg}`);
    } finally {
      setRunning(false);
    }
  };

  const handleBackupSave = async () => {
    const ih = Number(backupIntervalHours);
    const rc = Number(backupRetentionCount);
    if (!Number.isFinite(ih) || ih < 1 || ih > 720) {
      setBackupError('Backup interval must be 1–720 hours.');
      return;
    }
    if (!Number.isFinite(rc) || rc < 1 || rc > 100) {
      setBackupError('Retention count must be 1–100.');
      return;
    }

    setBackupSaving(true);
    setBackupError('');
    setBackupMsg('');
    try {
      const resp = await updateBackupConfig({
        backup_enabled: backupEnabled,
        backup_interval_hours: ih,
        backup_retention_count: rc,
        backup_format: backupFormat,
      });
      setBackupConfig(resp.config as BackupConfig);
      setBackupMsg('Backup settings saved.');
      setTimeout(() => setBackupMsg(''), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackupError(msg);
    } finally {
      setBackupSaving(false);
    }
  };

  const handleBackupNow = async () => {
    if (!confirm('Start a database backup now? This may take a few minutes for large databases.')) {
      return;
    }
    setBackupRunning(true);
    setBackupResult(null);
    setBackupError('');
    try {
      const result = await triggerBackup();
      setBackupResult(result);
      // Refresh backup list
      const bList = await fetchBackupList();
      setBackupList(bList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackupError(`Backup failed: ${msg}`);
    } finally {
      setBackupRunning(false);
    }
  };

  const handleBackupDownload = async (filename: string) => {
    try {
      const url = getBackupDownloadUrl(filename);
      const res = await fetch(url, {
        headers: { 'X-API-Key': getApiKeyForDownload() },
      });
      if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackupError(`Download failed: ${msg}`);
    }
  };

  const handleBackupDelete = async (filename: string) => {
    if (!confirm(`Delete backup "${filename}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteBackup(filename);
      setBackupList((prev) => prev.filter((b) => b.filename !== filename));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackupError(`Delete failed: ${msg}`);
    }
  };

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="spinner" />
        Loading database maintenance settings…
      </div>
    );
  }

  const dbStats = configData?.db_stats ?? {};
  const systems = configData?.systems ?? [];
  const lastRun = history.length > 0 ? history[0] : null;

  return (
    <div className="db-maintenance-section">
      <h3 className="section-title">Database Maintenance</h3>
      <p className="section-desc">
        Configure data retention, automatic cleanup (VACUUM, REINDEX), and view maintenance history.
        The maintenance job runs automatically at the configured interval.
      </p>

      {/* ── Database Stats ── */}
      <div className="db-stats-banner">
        <div className="db-stat">
          <span className="db-stat-label">Database Size</span>
          <span className="db-stat-value">{String(dbStats.db_size ?? '—')}</span>
        </div>
        <div className="db-stat">
          <span className="db-stat-label">Total Events</span>
          <span className="db-stat-value">{Number(dbStats.total_events ?? 0).toLocaleString()}</span>
        </div>
        <div className="db-stat">
          <span className="db-stat-label">Total Scores</span>
          <span className="db-stat-value">{Number(dbStats.total_event_scores ?? 0).toLocaleString()}</span>
        </div>
        <div className="db-stat">
          <span className="db-stat-label">Total Findings</span>
          <span className="db-stat-value">{Number(dbStats.total_findings ?? 0).toLocaleString()}</span>
        </div>
        <div className="db-stat">
          <span className="db-stat-label">Templates</span>
          <span className="db-stat-value">{Number(dbStats.total_templates ?? 0).toLocaleString()}</span>
        </div>
      </div>

      {/* ── Global Settings ── */}
      <div className="db-config-section">
        <h4>Global Settings</h4>
        <div className="db-config-grid">
          <div className="form-group">
            <label htmlFor="maint-retention">Default Retention Period (days)</label>
            <input
              id="maint-retention"
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
            />
            <span className="field-hint">
              Events older than this will be deleted. Per-system overrides take precedence.
            </span>
          </div>
          <div className="form-group">
            <label htmlFor="maint-interval">Maintenance Interval (hours)</label>
            <input
              id="maint-interval"
              type="number"
              min={1}
              max={168}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
            />
            <span className="field-hint">
              How often the maintenance job runs (retention cleanup, VACUUM, REINDEX).
            </span>
          </div>
        </div>

        <div className="db-config-actions">
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          <button
            className="btn btn-danger"
            onClick={handleRunNow}
            disabled={running}
            title="Run maintenance job immediately (retention cleanup, VACUUM ANALYZE, REINDEX)"
          >
            {running ? 'Running…' : 'Run Maintenance Now'}
          </button>
        </div>

        {saveMsg && <div className="success-msg">{saveMsg}</div>}
        {saveError && <div className="error-msg" role="alert">{saveError}</div>}
      </div>

      {/* ── Run Result ── */}
      {runResult && (
        <div className="db-run-result">
          <h4>Last Manual Run Result</h4>
          <div className="db-run-result-grid">
            <div><strong>Duration:</strong> {formatDuration(runResult.duration_ms)}</div>
            <div><strong>Events Deleted:</strong> {runResult.events_deleted.toLocaleString()}</div>
            <div><strong>Scores Deleted:</strong> {runResult.event_scores_deleted.toLocaleString()}</div>
            <div><strong>VACUUM:</strong> {runResult.vacuum_ran ? 'Yes' : 'No'}</div>
            <div><strong>REINDEX:</strong> {runResult.reindex_ran ? 'Yes' : 'No'}</div>
          </div>
          {runResult.systems_cleaned.length > 0 && (
            <div className="db-run-systems">
              <strong>Systems cleaned:</strong>
              <ul>
                {runResult.systems_cleaned.map((s) => (
                  <li key={s.system_id}>
                    {s.system_name}: {s.events_deleted.toLocaleString()} events deleted (retention: {s.retention_days} days)
                  </li>
                ))}
              </ul>
            </div>
          )}
          {runResult.errors.length > 0 && (
            <div className="db-run-errors">
              <strong>Errors:</strong>
              <ul>
                {runResult.errors.map((e, i) => (
                  <li key={i} style={{ color: 'var(--danger)' }}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Per-System Retention ── */}
      <div className="db-config-section">
        <h4>Per-System Retention</h4>
        <p className="field-hint" style={{ marginBottom: '8px' }}>
          Systems with custom retention are shown below. Edit a system in the &quot;Systems &amp; Sources&quot;
          tab to set a custom retention period.
        </p>
        {systems.length === 0 ? (
          <p className="text-muted">No systems configured.</p>
        ) : (
          <div className="table-responsive">
            <table className="db-retention-table" aria-label="Per-system retention">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Custom Retention</th>
                  <th>Effective Retention</th>
                </tr>
              </thead>
              <tbody>
                {systems.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>
                      {s.retention_days !== null
                        ? (s.retention_days === 0 ? 'Keep forever' : `${s.retention_days} days`)
                        : <span className="text-muted">Global default</span>}
                    </td>
                    <td>
                      {s.effective_retention_days === 0
                        ? 'Keep forever'
                        : `${s.effective_retention_days} days`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Last Run Info ── */}
      {lastRun && (
        <div className="db-config-section">
          <h4>Last Maintenance Run</h4>
          <div className="db-last-run-info">
            <div><strong>Started:</strong> {formatEuDateTime(lastRun.started_at)}</div>
            <div><strong>Finished:</strong> {formatEuDateTime(lastRun.finished_at)}</div>
            <div><strong>Duration:</strong> {formatDuration(lastRun.duration_ms)}</div>
            <div><strong>Status:</strong> <span className={`db-status-badge db-status-${lastRun.status}`}>{lastRun.status}</span></div>
            <div><strong>Events Deleted:</strong> {lastRun.events_deleted.toLocaleString()}</div>
            <div><strong>Scores Deleted:</strong> {lastRun.event_scores_deleted.toLocaleString()}</div>
          </div>
        </div>
      )}

      {/* ── Run History ── */}
      <div className="db-config-section">
        <button
          className="btn btn-sm btn-outline"
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? 'Hide History' : 'Show Full History'}
        </button>

        {showHistory && (
          <div className="db-history-list" style={{ marginTop: '12px' }}>
            {history.length === 0 ? (
              <p className="text-muted">No maintenance runs recorded yet.</p>
            ) : (
              <div className="table-responsive">
                <table className="db-history-table" aria-label="Maintenance history">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Duration</th>
                      <th>Events Deleted</th>
                      <th>Scores Deleted</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>{formatEuDateTime(h.started_at)}</td>
                        <td>{formatDuration(h.duration_ms)}</td>
                        <td>{h.events_deleted.toLocaleString()}</td>
                        <td>{h.event_scores_deleted.toLocaleString()}</td>
                        <td>
                          <span className={`db-status-badge db-status-${h.status}`}>{h.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {/* ═══════ Database Backup ═══════ */}
      <div className="db-config-section" style={{ marginTop: '24px' }}>
        <button type="button" className="prompt-toggle" onClick={() => setShowBackup((v) => !v)}>
          <span className={`prompt-chevron${showBackup ? ' open' : ''}`}>&#9654;</span>
          Database Backup
          {backupConfig?.backup_enabled && (
            <span className="prompt-custom-badge" style={{ marginLeft: '8px' }}>
              Active — every {backupConfig.backup_interval_hours}h, keep {backupConfig.backup_retention_count}
            </span>
          )}
        </button>

        {showBackup && (
          <div style={{ marginTop: '12px' }}>
            <p className="field-hint" style={{ marginBottom: '12px' }}>
              Automated PostgreSQL backups using pg_dump. Backups are stored in the Docker volume and can be
              downloaded from here. Enable scheduled backups or trigger a manual backup at any time.
            </p>

            {/* Backup Settings */}
            <div className="db-config-grid" style={{ marginBottom: '12px' }}>
              <div className="form-group">
                <label className="privacy-toggle-label">
                  <input
                    type="checkbox"
                    checked={backupEnabled}
                    onChange={(e) => setBackupEnabled(e.target.checked)}
                  />
                  <strong>Enable Scheduled Backups</strong>
                </label>
                <span className="field-hint">
                  When enabled, backups run automatically during maintenance cycles.
                </span>
              </div>

              <div className="form-group">
                <label htmlFor="backup-interval">Backup Interval (hours)</label>
                <input
                  id="backup-interval"
                  type="number"
                  min={1}
                  max={720}
                  value={backupIntervalHours}
                  onChange={(e) => setBackupIntervalHours(e.target.value)}
                  style={{ width: '120px' }}
                  disabled={!backupEnabled}
                />
                <span className="field-hint">
                  How often to create a new backup (1–720 hours).
                </span>
              </div>

              <div className="form-group">
                <label htmlFor="backup-retention">Keep Last N Backups</label>
                <input
                  id="backup-retention"
                  type="number"
                  min={1}
                  max={100}
                  value={backupRetentionCount}
                  onChange={(e) => setBackupRetentionCount(e.target.value)}
                  style={{ width: '120px' }}
                />
                <span className="field-hint">
                  Older backups are automatically deleted to save space.
                </span>
              </div>

              <div className="form-group">
                <label htmlFor="backup-format">Backup Format</label>
                <select
                  id="backup-format"
                  value={backupFormat}
                  onChange={(e) => setBackupFormat(e.target.value as 'custom' | 'plain')}
                  style={{ width: '200px' }}
                >
                  <option value="custom">Custom (.dump) — compact binary</option>
                  <option value="plain">Plain SQL (.sql.gz) — compressed text</option>
                </select>
                <span className="field-hint">
                  Custom format is smaller and supports parallel restore. Plain SQL is human-readable.
                </span>
              </div>
            </div>

            <div className="db-config-actions">
              <button className="btn" onClick={handleBackupSave} disabled={backupSaving}>
                {backupSaving ? 'Saving…' : 'Save Backup Settings'}
              </button>
              <button
                className="btn btn-outline"
                onClick={handleBackupNow}
                disabled={backupRunning}
                title="Create a backup immediately"
              >
                {backupRunning ? 'Backing up…' : 'Run Backup Now'}
              </button>
            </div>

            {backupMsg && <div className="success-msg">{backupMsg}</div>}
            {backupError && <div className="error-msg" role="alert">{backupError}</div>}

            {/* Backup Run Result */}
            {backupResult && (
              <div
                className={`db-run-result`}
                style={{ marginTop: '12px', borderColor: backupResult.success ? 'var(--green)' : 'var(--red)' }}
              >
                <h4>Backup Result</h4>
                <div>
                  <strong>Status:</strong>{' '}
                  <span style={{ color: backupResult.success ? 'var(--green)' : 'var(--red)' }}>
                    {backupResult.success ? 'Success' : 'Failed'}
                  </span>
                </div>
                {backupResult.filename && <div><strong>File:</strong> {backupResult.filename}</div>}
                {backupResult.size_bytes != null && (
                  <div><strong>Size:</strong> {(backupResult.size_bytes / (1024 * 1024)).toFixed(2)} MB</div>
                )}
                <div><strong>Duration:</strong> {formatDuration(backupResult.duration_ms)}</div>
                {backupResult.error && (
                  <div style={{ color: 'var(--red)' }}><strong>Error:</strong> {backupResult.error}</div>
                )}
              </div>
            )}

            {/* Backup File List */}
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ marginBottom: '8px' }}>Available Backups ({backupList.length})</h4>
              {backupList.length === 0 ? (
                <p className="text-muted">No backups available. Run a backup to create one.</p>
              ) : (
                <div className="table-responsive">
                  <table className="db-retention-table" aria-label="Backup files">
                    <thead>
                      <tr>
                        <th>Filename</th>
                        <th>Size</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backupList.map((b) => (
                        <tr key={b.filename}>
                          <td><code>{b.filename}</code></td>
                          <td>{b.size_human}</td>
                          <td>{formatEuDateTime(b.created_at)}</td>
                          <td>
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() => handleBackupDownload(b.filename)}
                              title="Download this backup"
                              style={{ marginRight: '6px' }}
                            >
                              Download
                            </button>
                            <button
                              className="btn btn-xs btn-danger-outline"
                              onClick={() => handleBackupDelete(b.filename)}
                              title="Delete this backup"
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
