import { useState, useRef, useEffect } from 'react';
import { type EsConnection, fetchEsConnections } from '../api';

interface SystemFormProps {
  title: string;
  initialName?: string;
  initialDescription?: string;
  initialRetentionDays?: number | null;
  initialTzOffsetMinutes?: number | null;
  initialTzName?: string | null;
  initialEventSource?: 'postgresql' | 'elasticsearch';
  initialEsConnectionId?: string | null;
  initialEsConfig?: Record<string, unknown> | null;
  onSave: (data: SystemFormData) => void;
  onCancel: () => void;
  saving: boolean;
}

export interface SystemFormData {
  name: string;
  description: string;
  retention_days: number | null;
  tz_offset_minutes: number | null;
  tz_name: string | null;
  event_source: 'postgresql' | 'elasticsearch';
  es_connection_id: string | null;
  es_config: Record<string, unknown> | null;
}

/** Common UTC timezone offsets for the dropdown. */
const TZ_OFFSETS = [
  { value: '', label: 'None (use server default)' },
  { value: '-720', label: 'UTC-12:00' },
  { value: '-660', label: 'UTC-11:00' },
  { value: '-600', label: 'UTC-10:00 (Hawaii)' },
  { value: '-540', label: 'UTC-09:00 (Alaska)' },
  { value: '-480', label: 'UTC-08:00 (Pacific)' },
  { value: '-420', label: 'UTC-07:00 (Mountain)' },
  { value: '-360', label: 'UTC-06:00 (Central US)' },
  { value: '-300', label: 'UTC-05:00 (Eastern US)' },
  { value: '-240', label: 'UTC-04:00 (Atlantic)' },
  { value: '-210', label: 'UTC-03:30 (Newfoundland)' },
  { value: '-180', label: 'UTC-03:00 (Brazil)' },
  { value: '-120', label: 'UTC-02:00' },
  { value: '-60', label: 'UTC-01:00' },
  { value: '0', label: 'UTC+00:00 (GMT)' },
  { value: '60', label: 'UTC+01:00 (CET)' },
  { value: '120', label: 'UTC+02:00 (EET)' },
  { value: '180', label: 'UTC+03:00 (Moscow)' },
  { value: '210', label: 'UTC+03:30 (Tehran)' },
  { value: '240', label: 'UTC+04:00 (Dubai)' },
  { value: '270', label: 'UTC+04:30 (Kabul)' },
  { value: '300', label: 'UTC+05:00 (Karachi)' },
  { value: '330', label: 'UTC+05:30 (India)' },
  { value: '345', label: 'UTC+05:45 (Nepal)' },
  { value: '360', label: 'UTC+06:00 (Dhaka)' },
  { value: '420', label: 'UTC+07:00 (Bangkok)' },
  { value: '480', label: 'UTC+08:00 (Singapore)' },
  { value: '540', label: 'UTC+09:00 (Tokyo)' },
  { value: '570', label: 'UTC+09:30 (Adelaide)' },
  { value: '600', label: 'UTC+10:00 (Sydney)' },
  { value: '660', label: 'UTC+11:00' },
  { value: '720', label: 'UTC+12:00 (Auckland)' },
  { value: '780', label: 'UTC+13:00 (Samoa)' },
];

