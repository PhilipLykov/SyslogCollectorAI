import { useEffect, useState, useCallback } from 'react';
import { NumericInput } from './NumericInput';
import {
  type PrivacyFilterConfig,
  type PrivacyConfigResponse,
  type CustomFilterPattern,
  type MonitoredSystem,
  type FilterTestResult,
  type BulkDeleteResult,
  fetchPrivacyConfig,
  updatePrivacyConfig,
  testPrivacyFilter,
  fetchSystems,
  bulkDeleteEvents,
  purgeRagHistory,
  purgeLlmUsage,
} from '../api';

interface PrivacySectionProps {
  onAuthError: () => void;
}

/** Format date for EU display */
function toEuInput(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

/** Parse DD-MM-YYYY HH:MM to ISO string. Returns null if invalid. */
function parseEuToIso(s: string): string | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh ?? 0), Number(min ?? 0));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

const FILTER_CATEGORIES: Array<{
  key: keyof PrivacyFilterConfig;
  label: string;
  description: string;
  example: string;
}> = [
  { key: 'filter_ipv4', label: 'IPv4 Addresses', description: 'Replace IPv4 addresses with <IPv4>', example: '192.168.1.100 → <IPv4>' },
  { key: 'filter_ipv6', label: 'IPv6 Addresses', description: 'Replace IPv6 addresses with <IPv6>', example: 'fe80::1 → <IPv6>' },
  { key: 'filter_email', label: 'Email Addresses', description: 'Replace email addresses with <EMAIL>', example: 'user@example.com → <EMAIL>' },
  { key: 'filter_phone', label: 'Phone Numbers', description: 'Replace phone numbers with <PHONE>', example: '+1-555-123-4567 → <PHONE>' },
  { key: 'filter_urls', label: 'URLs', description: 'Replace http/https URLs with <URL>', example: 'https://api.example.com/v1 → <URL>' },
  { key: 'filter_user_paths', label: 'User Paths', description: 'Replace /home/user or C:\\Users\\user paths', example: '/home/admin/.ssh → <USER_PATH>' },
  { key: 'filter_mac_addresses', label: 'MAC Addresses', description: 'Replace MAC addresses with <MAC>', example: 'aa:bb:cc:dd:ee:ff → <MAC>' },
  { key: 'filter_credit_cards', label: 'Credit Card Numbers', description: 'Replace card-like number sequences', example: '4111-1111-1111-1111 → <CARD>' },
  { key: 'filter_passwords', label: 'Passwords / Secrets', description: 'Replace password, secret, passwd, pwd values', example: 'password=MyS3cret → password=<PASSWORD>' },
  { key: 'filter_api_keys', label: 'API Keys / Tokens', description: 'Replace api_key, access_key, bearer token values', example: 'api_key=sk-abc123 → api_key=<API_KEY>' },
  { key: 'filter_usernames', label: 'Usernames / Logins', description: 'Replace user, username, login, uid values', example: 'user=admin → user=<USERNAME>' },
];

