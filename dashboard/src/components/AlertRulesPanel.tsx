import { useEffect, useState, useCallback } from 'react';
import {
  type NotificationChannel,
  type NotificationRule,
  type MonitoredSystem,
  CRITERIA,
  fetchNotificationChannels,
  fetchNotificationRules,
  fetchSystems,
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';

interface AlertRulesPanelProps {
  onAuthError: () => void;
}

// ── Helpers ──────────────────────────────────────────────────

function severityForThreshold(pct: number): { label: string; cls: string } {
  if (pct >= 75) return { label: 'Critical', cls: 'critical' };
  if (pct >= 50) return { label: 'High', cls: 'high' };
  if (pct >= 25) return { label: 'Medium', cls: 'medium' };
  return { label: 'Low', cls: 'low' };
}

function criterionName(id: number | string | null | undefined): string {
  if (id == null) return 'Any criterion';
  const c = CRITERIA.find((c) => c.id === Number(id));
  return c?.name ?? `Criterion #${id}`;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', {
      timeZone: 'Europe/Chisinau',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return iso; }
}

// ── Component ────────────────────────────────────────────────

type Modal =
  | { kind: 'create' }
  | { kind: 'edit'; rule: NotificationRule }
  | { kind: 'delete'; rule: NotificationRule }
  | null;