/** Common IANA timezone identifiers grouped by region. */
const IANA_TIMEZONES = [
  { value: '', label: 'None (no timezone correction)' },
  // Europe
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET/CEST)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (CET/CEST)' },
  { value: 'Europe/Rome', label: 'Europe/Rome (CET/CEST)' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid (CET/CEST)' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam (CET/CEST)' },
  { value: 'Europe/Brussels', label: 'Europe/Brussels (CET/CEST)' },
  { value: 'Europe/Zurich', label: 'Europe/Zurich (CET/CEST)' },
  { value: 'Europe/Vienna', label: 'Europe/Vienna (CET/CEST)' },
  { value: 'Europe/Warsaw', label: 'Europe/Warsaw (CET/CEST)' },
  { value: 'Europe/Prague', label: 'Europe/Prague (CET/CEST)' },
  { value: 'Europe/Stockholm', label: 'Europe/Stockholm (CET/CEST)' },
  { value: 'Europe/Helsinki', label: 'Europe/Helsinki (EET/EEST)' },
  { value: 'Europe/Bucharest', label: 'Europe/Bucharest (EET/EEST)' },
  { value: 'Europe/Chisinau', label: 'Europe/Chisinau (EET/EEST)' },
  { value: 'Europe/Sofia', label: 'Europe/Sofia (EET/EEST)' },
  { value: 'Europe/Athens', label: 'Europe/Athens (EET/EEST)' },
  { value: 'Europe/Kyiv', label: 'Europe/Kyiv (EET/EEST)' },
  { value: 'Europe/Moscow', label: 'Europe/Moscow (MSK)' },
  { value: 'Europe/Istanbul', label: 'Europe/Istanbul (TRT)' },
  // Americas
  { value: 'America/New_York', label: 'America/New_York (EST/EDT)' },
  { value: 'America/Chicago', label: 'America/Chicago (CST/CDT)' },
  { value: 'America/Denver', label: 'America/Denver (MST/MDT)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST/PDT)' },
  { value: 'America/Anchorage', label: 'America/Anchorage (AKST/AKDT)' },
  { value: 'Pacific/Honolulu', label: 'Pacific/Honolulu (HST)' },
  { value: 'America/Toronto', label: 'America/Toronto (EST/EDT)' },
  { value: 'America/Vancouver', label: 'America/Vancouver (PST/PDT)' },
  { value: 'America/Mexico_City', label: 'America/Mexico_City (CST)' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo (BRT)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'America/Buenos_Aires (ART)' },
  // Asia & Middle East
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (CST)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
  { value: 'Asia/Seoul', label: 'Asia/Seoul (KST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong (HKT)' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok (ICT)' },
  { value: 'Asia/Jakarta', label: 'Asia/Jakarta (WIB)' },
  { value: 'Asia/Tehran', label: 'Asia/Tehran (IRST/IRDT)' },
  { value: 'Asia/Karachi', label: 'Asia/Karachi (PKT)' },
  { value: 'Asia/Dhaka', label: 'Asia/Dhaka (BST)' },
  // Africa
  { value: 'Africa/Cairo', label: 'Africa/Cairo (EET/EEST)' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg (SAST)' },
  { value: 'Africa/Lagos', label: 'Africa/Lagos (WAT)' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi (EAT)' },
  // Oceania
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEST/AEDT)' },
  { value: 'Australia/Melbourne', label: 'Australia/Melbourne (AEST/AEDT)' },
  { value: 'Australia/Perth', label: 'Australia/Perth (AWST)' },
  { value: 'Australia/Adelaide', label: 'Australia/Adelaide (ACST/ACDT)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (NZST/NZDT)' },
  // UTC
  { value: 'UTC', label: 'UTC' },
];

export function SystemForm({
  title,
  initialName = '',
  initialDescription = '',
  initialRetentionDays = null,
  initialTzOffsetMinutes = null,
  initialTzName = null,
  initialEventSource = 'postgresql',
  initialEsConnectionId = null,
  initialEsConfig = null,
  onSave,
  onCancel,
  saving,
}: SystemFormProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [retentionMode, setRetentionMode] = useState<'global' | 'custom'>(
    initialRetentionDays !== null && initialRetentionDays !== undefined ? 'custom' : 'global',
  );
  const [retentionDays, setRetentionDays] = useState<string>(
    initialRetentionDays !== null && initialRetentionDays !== undefined ? String(initialRetentionDays) : '',
  );
  const [tzOffset, setTzOffset] = useState<string>(
    initialTzOffsetMinutes !== null && initialTzOffsetMinutes !== undefined ? String(initialTzOffsetMinutes) : '',
  );
  const [tzMode, setTzMode] = useState<'none' | 'iana' | 'offset'>(
    initialTzName ? 'iana' : (initialTzOffsetMinutes !== null && initialTzOffsetMinutes !== undefined ? 'offset' : 'none'),
  );
  const [tzName, setTzName] = useState<string>(initialTzName ?? '');
  const [nameError, setNameError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  // Event source state
  const [eventSource, setEventSource] = useState<'postgresql' | 'elasticsearch'>(initialEventSource);
  const [esConnectionId, setEsConnectionId] = useState<string | null>(initialEsConnectionId);
  const [indexPattern, setIndexPattern] = useState<string>((initialEsConfig as any)?.index_pattern ?? '');
  const [timestampField, setTimestampField] = useState<string>((initialEsConfig as any)?.timestamp_field ?? '@timestamp');
  const [messageField, setMessageField] = useState<string>((initialEsConfig as any)?.message_field ?? 'message');

  // ES connections list
  const [esConnections, setEsConnections] = useState<EsConnection[]>([]);
  const [esLoading, setEsLoading] = useState(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Load ES connections when Elasticsearch is selected
  useEffect(() => {
    if (eventSource !== 'elasticsearch') return;
    setEsLoading(true);
    fetchEsConnections()
      .then(setEsConnections)
      .catch(() => { /* ignore */ })
      .finally(() => setEsLoading(false));
  }, [eventSource]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('System name is required.');
      nameRef.current?.focus();
      return;
    }
    setNameError('');

    let finalRetention: number | null = null;
    if (retentionMode === 'custom') {
      const rd = Number(retentionDays);
      if (Number.isFinite(rd) && rd >= 0) {
        finalRetention = rd;
      }
    }

    let esConfig: Record<string, unknown> | null = null;
    if (eventSource === 'elasticsearch') {
      esConfig = {
        index_pattern: indexPattern.trim(),
        timestamp_field: timestampField.trim() || '@timestamp',
        message_field: messageField.trim() || 'message',
      };
    }

    let finalTzOffset: number | null = null;
    let finalTzName: string | null = null;
    if (tzMode === 'iana' && tzName) {
      finalTzName = tzName;
      finalTzOffset = null;
    } else if (tzMode === 'offset' && tzOffset !== '') {
      finalTzOffset = Number(tzOffset);
      if (!Number.isFinite(finalTzOffset)) finalTzOffset = null;
    }

    onSave({
      name: trimmed,
      description: description.trim(),
      retention_days: finalRetention,
      tz_offset_minutes: finalTzOffset,
      tz_name: finalTzName,
      event_source: eventSource,
      es_connection_id: eventSource === 'elasticsearch' ? esConnectionId : null,
      es_config: esConfig,
    });
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="system-name">Name *</label>
            <input
              ref={nameRef}
              id="system-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="e.g. Production Web Server"
              maxLength={255}
              aria-required="true"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? 'system-name-error' : undefined}
            />
            {nameError && <span id="system-name-error" className="field-error">{nameError}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="system-description">Description</label>
            <textarea
              id="system-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description of what this system is"
              rows={3}
            />
          </div>

          {/* ── Event Source ── */}
          <div className="form-group">
            <label>Event Source</label>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input
                  type="radio"
                  name="event-source"
                  checked={eventSource === 'postgresql'}
                  onChange={() => setEventSource('postgresql')}
                />
                PostgreSQL (local events)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input
                  type="radio"
                  name="event-source"
                  checked={eventSource === 'elasticsearch'}
                  onChange={() => setEventSource('elasticsearch')}
                />
                Elasticsearch (external)
              </label>
            </div>
            <span className="field-hint" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              {eventSource === 'postgresql'
                ? 'Events are received via the ingest API and stored in PostgreSQL.'
                : 'Events are read directly from an Elasticsearch cluster. AI analysis results are stored locally.'}
            </span>
          </div>

          {/* ── Elasticsearch Configuration ── */}
          {eventSource === 'elasticsearch' && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '0.75rem', marginBottom: '0.75rem' }}>
              <div className="form-group">
                <label htmlFor="es-connection">Elasticsearch Connection *</label>
                {esLoading ? (
                  <span className="text-sm">Loading connections...</span>
                ) : esConnections.length === 0 ? (
                  <span className="text-sm" style={{ color: 'var(--danger, #e74c3c)' }}>
                    No Elasticsearch connections configured. Add one in the Elasticsearch tab first.
                  </span>
                ) : (
                  <select
                    id="es-connection"
                    className="form-input"
                    value={esConnectionId ?? ''}
                    onChange={e => setEsConnectionId(e.target.value || null)}
                  >
                    <option value="">-- Select connection --</option>
                    {esConnections.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.url}) {c.is_default ? '[Default]' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="es-index-pattern">Index Pattern *</label>
                <input
                  id="es-index-pattern"
                  type="text"
                  className="form-input"
                  value={indexPattern}
                  onChange={e => setIndexPattern(e.target.value)}
                  placeholder="e.g. filebeat-*, logs-*"
                />
                <span className="field-hint" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block' }}>
                  Elasticsearch index pattern to query for this system's events.
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div className="form-group">
                  <label htmlFor="es-ts-field">Timestamp Field</label>
                  <input
                    id="es-ts-field"
                    type="text"
                    className="form-input"
                    value={timestampField}
                    onChange={e => setTimestampField(e.target.value)}
                    placeholder="@timestamp"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="es-msg-field">Message Field</label>
                  <input
                    id="es-msg-field"
                    type="text"
                    className="form-input"
                    value={messageField}
                    onChange={e => setMessageField(e.target.value)}
                    placeholder="message"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Data Retention</label>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input
                  type="radio"
                  name="retention-mode"
                  checked={retentionMode === 'global'}
                  onChange={() => setRetentionMode('global')}
                />
                Use global default
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input
                  type="radio"
                  name="retention-mode"
                  checked={retentionMode === 'custom'}
                  onChange={() => setRetentionMode('custom')}
                />
                Custom
              </label>
            </div>
            {retentionMode === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  placeholder="90"
                  style={{ width: '100px' }}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  days {retentionDays === '0' && '(keep forever)'}
                </span>
              </div>
            )}
            <span className="field-hint" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              {eventSource === 'elasticsearch'
                ? 'For Elasticsearch systems, this controls how long AI analysis metadata is retained locally.'
                : 'How long to keep events for this system. Set to 0 to keep forever.'}
            </span>
          </div>

          {/* ── Source Timezone ── */}
          <div className="form-group">
            <label>Source Timezone Correction</label>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input type="radio" name="tz-mode" checked={tzMode === 'none'} onChange={() => setTzMode('none')} />
                None
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input type="radio" name="tz-mode" checked={tzMode === 'iana'} onChange={() => setTzMode('iana')} />
                Timezone (DST-aware)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.88rem' }}>
                <input type="radio" name="tz-mode" checked={tzMode === 'offset'} onChange={() => setTzMode('offset')} />
                Fixed UTC offset
              </label>
            </div>

            {tzMode === 'iana' && (
              <select
                id="tz-name"
                className="form-input"
                value={tzName}
                onChange={(e) => setTzName(e.target.value)}
                style={{ maxWidth: '360px', marginTop: '8px' }}
              >
                {IANA_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            )}

            {tzMode === 'offset' && (
              <select
                id="tz-offset"
                className="form-input"
                value={tzOffset}
                onChange={(e) => setTzOffset(e.target.value)}
                style={{ maxWidth: '320px', marginTop: '8px' }}
              >
                {TZ_OFFSETS.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            )}

            <span className="field-hint" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              {tzMode === 'none'
                ? 'No timezone correction. Use when source timestamps already include timezone info (RFC 5424, ISO 8601).'
                : tzMode === 'iana'
                ? 'Select the source device\'s timezone. Automatically handles DST (summer/winter time) transitions.'
                : 'Fixed offset for sources without DST. Does NOT adjust for summer/winter time changes.'}
            </span>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving || !name.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
