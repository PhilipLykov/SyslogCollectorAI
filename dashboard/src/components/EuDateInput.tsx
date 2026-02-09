/**
 * EU date/time input component.
 *
 * Displays and accepts dates in DD-MM-YYYY HH:MM format.
 * Stores and exposes the value in that same EU format.
 *
 * Use `euToIso()` to convert to ISO before sending to the API.
 * Use `isoToEu()` / `nowEu()` / `todayStartEu()` / `todayEndEu()` / `yearStartEu()`
 * to produce default values.
 */

// ── Conversion helpers (exported for use elsewhere) ──────────

/** Convert EU string "DD-MM-YYYY HH:MM" → ISO string, or '' if invalid. */
export function euToIso(eu: string): string {
  if (!eu || eu.trim().length === 0) return '';
  const m = eu.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return '';
  const [, dd, mm, yyyy, hh, min] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Convert ISO / any parseable date string → EU "DD-MM-YYYY HH:MM", or '' if invalid. */
export function isoToEu(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

/** Current local time in EU format. */
export function nowEu(): string {
  return isoToEu(new Date().toISOString());
}

/** Today 00:00 in EU format. */
export function todayStartEu(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return isoToEu(d.toISOString());
}

/** Today 23:59 in EU format. */
export function todayEndEu(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return isoToEu(d.toISOString());
}

/** 1 Jan of current year 00:00 in EU format. */
export function yearStartEu(): string {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return isoToEu(d.toISOString());
}

// ── Component ────────────────────────────────────────────────

interface EuDateInputProps {
  value: string;                              // EU format "DD-MM-YYYY HH:MM"
  onChange: (eu: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function EuDateInput({
  value,
  onChange,
  placeholder = 'DD-MM-YYYY HH:MM',
  disabled,
  className,
}: EuDateInputProps) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      pattern="\d{2}-\d{2}-\d{4} \d{2}:\d{2}"
      title="Date format: DD-MM-YYYY HH:MM"
      disabled={disabled}
      className={className}
      style={{ minWidth: 160 }}
    />
  );
}
