import { useEffect, useState, useCallback } from 'react';
import {
  type Silence,
  type MonitoredSystem,
  type NotificationRule,
  CRITERIA,
  fetchSilences,
  fetchSystems,
  fetchNotificationRules,
  createSilence,
  deleteSilence,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';

interface SilencesPanelProps {
  onAuthError: () => void;
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

function silenceStatus(s: Silence): { label: string; cls: string } {
  const now = Date.now();
  const start = new Date(s.starts_at).getTime();
  const end = new Date(s.ends_at).getTime();
  if (!s.enabled) return { label: 'Disabled', cls: 'disabled' };
  if (now < start) return { label: 'Scheduled', cls: 'scheduled' };
  if (now >= start && now < end) return { label: 'Active', cls: 'active' };
  return { label: 'Expired', cls: 'expired' };
}

export function SilencesPanel({ onAuthError }: SilencesPanelProps) {
  const [silences, setSilences] = useState<Silence[]>([]);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Silence | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [silData, sysData, ruleData] = await Promise.all([
        fetchSilences(),
        fetchSystems(),
        fetchNotificationRules(),
      ]);
      setSilences(silData);
      setSystems(sysData);
      setRules(ruleData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  const systemName = (id: string) =>
    systems.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const ruleSummary = (id: string) => {
    const r = rules.find((r) => r.id === id);
    if (!r) return id.slice(0, 8);
    const tc = r.trigger_config as { min_score?: number; criterion_id?: number };
    const cName = tc.criterion_id
      ? (CRITERIA.find((c) => c.id === tc.criterion_id)?.name ?? 'Any')
      : 'Any';
    return `${cName} ≥ ${Math.round((tc.min_score ?? 0.5) * 100)}%`;
  };

  const handleCreate = async (data: SilenceFormData) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const created = await createSilence({
        name: data.name || undefined,
        starts_at: data.startsAt,
        ends_at: data.endsAt,
        scope: data.scope,
        comment: data.comment || undefined,
      });
      setSilences((prev) => [created, ...prev]);
      setShowCreate(false);
      setSuccess('Silence created.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await deleteSilence(id);
      setSilences((prev) => prev.filter((s) => s.id !== id));
      setDeleteTarget(null);
      setSuccess('Silence deleted.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const scopeLabel = (scope: Silence['scope']) => {
    if (scope.global) return 'Global (all systems & rules)';
    const parts: string[] = [];
    if (scope.system_ids?.length) {
      parts.push(`Systems: ${scope.system_ids.map(systemName).join(', ')}`);
    }
    if (scope.rule_ids?.length) {
      parts.push(`Rules: ${scope.rule_ids.map(ruleSummary).join(', ')}`);
    }
    return parts.join(' | ') || 'Unknown scope';
  };

  if (loading) {
    return <div className="settings-loading"><div className="spinner" /> Loading silences…</div>;
  }

  return (
    <div className="silences-panel">
      <div className="notif-header">
        <div>
          <h3>Silences</h3>
          <p className="notif-desc">
            Temporarily mute alerts during maintenance windows or known incidents.
            Active silences suppress all matching notifications.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setShowCreate(true)}>
          + Add Silence
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

      {silences.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#128264;</div>
          <h4>No silences</h4>
          <p>Create a silence to temporarily mute alerts during planned maintenance or known events.</p>
        </div>
      ) : (
        <div className="silence-list">
          {silences.map((s) => {
            const status = silenceStatus(s);
            return (
              <div key={s.id} className={`silence-card ${status.cls}`}>
                <div className="silence-top">
                  <div className="silence-info">
                    <span className={`silence-status-badge ${status.cls}`}>{status.label}</span>
                    <strong>{s.name || 'Untitled silence'}</strong>
                  </div>
                  <button className="btn btn-xs btn-danger-outline" onClick={() => setDeleteTarget(s)}>
                    Delete
                  </button>
                </div>
                <div className="silence-details">
                  <span><strong>From:</strong> {formatDateTime(s.starts_at)}</span>
                  <span><strong>Until:</strong> {formatDateTime(s.ends_at)}</span>
                </div>
                <div className="silence-scope">
                  <strong>Scope:</strong> {scopeLabel(s.scope)}
                </div>
                {s.comment && <div className="silence-comment">{s.comment}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Create modal ── */}
      {showCreate && (
        <SilenceFormModal
          systems={systems}
          rules={rules}
          saving={saving}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Silence"
          message={`Delete the silence "${deleteTarget.name || 'Untitled'}"? Silenced alerts will resume firing.`}
          confirmLabel="Delete Silence"
          danger
          onConfirm={() => handleDelete(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Silence form ─────────────────────────────────────────────

interface SilenceFormData {
  name: string;
  startsAt: string;
  endsAt: string;
  scope: { global?: boolean; system_ids?: string[]; rule_ids?: string[] };
  comment: string;
}

const DURATION_PRESETS = [
  { label: '1 hour', hours: 1 },
  { label: '2 hours', hours: 2 },
  { label: '4 hours', hours: 4 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
];

function SilenceFormModal({
  systems,
  rules,
  saving,
  onSave,
  onCancel,
}: {
  systems: MonitoredSystem[];
  rules: NotificationRule[];
  saving: boolean;
  onSave: (data: SilenceFormData) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [scopeType, setScopeType] = useState<'global' | 'systems' | 'rules'>('global');
  const [selectedSystems, setSelectedSystems] = useState<string[]>([]);
  const [selectedRules, setSelectedRules] = useState<string[]>([]);

  // Duration
  const now = new Date();
  const [startsAt] = useState(now.toISOString());
  const [durationHours, setDurationHours] = useState(2);

  const endsAt = new Date(new Date(startsAt).getTime() + durationHours * 3600_000).toISOString();

  const toggleSystem = (id: string) =>
    setSelectedSystems((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );

  const toggleRule = (id: string) =>
    setSelectedRules((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );

  const ruleSummary = (r: NotificationRule) => {
    const tc = r.trigger_config as { min_score?: number; criterion_id?: number };
    const cName = tc.criterion_id
      ? (CRITERIA.find((c) => c.id === tc.criterion_id)?.name ?? 'Any')
      : 'Any criterion';
    return `${cName} ≥ ${Math.round((tc.min_score ?? 0.5) * 100)}%`;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let scope: SilenceFormData['scope'];
    if (scopeType === 'global') {
      scope = { global: true };
    } else if (scopeType === 'systems') {
      scope = { system_ids: selectedSystems };
    } else {
      scope = { rule_ids: selectedRules };
    }

    onSave({ name, startsAt, endsAt, scope, comment });
  };

  const isValid =
    (scopeType === 'global') ||
    (scopeType === 'systems' && selectedSystems.length > 0) ||
    (scopeType === 'rules' && selectedRules.length > 0);

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-label="Create Silence">
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Create Silence</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="sil-name">Name (optional)</label>
            <input
              id="sil-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Server maintenance"
              autoComplete="off"
            />
          </div>

          {/* Duration */}
          <div className="form-group">
            <label>Duration (starting now)</label>
            <div className="duration-presets">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.hours}
                  type="button"
                  className={`duration-btn${durationHours === p.hours ? ' active' : ''}`}
                  onClick={() => setDurationHours(p.hours)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="form-hint">
              Silence ends: {new Date(endsAt).toLocaleString('en-GB', { timeZone: 'Europe/Chisinau', hour12: false })}
            </span>
          </div>

          {/* Scope */}
          <fieldset className="rule-fieldset">
            <legend>Scope</legend>

            <div className="form-group">
              <label className="checkbox-label">
                <input type="radio" name="scope" checked={scopeType === 'global'} onChange={() => setScopeType('global')} />
                Global — mute all alerts
              </label>
              <label className="checkbox-label">
                <input type="radio" name="scope" checked={scopeType === 'systems'} onChange={() => setScopeType('systems')} />
                Specific systems
              </label>
              <label className="checkbox-label">
                <input type="radio" name="scope" checked={scopeType === 'rules'} onChange={() => setScopeType('rules')} />
                Specific rules
              </label>
            </div>

            {scopeType === 'systems' && (
              <div className="system-checkboxes">
                {systems.map((s) => (
                  <label key={s.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedSystems.includes(s.id)}
                      onChange={() => toggleSystem(s.id)}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}

            {scopeType === 'rules' && (
              <div className="system-checkboxes">
                {rules.map((r) => (
                  <label key={r.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedRules.includes(r.id)}
                      onChange={() => toggleRule(r.id)}
                    />
                    {ruleSummary(r)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="form-group">
            <label htmlFor="sil-comment">Comment (optional)</label>
            <textarea
              id="sil-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Reason for the silence…"
              rows={2}
            />
          </div>

          <div className="modal-actions">
            <button type="submit" className="btn" disabled={saving || !isValid}>
              {saving ? 'Creating…' : 'Create Silence'}
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