export function PrivacySection({ onAuthError }: PrivacySectionProps) {
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<PrivacyConfigResponse | null>(null);
  const [cfg, setCfg] = useState<PrivacyFilterConfig | null>(null);
  const [systems, setSystems] = useState<MonitoredSystem[]>([]);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');

  // Custom patterns editor
  const [customPatterns, setCustomPatterns] = useState<CustomFilterPattern[]>([]);

  // Test filter
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<FilterTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Bulk delete
  const [deleteFrom, setDeleteFrom] = useState('');
  const [deleteTo, setDeleteTo] = useState('');
  const [deleteSystemId, setDeleteSystemId] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<BulkDeleteResult | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // Purge state
  const [purgingRag, setPurgingRag] = useState(false);
  const [purgingLlm, setPurgingLlm] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState('');
  const [purgeConfirm, setPurgeConfirm] = useState('');

  // Collapsible sections
  const [showFilters, setShowFilters] = useState(true);
  const [showFieldStripping, setShowFieldStripping] = useState(false);
  const [showCustomPatterns, setShowCustomPatterns] = useState(false);
  const [showTestFilter, setShowTestFilter] = useState(false);
  const [showDataPrivacy, setShowDataPrivacy] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showPurge, setShowPurge] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [privResp, sysList] = await Promise.all([
        fetchPrivacyConfig(),
        fetchSystems(),
      ]);
      setConfigData(privResp);
      setCfg(privResp.config);
      setCustomPatterns(privResp.config.custom_patterns ?? []);
      setSystems(sysList);

      // Default delete period: start of current year → now
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      setDeleteFrom(toEuInput(yearStart));
      setDeleteTo(toEuInput(now));
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

  // ── Handlers ──────────────────────────────────────────────

  const handleToggle = (key: keyof PrivacyFilterConfig) => {
    if (!cfg) return;
    setCfg({ ...cfg, [key]: !(cfg as any)[key] });
  };

  const handleSave = async () => {
    if (!cfg) return;
    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    try {
      const toSave = { ...cfg, custom_patterns: customPatterns };
      const resp = await updatePrivacyConfig(toSave);
      setConfigData(resp);
      setCfg(resp.config);
      setCustomPatterns(resp.config.custom_patterns ?? []);
      setSaveMsg('Privacy settings saved.');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!configData) return;
    setCfg({ ...configData.defaults });
    setCustomPatterns([]);
  };

  const handleTestFilter = async () => {
    if (!testInput.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testPrivacyFilter(testInput);
      setTestResult(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Test failed: ${msg}`);
    } finally {
      setTesting(false);
    }
  };

  const handleAddPattern = () => {
    setCustomPatterns([...customPatterns, { pattern: '', replacement: '<FILTERED>' }]);
  };

  const handleRemovePattern = (index: number) => {
    setCustomPatterns(customPatterns.filter((_, i) => i !== index));
  };

  const handlePatternChange = (index: number, field: 'pattern' | 'replacement', value: string) => {
    const updated = [...customPatterns];
    updated[index] = { ...updated[index], [field]: value };
    setCustomPatterns(updated);
  };

  const handleBulkDelete = async () => {
    if (deleteConfirmation !== 'YES') {
      setDeleteError('You must type "YES" in the confirmation field to proceed.');
      return;
    }

    const fromIso = deleteFrom ? parseEuToIso(deleteFrom) : undefined;
    const toIso = deleteTo ? parseEuToIso(deleteTo) : undefined;

    if (deleteFrom && !fromIso) {
      setDeleteError('Invalid "From" date format. Use DD-MM-YYYY HH:MM.');
      return;
    }
    if (deleteTo && !toIso) {
      setDeleteError('Invalid "To" date format. Use DD-MM-YYYY HH:MM.');
      return;
    }

    setDeleting(true);
    setDeleteError('');
    setDeleteResult(null);
    try {
      const result = await bulkDeleteEvents({
        confirmation: 'YES',
        from: fromIso ?? undefined,
        to: toIso ?? undefined,
        system_id: deleteSystemId || undefined,
      });
      setDeleteResult(result);
      setDeleteConfirmation('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeleteError(msg);
    } finally {
      setDeleting(false);
    }
  };

  const handlePurgeRag = async () => {
    if (purgeConfirm !== 'YES') {
      setPurgeMsg('Type "YES" to confirm.');
      return;
    }
    setPurgingRag(true);
    setPurgeMsg('');
    try {
      const result = await purgeRagHistory('YES');
      setPurgeMsg(result.message);
      setPurgeConfirm('');
    } catch (err: unknown) {
      setPurgeMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPurgingRag(false);
    }
  };

  const handlePurgeLlm = async () => {
    if (purgeConfirm !== 'YES') {
      setPurgeMsg('Type "YES" to confirm.');
      return;
    }
    setPurgingLlm(true);
    setPurgeMsg('');
    try {
      const result = await purgeLlmUsage('YES');
      setPurgeMsg(result.message);
      setPurgeConfirm('');
    } catch (err: unknown) {
      setPurgeMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPurgingLlm(false);
    }
  };

  // ── Render ────────────────────────────────────────────────

  if (loading || !cfg) {
    return (
      <div className="settings-loading">
        <div className="spinner" />
        Loading privacy settings…
      </div>
    );
  }

  return (
    <div className="privacy-section">
      <h3 className="section-title">Privacy &amp; Data Protection</h3>
      <p className="section-desc">
        Configure what data is sent to the LLM, manage PII filtering, and perform data deletion operations.
      </p>

      {/* ═══════ LLM Privacy Filtering ═══════ */}
      <div className="privacy-block">
        <div className="privacy-master-toggle">
          <label className="privacy-toggle-label">
            <input
              type="checkbox"
              checked={cfg.llm_filter_enabled}
              onChange={() => handleToggle('llm_filter_enabled')}
            />
            <strong>Enable LLM Privacy Filter</strong>
          </label>
          <span className="field-hint">
            When enabled, PII patterns are replaced with placeholders before events are sent to the AI model.
            Original data remains stored in your database unchanged.
          </span>
        </div>
      </div>

      {/* ── Filter Categories ── */}
      <div className="privacy-block">
        <button type="button" className="prompt-toggle" onClick={() => setShowFilters((v) => !v)}>
          <span className={`prompt-chevron${showFilters ? ' open' : ''}`}>&#9654;</span>
          PII Filter Categories
          {cfg.llm_filter_enabled && (
            <span className="prompt-custom-badge">
              {FILTER_CATEGORIES.filter((c) => (cfg as any)[c.key]).length} / {FILTER_CATEGORIES.length} active
            </span>
          )}
        </button>

        {showFilters && (
          <div className="privacy-filters-grid">
            {FILTER_CATEGORIES.map((cat) => (
              <label key={cat.key} className="privacy-filter-item" title={cat.example}>
                <input
                  type="checkbox"
                  checked={(cfg as any)[cat.key] as boolean}
                  onChange={() => handleToggle(cat.key)}
                  disabled={!cfg.llm_filter_enabled}
                />
                <div className="privacy-filter-info">
                  <span className="privacy-filter-name">{cat.label}</span>
                  <span className="privacy-filter-desc">{cat.description}</span>
                  <code className="privacy-filter-example">{cat.example}</code>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── Field Stripping ── */}
      <div className="privacy-block">
        <button type="button" className="prompt-toggle" onClick={() => setShowFieldStripping((v) => !v)}>
          <span className={`prompt-chevron${showFieldStripping ? ' open' : ''}`}>&#9654;</span>
          Field Stripping
        </button>

        {showFieldStripping && (
          <div className="privacy-field-strip">
            <p className="field-hint" style={{ marginBottom: '10px' }}>
              Remove specific metadata fields from events before sending to the LLM.
              This prevents the AI model from seeing hostnames or program names.
            </p>
            <label className="privacy-toggle-label">
              <input
                type="checkbox"
                checked={cfg.strip_host_field}
                onChange={() => handleToggle('strip_host_field')}
                disabled={!cfg.llm_filter_enabled}
              />
              Strip <code>host</code> field (hostname/IP of the source machine)
            </label>
            <label className="privacy-toggle-label" style={{ marginTop: '8px' }}>
              <input
                type="checkbox"
                checked={cfg.strip_program_field}
                onChange={() => handleToggle('strip_program_field')}
                disabled={!cfg.llm_filter_enabled}
              />
              Strip <code>program</code> field (application/process name)
            </label>
          </div>
        )}
      </div>

      {/* ── Custom Patterns ── */}
      <div className="privacy-block">
        <button type="button" className="prompt-toggle" onClick={() => setShowCustomPatterns((v) => !v)}>
          <span className={`prompt-chevron${showCustomPatterns ? ' open' : ''}`}>&#9654;</span>
          Custom Filter Patterns
          {customPatterns.length > 0 && (
            <span className="prompt-custom-badge">{customPatterns.length} pattern(s)</span>
          )}
        </button>

        {showCustomPatterns && (
          <div className="privacy-custom-patterns">
            <p className="field-hint" style={{ marginBottom: '10px' }}>
              Add your own regex patterns to filter specific data. Each pattern is applied globally (case-insensitive).
            </p>
            {customPatterns.map((cp, idx) => (
              <div key={idx} className="privacy-pattern-row">
                <input
                  type="text"
                  value={cp.pattern}
                  onChange={(e) => handlePatternChange(idx, 'pattern', e.target.value)}
                  placeholder="Regex pattern, e.g. ACCT-\d{6,}"
                  className="privacy-pattern-input"
                  disabled={!cfg.llm_filter_enabled}
                />
                <input
                  type="text"
                  value={cp.replacement}
                  onChange={(e) => handlePatternChange(idx, 'replacement', e.target.value)}
                  placeholder="<FILTERED>"
                  className="privacy-pattern-replacement"
                  disabled={!cfg.llm_filter_enabled}
                />
                <button
                  type="button"
                  className="btn btn-xs btn-danger-outline"
                  onClick={() => handleRemovePattern(idx)}
                  title="Remove pattern"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={handleAddPattern}
              disabled={!cfg.llm_filter_enabled}
              style={{ marginTop: '8px' }}
            >
              + Add Pattern
            </button>
          </div>
        )}
      </div>

      {/* ── Test Filter ── */}
      <div className="privacy-block">
        <button type="button" className="prompt-toggle" onClick={() => setShowTestFilter((v) => !v)}>
          <span className={`prompt-chevron${showTestFilter ? ' open' : ''}`}>&#9654;</span>
          Test Filter
        </button>

        {showTestFilter && (
          <div className="privacy-test-section">
            <p className="field-hint" style={{ marginBottom: '8px' }}>
              Paste a sample log message to see how the current filter settings would process it.
              Save your settings first to test the latest configuration.
            </p>
            <textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder="Paste a sample log message here, e.g.: Failed login from 192.168.1.100 for user admin@example.com"
              rows={3}
              className="privacy-test-input"
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleTestFilter}
              disabled={testing || !testInput.trim()}
              style={{ marginTop: '6px' }}
            >
              {testing ? 'Testing…' : 'Test Filter'}
            </button>
            {testResult && (
              <div className="privacy-test-result">
                <div className="privacy-test-label">Original:</div>
                <code className="privacy-test-text">{testResult.original}</code>
                <div className="privacy-test-label" style={{ marginTop: '8px' }}>Filtered:</div>
                <code className={`privacy-test-text ${testResult.changes_made ? 'privacy-test-changed' : ''}`}>
                  {testResult.filtered}
                </code>
                {!testResult.filter_enabled && (
                  <div className="privacy-test-warn">
                    Filter is currently disabled. Enable it and save to activate filtering.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Save / Reset ── */}
      <div className="privacy-actions">
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Privacy Settings'}
        </button>
        <button className="btn btn-outline" onClick={handleReset} disabled={saving}>
          Reset to Defaults
        </button>
      </div>
      {saveMsg && <div className="success-msg">{saveMsg}</div>}
      {saveError && <div className="error-msg" role="alert">{saveError}</div>}

      {/* ═══════ Data Privacy Settings ═══════ */}
      <div className="privacy-block" style={{ marginTop: '24px' }}>
        <button type="button" className="prompt-toggle" onClick={() => setShowDataPrivacy((v) => !v)}>
          <span className={`prompt-chevron${showDataPrivacy ? ' open' : ''}`}>&#9654;</span>
          Data Privacy Settings
        </button>

        {showDataPrivacy && (
          <div className="privacy-data-settings">
            <div className="form-group">
              <label className="privacy-toggle-label">
                <input
                  type="checkbox"
                  checked={cfg.log_llm_requests}
                  onChange={() => handleToggle('log_llm_requests')}
                />
                <strong>Log LLM requests to usage history</strong>
              </label>
              <span className="field-hint">
                When enabled, token usage and cost are tracked per LLM request.
                Disable to reduce stored metadata about AI interactions.
              </span>
            </div>
            <div className="form-group" style={{ marginTop: '12px' }}>
              <label htmlFor="rag-retention">RAG History Auto-Cleanup (days)</label>
              <NumericInput
                min={0}
                max={3650}
                value={cfg.rag_history_retention_days}
                onChange={(v) => setCfg({ ...cfg, rag_history_retention_days: v })}
                style={{ width: '120px' }}
              />
              <span className="field-hint">
                Automatically delete RAG (Ask AI) chat history older than this many days. Set to 0 to keep forever.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ═══════ Bulk Event Deletion ═══════ */}
      <div className="privacy-block privacy-danger-zone" style={{ marginTop: '24px' }}>
        <button type="button" className="prompt-toggle" onClick={() => setShowBulkDelete((v) => !v)}>
          <span className={`prompt-chevron${showBulkDelete ? ' open' : ''}`}>&#9654;</span>
          <span style={{ color: 'var(--danger)' }}>Delete Stored Events</span>
        </button>

        {showBulkDelete && (
          <div className="privacy-bulk-delete">
            <div className="privacy-danger-warning">
              <strong>WARNING:</strong> This action permanently deletes events and their associated scores
              from the database. This cannot be undone. Use with extreme caution.
            </div>

            <div className="privacy-delete-filters">
              <div className="form-group">
                <label>From (DD-MM-YYYY HH:MM)</label>
                <input
                  type="text"
                  value={deleteFrom}
                  onChange={(e) => setDeleteFrom(e.target.value)}
                  placeholder="DD-MM-YYYY HH:MM"
                  style={{ width: '200px' }}
                />
              </div>
              <div className="form-group">
                <label>To (DD-MM-YYYY HH:MM)</label>
                <input
                  type="text"
                  value={deleteTo}
                  onChange={(e) => setDeleteTo(e.target.value)}
                  placeholder="DD-MM-YYYY HH:MM"
                  style={{ width: '200px' }}
                />
              </div>
              <div className="form-group">
                <label>System (optional)</label>
                <select
                  value={deleteSystemId}
                  onChange={(e) => setDeleteSystemId(e.target.value)}
                  style={{ width: '220px' }}
                >
                  <option value="">All systems</option>
                  {systems.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="privacy-confirm-field">
              <label htmlFor="delete-confirm">
                Type <strong>YES</strong> to confirm deletion:
              </label>
              <input
                id="delete-confirm"
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder="Type YES"
                style={{ width: '120px', fontWeight: 'bold', textAlign: 'center' }}
                autoComplete="off"
              />
            </div>

            <button
              className="btn btn-danger"
              onClick={handleBulkDelete}
              disabled={deleting || deleteConfirmation !== 'YES'}
              style={{ marginTop: '12px' }}
            >
              {deleting ? 'Deleting…' : 'Delete Events Permanently'}
            </button>

            {deleteError && <div className="error-msg" style={{ marginTop: '8px' }}>{deleteError}</div>}
            {deleteResult && (
              <div className={`privacy-delete-result ${deleteResult.deleted_events > 0 ? 'privacy-delete-result-success' : ''}`}>
                {deleteResult.message}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══════ Purge Data ═══════ */}
      <div className="privacy-block privacy-danger-zone" style={{ marginTop: '16px' }}>
        <button type="button" className="prompt-toggle" onClick={() => setShowPurge((v) => !v)}>
          <span className={`prompt-chevron${showPurge ? ' open' : ''}`}>&#9654;</span>
          <span style={{ color: 'var(--danger)' }}>Purge AI Data</span>
        </button>

        {showPurge && (
          <div className="privacy-purge-section">
            <div className="privacy-danger-warning">
              <strong>WARNING:</strong> These actions permanently delete all RAG chat history
              or LLM usage logs. Type <strong>YES</strong> to enable the purge buttons.
            </div>

            <div className="privacy-confirm-field">
              <label htmlFor="purge-confirm">
                Type <strong>YES</strong> to enable purge:
              </label>
              <input
                id="purge-confirm"
                type="text"
                value={purgeConfirm}
                onChange={(e) => setPurgeConfirm(e.target.value)}
                placeholder="Type YES"
                style={{ width: '120px', fontWeight: 'bold', textAlign: 'center' }}
                autoComplete="off"
              />
            </div>

            <div className="privacy-purge-actions">
              <button
                className="btn btn-danger"
                onClick={handlePurgeRag}
                disabled={purgingRag || purgeConfirm !== 'YES'}
              >
                {purgingRag ? 'Purging…' : 'Purge All RAG History'}
              </button>
              <button
                className="btn btn-danger"
                onClick={handlePurgeLlm}
                disabled={purgingLlm || purgeConfirm !== 'YES'}
              >
                {purgingLlm ? 'Purging…' : 'Purge All LLM Usage Logs'}
              </button>
            </div>

            {purgeMsg && (
              <div className="privacy-delete-result" style={{ marginTop: '8px' }}>
                {purgeMsg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
