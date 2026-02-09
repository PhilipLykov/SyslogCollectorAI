import { useState, useRef, useEffect } from 'react';

interface SourceFormProps {
  title: string;
  initialLabel?: string;
  initialSelector?: Record<string, string>;
  initialPriority?: number;
  onSave: (label: string, selector: Record<string, string>, priority: number) => void;
  onCancel: () => void;
  saving: boolean;
}

/** Known event fields that can be used in selectors. */
const SELECTOR_FIELDS = ['host', 'source_ip', 'service', 'program', 'facility', 'severity'] as const;

interface SelectorRow {
  field: string;
  pattern: string;
}

function selectorToRows(selector: Record<string, string>): SelectorRow[] {
  const rows = Object.entries(selector).map(([field, pattern]) => ({ field, pattern }));
  return rows.length > 0 ? rows : [{ field: 'host', pattern: '' }];
}

function rowsToSelector(rows: SelectorRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const field = row.field.trim();
    const pattern = row.pattern.trim();
    if (field && pattern) {
      result[field] = pattern;
    }
  }
  return result;
}

export function SourceForm({
  title,
  initialLabel = '',
  initialSelector,
  initialPriority = 0,
  onSave,
  onCancel,
  saving,
}: SourceFormProps) {
  const [label, setLabel] = useState(initialLabel);
  const [rows, setRows] = useState<SelectorRow[]>(
    selectorToRows(initialSelector ?? {}),
  );
  const [priority, setPriority] = useState(String(initialPriority));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const updateRow = (index: number, field: Partial<SelectorRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...field } : r)));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { field: 'host', pattern: '' }]);
  };

  const removeRow = (index: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!label.trim()) errs.label = 'Label is required.';

    const selector = rowsToSelector(rows);
    if (Object.keys(selector).length === 0) {
      errs.selector = 'At least one selector rule with a non-empty pattern is required.';
    }

    // Validate regex patterns
    for (let i = 0; i < rows.length; i++) {
      const pattern = rows[i].pattern.trim();
      if (pattern) {
        try {
          new RegExp(pattern);
        } catch {
          errs[`pattern-${i}`] = 'Invalid regex pattern.';
        }
      }
    }

    const parsedPriority = Number(priority);
    if (!Number.isFinite(parsedPriority) || parsedPriority < 0) {
      errs.priority = 'Priority must be a non-negative number.';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const selector = rowsToSelector(rows);
    onSave(label.trim(), selector, Number(priority));
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <form onSubmit={handleSubmit}>
          {/* Label */}
          <div className="form-group">
            <label htmlFor="source-label">Label *</label>
            <input
              ref={labelRef}
              id="source-label"
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (errors.label) setErrors((prev) => ({ ...prev, label: '' }));
              }}
              placeholder="e.g. Nginx logs, All syslog, Auth events"
              maxLength={255}
              aria-required="true"
              aria-invalid={!!errors.label}
            />
            {errors.label && <span className="field-error">{errors.label}</span>}
          </div>

          {/* Selector rules */}
          <div className="form-group">
            <label>Selector Rules *</label>
            <div className="selector-editor" role="group" aria-label="Selector rules">
              {rows.map((row, i) => (
                <div key={i} className="selector-row">
                  <select
                    value={row.field}
                    onChange={(e) => updateRow(i, { field: e.target.value })}
                    aria-label={`Field for rule ${i + 1}`}
                    className="selector-field"
                  >
                    {SELECTOR_FIELDS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <span className="selector-operator">matches</span>
                  <input
                    type="text"
                    value={row.pattern}
                    onChange={(e) => {
                      updateRow(i, { pattern: e.target.value });
                      if (errors[`pattern-${i}`]) {
                        setErrors((prev) => ({ ...prev, [`pattern-${i}`]: '' }));
                      }
                    }}
                    placeholder="regex pattern (e.g. .* or ^web-\\d+)"
                    className={`selector-pattern${errors[`pattern-${i}`] ? ' input-error' : ''}`}
                    aria-label={`Pattern for rule ${i + 1}`}
                    aria-invalid={!!errors[`pattern-${i}`]}
                  />
                  <button
                    type="button"
                    className="btn btn-xs btn-icon btn-outline"
                    onClick={() => removeRow(i)}
                    disabled={rows.length <= 1}
                    aria-label={`Remove rule ${i + 1}`}
                    title="Remove rule"
                  >
                    &times;
                  </button>
                  {errors[`pattern-${i}`] && (
                    <span className="field-error selector-row-error">{errors[`pattern-${i}`]}</span>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-xs btn-outline selector-add-btn" onClick={addRow}>
                + Add rule
              </button>
            </div>
            {errors.selector && <span className="field-error">{errors.selector}</span>}
          </div>

          {/* Priority */}
          <div className="form-group">
            <label htmlFor="source-priority">Priority</label>
            <input
              id="source-priority"
              type="number"
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                if (errors.priority) setErrors((prev) => ({ ...prev, priority: '' }));
              }}
              min={0}
              step={1}
              className="input-short"
              aria-describedby="priority-help"
              aria-invalid={!!errors.priority}
            />
            <span id="priority-help" className="field-hint">
              Lower priority = evaluated first. Use 0 for specific rules, 100 for catch-all rules.
            </span>
            {errors.priority && <span className="field-error">{errors.priority}</span>}
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