export function AlertRulesPanel({ onAuthError }: AlertRulesPanelProps) {
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [rulesData, channelsData, systemsData] = await Promise.all([
        fetchNotificationRules(),
        fetchNotificationChannels(),
        fetchSystems(),
      ]);
      setRules(rulesData);
      setChannels(channelsData);
      setSystems(systemsData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  const channelName = (id: string) =>
    channels.find((c) => c.id === id)?.name ?? 'Unknown channel';

  const channelType = (id: string) =>
    channels.find((c) => c.id === id)?.type ?? '';

  const systemName = (id: string) =>
    systems.find((s) => s.id === id)?.name ?? 'Unknown';

  // ── Toggle enabled ──────────────────────────────────
  const handleToggle = async (rule: NotificationRule) => {
    try {
      const updated = await updateNotificationRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    }
  };

  // ── Save ────────────────────────────────────────────
  const handleSave = async (data: RuleFormData, existingId?: string) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const triggerConfig: Record<string, unknown> = { min_score: data.threshold / 100 };
      if (data.criterionId !== null) triggerConfig.criterion_id = data.criterionId;

      const filters: Record<string, unknown> | undefined =
        data.systemIds.length > 0 ? { system_ids: data.systemIds } : undefined;

      const payload = {
        channel_id: data.channelId,
        trigger_type: 'threshold' as const,
        trigger_config: triggerConfig,
        filters,
        throttle_interval_seconds: data.throttleMinutes > 0 ? data.throttleMinutes * 60 : undefined,
        send_recovery: data.sendRecovery,
        notify_only_on_state_change: data.onlyStateChange,
        enabled: true,
      };

      if (existingId) {
        const updated = await updateNotificationRule(existingId, payload);
        setRules((prev) => prev.map((r) => (r.id === existingId ? updated : r)));
        setSuccess('Alert rule updated.');
      } else {
        const created = await createNotificationRule(payload);
        setRules((prev) => [...prev, created]);
        setSuccess('Alert rule created.');
      }
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ──────────────────────────────────────────
  const handleDelete = async (id: string) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await deleteNotificationRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      setModal(null);
      setSuccess('Alert rule deleted.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──────────────────────────────────────────
  if (loading) {
    return <div className="settings-loading"><div className="spinner" /> Loading alert rules…</div>;
  }

  const enabledChannels = channels.filter((c) => c.enabled);

  return (
    <div className="alert-rules-panel">
      <div className="notif-header">
        <div>
          <h3>Alert Rules</h3>
          <p className="notif-desc">
            Define when alerts fire based on score thresholds. Each rule watches a criterion
            score and sends notifications through a configured channel.
          </p>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => setModal({ kind: 'create' })}
          disabled={enabledChannels.length === 0}
          title={enabledChannels.length === 0 ? 'Create a notification channel first' : undefined}
        >
          + Add Rule
        </button>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss">&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {enabledChannels.length === 0 && (
        <div className="alert-rules-hint">
          You need at least one enabled notification channel before creating alert rules.
          Go to the <strong>Channels</strong> tab to set one up.
        </div>
      )}

      {rules.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#9888;</div>
          <h4>No alert rules</h4>
          <p>
            Create an alert rule to be notified when score thresholds are exceeded.
            For example: &quot;Alert me when IT Security score is above 50%.&quot;
          </p>
        </div>
      ) : (
        <div className="alert-rules-list">
          {rules.map((rule) => {
            const tc = rule.trigger_config as { min_score?: number; criterion_id?: number };
            const pct = Math.round((tc.min_score ?? 0.5) * 100);
            const sev = severityForThreshold(pct);
            const filters = rule.filters as { system_ids?: string[] } | null;
            const filteredSystems = filters?.system_ids ?? [];

            return (
              <div key={rule.id} className={`alert-rule-card${rule.enabled ? '' : ' disabled'}`}>
                <div className="alert-rule-top">
                  <div className="alert-rule-summary">
                    <span className={`alert-rule-severity ${sev.cls}`}>{sev.label}</span>
                    <span className="alert-rule-criterion">{criterionName(tc.criterion_id)}</span>
                    <span className="alert-rule-threshold">&ge; {pct}%</span>
                  </div>
                  <div className="alert-rule-actions">
                    <button className="btn btn-xs btn-outline" onClick={() => handleToggle(rule)}>
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn btn-xs btn-outline" onClick={() => setModal({ kind: 'edit', rule })}>
                      Edit
                    </button>
                    <button className="btn btn-xs btn-danger-outline" onClick={() => setModal({ kind: 'delete', rule })}>
                      Delete
                    </button>
                  </div>
                </div>

                <div className="alert-rule-details">
                  <span className="alert-rule-detail-item">
                    <span className="alert-rule-detail-label">Channel:</span>{' '}
                    <span className={`notif-type-badge ${channelType(rule.channel_id)}`} style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                      {channelType(rule.channel_id).toUpperCase()}
                    </span>{' '}
                    {channelName(rule.channel_id)}
                  </span>
                  <span className="alert-rule-detail-item">
                    <span className="alert-rule-detail-label">Systems:</span>{' '}
                    {filteredSystems.length === 0
                      ? 'All systems'
                      : filteredSystems.map((id) => systemName(id)).join(', ')}
                  </span>
                </div>

                <div className="alert-rule-meta">
                  {rule.throttle_interval_seconds
                    ? <span>Throttle: {Math.round(rule.throttle_interval_seconds / 60)} min</span>
                    : <span>No throttle</span>}
                  <span>{rule.send_recovery ? 'Recovery: Yes' : 'Recovery: No'}</span>
                  {rule.notify_only_on_state_change && <span>State-change only</span>}
                  {!rule.enabled && <span className="notif-disabled-badge">Disabled</span>}
                  <span className="alert-rule-date">Created {formatDateTime(rule.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── How it works ── */}
      <details className="settings-help">
        <summary>How alert rules work</summary>
        <div className="settings-help-content">
          <p>
            The system evaluates each rule after every analysis window (default: every 5 minutes).
          </p>
          <ul>
            <li><strong>Criterion</strong> — which score dimension to watch (or &quot;Any&quot; for all).</li>
            <li><strong>Threshold</strong> — score level (0-100%) that triggers the alert.</li>
            <li><strong>Throttle</strong> — minimum time between repeat notifications for the same condition.</li>
            <li><strong>Recovery</strong> — send a &quot;resolved&quot; notification when the score drops below threshold.</li>
            <li><strong>State-change only</strong> — only notify when transitioning from OK → Firing or Firing → OK.</li>
          </ul>
          <p><strong>Severity mapping:</strong> &ge;75% = Critical, &ge;50% = High, &ge;25% = Medium, &lt;25% = Low.</p>
        </div>
      </details>

      {/* ── Modals ── */}
      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <RuleFormModal
          mode={modal.kind}
          rule={modal.kind === 'edit' ? modal.rule : undefined}
          channels={enabledChannels}
          systems={systems}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Alert Rule"
          message="Are you sure you want to delete this alert rule? Alert history will also be removed. This cannot be undone."
          confirmLabel="Delete Rule"
          danger
          onConfirm={() => handleDelete(modal.rule.id)}
          onCancel={() => setModal(null)}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Rule form data ───────────────────────────────────────────

interface RuleFormData {
  channelId: string;
  criterionId: number | null;
  threshold: number; // 0-100
  systemIds: string[];
  throttleMinutes: number;
  sendRecovery: boolean;
  onlyStateChange: boolean;
}

// ── Rule form modal ──────────────────────────────────────────

function RuleFormModal({
  mode,
  rule,
  channels,
  systems,
  saving,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit';
  rule?: NotificationRule;
  channels: NotificationChannel[];
  systems: MonitoredSystem[];
  saving: boolean;
  onSave: (data: RuleFormData, existingId?: string) => void;
  onCancel: () => void;
}) {
  // Parse existing rule data
  const tc = rule?.trigger_config as { min_score?: number; criterion_id?: number } | undefined;
  const filters = rule?.filters as { system_ids?: string[] } | null | undefined;

  const [channelId, setChannelId] = useState(rule?.channel_id ?? channels[0]?.id ?? '');
  const [criterionId, setCriterionId] = useState<number | null>(tc?.criterion_id ?? null);
  const [threshold, setThreshold] = useState(Math.round((tc?.min_score ?? 0.5) * 100));
  const [selectedSystems, setSelectedSystems] = useState<string[]>(filters?.system_ids ?? []);
  const [allSystems, setAllSystems] = useState(!(filters?.system_ids?.length));
  const [throttleMinutes, setThrottleMinutes] = useState(
    rule?.throttle_interval_seconds ? Math.round(rule.throttle_interval_seconds / 60) : 5,
  );
  const [sendRecovery, setSendRecovery] = useState(rule?.send_recovery ?? true);
  const [onlyStateChange, setOnlyStateChange] = useState(rule?.notify_only_on_state_change ?? true);

  const sev = severityForThreshold(threshold);

  const toggleSystem = (id: string) => {
    setSelectedSystems((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(
      {
        channelId,
        criterionId,
        threshold,
        systemIds: allSystems ? [] : selectedSystems,
        throttleMinutes,
        sendRecovery,
        onlyStateChange,
      },
      rule?.id,
    );
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Create Alert Rule' : 'Edit Alert Rule'}>
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{mode === 'create' ? 'Create Alert Rule' : 'Edit Alert Rule'}</h3>
        <form onSubmit={handleSubmit}>

          {/* Section 1: Trigger condition */}
          <fieldset className="rule-fieldset">
            <legend>When should this alert fire?</legend>

            <div className="form-group">
              <label htmlFor="rule-criterion">Score criterion</label>
              <select
                id="rule-criterion"
                value={criterionId ?? ''}
                onChange={(e) => setCriterionId(e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">Any criterion (fires on any score)</option>
                {CRITERIA.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="rule-threshold">
                Score threshold: <strong>{threshold}%</strong>
                <span className={`threshold-severity-label ${sev.cls}`}>{sev.label}</span>
              </label>
              <div className="threshold-slider-container">
                <input
                  id="rule-threshold"
                  type="range"
                  min={5}
                  max={95}
                  step={5}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="threshold-slider"
                  style={{
                    background: `linear-gradient(to right, var(--green) 0%, var(--yellow) 33%, var(--orange) 66%, var(--red) 100%)`,
                  }}
                />
                <div className="threshold-labels">
                  <span>5%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>95%</span>
                </div>
              </div>
              <span className="form-hint">
                Alert fires when the score reaches or exceeds {threshold}%.
                Higher thresholds = fewer, more critical alerts.
              </span>
            </div>
          </fieldset>

          {/* Section 2: Channel */}
          <fieldset className="rule-fieldset">
            <legend>Where to send notifications?</legend>
            <div className="form-group">
              <label htmlFor="rule-channel">Notification channel</label>
              <select
                id="rule-channel"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                required
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} ({ch.type})
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          {/* Section 3: Systems */}
          <fieldset className="rule-fieldset">
            <legend>Which systems to monitor?</legend>
            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={allSystems}
                  onChange={(e) => setAllSystems(e.target.checked)}
                />
                All systems (current and future)
              </label>
            </div>
            {!allSystems && (
              <div className="system-checkboxes">
                {systems.length === 0 ? (
                  <span className="form-hint">No systems configured yet.</span>
                ) : (
                  systems.map((s) => (
                    <label key={s.id} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedSystems.includes(s.id)}
                        onChange={() => toggleSystem(s.id)}
                      />
                      {s.name}
                    </label>
                  ))
                )}
              </div>
            )}
          </fieldset>

          {/* Section 4: Behavior */}
          <fieldset className="rule-fieldset">
            <legend>Alert behavior</legend>

            <div className="form-group">
              <label htmlFor="rule-throttle">Minimum interval between alerts (minutes)</label>
              <input
                id="rule-throttle"
                type="number"
                min={0}
                max={1440}
                value={throttleMinutes}
                onChange={(e) => setThrottleMinutes(Number(e.target.value))}
                className="input-short"
              />
              <span className="form-hint">
                0 = no throttle (alert on every evaluation cycle). Recommended: 5-15 minutes.
              </span>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={sendRecovery}
                  onChange={(e) => setSendRecovery(e.target.checked)}
                />
                Send recovery notifications when score drops below threshold
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={onlyStateChange}
                  onChange={(e) => setOnlyStateChange(e.target.checked)}
                />
                Only notify on state change (recommended — prevents repeated alerts)
              </label>
            </div>
          </fieldset>

          <div className="modal-actions">
            <button type="submit" className="btn" disabled={saving || !channelId}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create Rule' : 'Save Changes'}
            </button>
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
