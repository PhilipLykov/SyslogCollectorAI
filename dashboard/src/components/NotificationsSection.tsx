import { useEffect, useState, useCallback } from 'react';
import {
  type NotificationChannel,
  type ChannelType,
  fetchNotificationChannels,
  createNotificationChannel,
  updateNotificationChannel,
  deleteNotificationChannel,
  testNotificationChannel,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';

interface NotificationsSectionProps {
  onAuthError: () => void;
}

// ── Channel type metadata ────────────────────────────────────

const CHANNEL_TYPES: { value: ChannelType; label: string; description: string }[] = [
  { value: 'ntfy', label: 'NTfy', description: 'NTfy push notifications (ntfy.sh or self-hosted)' },
  { value: 'telegram', label: 'Telegram', description: 'Telegram Bot messages' },
  { value: 'webhook', label: 'Webhook', description: 'Generic HTTP POST webhook' },
  { value: 'gotify', label: 'Gotify', description: 'Gotify server notifications' },
  { value: 'pushover', label: 'Pushover', description: 'Pushover push notifications' },
];

// Field definitions for each channel type config
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  type: 'text' | 'password' | 'url';
  hint?: string;
}

const CHANNEL_FIELDS: Record<ChannelType, FieldDef[]> = {
  webhook: [
    { key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/webhook', required: true, type: 'url' },
  ],
  ntfy: [
    { key: 'base_url', label: 'Server URL', placeholder: 'https://ntfy.sh', required: false, type: 'url', hint: 'Leave empty for public ntfy.sh' },
    { key: 'topic', label: 'Topic', placeholder: 'my-alerts', required: true, type: 'text' },
    { key: 'auth_header_ref', label: 'Auth Header', placeholder: 'Bearer tk_...  or  env:NTFY_TOKEN', required: false, type: 'password', hint: 'Bearer token or env: reference' },
  ],
  pushover: [
    { key: 'token_ref', label: 'App Token', placeholder: 'env:PUSHOVER_TOKEN', required: true, type: 'password', hint: 'Pushover app token or env: reference' },
    { key: 'user_key', label: 'User Key', placeholder: 'env:PUSHOVER_USER_KEY', required: true, type: 'password', hint: 'Pushover user key or env: reference' },
  ],
  gotify: [
    { key: 'base_url', label: 'Gotify URL', placeholder: 'https://gotify.example.com', required: true, type: 'url' },
    { key: 'token_ref', label: 'App Token', placeholder: 'env:GOTIFY_APP_TOKEN', required: true, type: 'password', hint: 'Gotify app token or env: reference' },
  ],
  telegram: [
    { key: 'token_ref', label: 'Bot Token', placeholder: 'env:TELEGRAM_BOT_TOKEN', required: true, type: 'password', hint: 'Telegram bot token or env: reference' },
    { key: 'chat_id', label: 'Chat ID', placeholder: '-1001234567890', required: true, type: 'text', hint: 'Telegram chat/group ID' },
  ],
};

// ── Component ────────────────────────────────────────────────

type Modal =
  | { kind: 'create' }
  | { kind: 'edit'; channel: NotificationChannel }
  | { kind: 'delete'; channel: NotificationChannel }
  | null;

export function NotificationsSection({ onAuthError }: NotificationsSectionProps) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await fetchNotificationChannels();
      setChannels(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  // ── Test notification ─────────────────────────────────
  const handleTest = async (id: string) => {
    setTesting(id);
    setError('');
    setSuccess('');
    try {
      const result = await testNotificationChannel(id);
      setSuccess(result.message || 'Test notification sent successfully.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(`Test failed: ${msg}`);
    } finally {
      setTesting(null);
    }
  };

  // ── Toggle enabled ────────────────────────────────────
  const handleToggle = async (channel: NotificationChannel) => {
    try {
      const updated = await updateNotificationChannel(channel.id, { enabled: !channel.enabled });
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? updated : c)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    }
  };

  // ── Create/Update ─────────────────────────────────────
  const handleSaveChannel = async (
    type: ChannelType,
    name: string,
    config: Record<string, unknown>,
    existingId?: string,
  ) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (existingId) {
        const updated = await updateNotificationChannel(existingId, { name, config });
        setChannels((prev) => prev.map((c) => (c.id === existingId ? updated : c)));
        setSuccess('Channel updated.');
      } else {
        const created = await createNotificationChannel({ type, name, config });
        setChannels((prev) => [...prev, created]);
        setSuccess('Channel created.');
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

  // ── Delete ────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await deleteNotificationChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
      setModal(null);
      setSuccess('Channel deleted.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const channelTypeName = (type: string) => {
    return CHANNEL_TYPES.find((t) => t.value === type)?.label ?? type;
  };

  // ── Render ────────────────────────────────────────────
  return (
    <div className="notif-section">
      <div className="notif-header">
        <div>
          <h3>Notification Channels</h3>
          <p className="notif-desc">
            Configure where alert notifications are sent. Create channels, then set up notification rules to trigger them.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setModal({ kind: 'create' })}>
          + Add Channel
        </button>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {loading ? (
        <div className="settings-loading"><div className="spinner" /> Loading channels…</div>
      ) : channels.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#128276;</div>
          <h4>No notification channels</h4>
          <p>
            Create a notification channel to start receiving alerts when scores exceed thresholds.
            Supported: NTfy, Telegram, Webhook, Gotify, Pushover.
          </p>
        </div>
      ) : (
        <div className="notif-channel-list">
          {channels.map((ch) => (
            <div key={ch.id} className={`notif-channel-card${ch.enabled ? '' : ' disabled'}`}>
              <div className="notif-channel-top">
                <div className="notif-channel-info">
                  <span className={`notif-type-badge ${ch.type}`}>{channelTypeName(ch.type)}</span>
                  <strong className="notif-channel-name">{ch.name}</strong>
                  {!ch.enabled && <span className="notif-disabled-badge">Disabled</span>}
                </div>
                <div className="notif-channel-actions">
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => handleTest(ch.id)}
                    disabled={testing === ch.id || !ch.enabled}
                    title={!ch.enabled ? 'Enable the channel to test it' : 'Send a test notification'}
                  >
                    {testing === ch.id ? 'Sending…' : 'Test'}
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => handleToggle(ch)}
                  >
                    {ch.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => setModal({ kind: 'edit', channel: ch })}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-xs btn-danger-outline"
                    onClick={() => setModal({ kind: 'delete', channel: ch })}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="notif-channel-detail">
                <ChannelConfigSummary type={ch.type as ChannelType} config={ch.config} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Supported types reference */}
      <details className="settings-help">
        <summary>Supported notification types</summary>
        <div className="settings-help-content">
          <ul>
            {CHANNEL_TYPES.map((t) => (
              <li key={t.value}><strong>{t.label}</strong> — {t.description}</li>
            ))}
          </ul>
          <p>
            <strong>Tip:</strong> For sensitive values (tokens, passwords), you can use environment
            variable references like <code>env:MY_TOKEN</code> instead of storing the actual value.
            The backend will resolve these at runtime from the container environment.
          </p>
        </div>
      </details>

      {/* ── Modals ── */}
      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <ChannelFormModal
          mode={modal.kind}
          channel={modal.kind === 'edit' ? modal.channel : undefined}
          saving={saving}
          onSave={handleSaveChannel}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Channel"
          message={`Are you sure you want to delete the channel "${modal.channel.name}"? Any notification rules using this channel will also be deleted.`}
          confirmLabel="Delete Channel"
          danger
          onConfirm={() => handleDelete(modal.channel.id)}
          onCancel={() => setModal(null)}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Channel config summary (read-only display) ──────────────

function ChannelConfigSummary({ type, config }: { type: ChannelType; config: Record<string, unknown> }) {
  const fields = CHANNEL_FIELDS[type] ?? [];
  if (fields.length === 0) return null;

  return (
    <div className="notif-config-summary">
      {fields.map((f) => {
        const val = config[f.key];
        if (val === undefined || val === null || val === '') return null;
        const display = f.type === 'password'
          ? maskValue(String(val))
          : String(val);
        return (
          <span key={f.key} className="notif-config-item">
            <span className="notif-config-label">{f.label}:</span>{' '}
            <code>{display}</code>
          </span>
        );
      })}
    </div>
  );
}

function maskValue(val: string): string {
  if (val.startsWith('env:')) return val; // env refs are safe to show
  if (val.length <= 6) return '****';
  return `${val.slice(0, 3)}${'*'.repeat(Math.max(3, val.length - 6))}${val.slice(-3)}`;
}

// ── Channel form modal ──────────────────────────────────────

function ChannelFormModal({
  mode,
  channel,
  saving,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit';
  channel?: NotificationChannel;
  saving: boolean;
  onSave: (type: ChannelType, name: string, config: Record<string, unknown>, existingId?: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'ntfy');
  const [name, setName] = useState(channel?.name ?? '');
  const [configValues, setConfigValues] = useState<Record<string, string>>(() => {
    if (!channel) return {};
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(channel.config)) {
      vals[k] = String(v ?? '');
    }
    return vals;
  });

  const fields = CHANNEL_FIELDS[type] ?? [];

  const handleFieldChange = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: Record<string, unknown> = {};
    for (const f of fields) {
      const val = (configValues[f.key] ?? '').trim();
      if (val) config[f.key] = val;
    }
    onSave(type, name.trim(), config, channel?.id);
  };

  // When type changes in create mode, reset config values
  const handleTypeChange = (newType: ChannelType) => {
    setType(newType);
    if (mode === 'create') {
      setConfigValues({});
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Add Notification Channel' : 'Edit Channel'}>
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{mode === 'create' ? 'Add Notification Channel' : 'Edit Channel'}</h3>
        <form onSubmit={handleSubmit}>
          {/* Channel type (only for create) */}
          {mode === 'create' && (
            <div className="form-group">
              <label htmlFor="ch-type">Type</label>
              <select
                id="ch-type"
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as ChannelType)}
              >
                {CHANNEL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                ))}
              </select>
            </div>
          )}

          {/* Channel name */}
          <div className="form-group">
            <label htmlFor="ch-name">Name</label>
            <input
              id="ch-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Alerts"
              required
              autoComplete="off"
            />
          </div>

          {/* Type-specific config fields */}
          {fields.map((f) => (
            <div className="form-group" key={f.key}>
              <label htmlFor={`ch-${f.key}`}>{f.label}{f.required && ' *'}</label>
              <input
                id={`ch-${f.key}`}
                type={f.type === 'password' ? 'text' : f.type}
                value={configValues[f.key] ?? ''}
                onChange={(e) => handleFieldChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                required={f.required}
                autoComplete="off"
              />
              {f.hint && <span className="form-hint">{f.hint}</span>}
            </div>
          ))}

          <div className="modal-actions">
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create Channel' : 'Save Changes'}
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
