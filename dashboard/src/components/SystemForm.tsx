import { useState, useRef, useEffect } from 'react';

interface SystemFormProps {
  title: string;
  initialName?: string;
  initialDescription?: string;
  initialRetentionDays?: number | null;
  onSave: (name: string, description: string, retentionDays: number | null) => void;
  onCancel: () => void;
  saving: boolean;
}

export function SystemForm({
  title,
  initialName = '',
  initialDescription = '',
  initialRetentionDays = null,
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
  const [nameError, setNameError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

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

    onSave(trimmed, description.trim(), finalRetention);
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
              How long to keep events for this system. Set to 0 to keep forever.
            </span>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
