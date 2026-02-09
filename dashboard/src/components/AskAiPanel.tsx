import { useState, useRef, useEffect, useCallback } from 'react';
import {
  type DashboardSystem,
  type RagHistoryEntry,
  askAi,
  fetchRagHistory,
  clearRagHistory,
} from '../api';
import { EuDateInput, euToIso } from './EuDateInput';

// ── EU date format helper (with seconds, for display) ────────

function formatEuDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
  } catch {
    return iso;
  }
}

// ── Props ────────────────────────────────────────────────────

interface AskAiPanelProps {
  /** If set, the panel is scoped to this single system (DrillDown mode). */
  fixedSystemId?: string;
  fixedSystemName?: string;
  /** Available systems for the multi-system selector (Dashboard mode). */
  systems?: DashboardSystem[];
  /** Called on 401 / auth failure. */
  onAuthError: () => void;
}

// ── Component ────────────────────────────────────────────────

export function AskAiPanel({
  fixedSystemId,
  fixedSystemName,
  systems,
  onAuthError,
}: AskAiPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState('');
  const [systemId, setSystemId] = useState(fixedSystemId ?? '');
  const [periodMode, setPeriodMode] = useState<'all' | 'custom'>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<RagHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyLoaded = useRef(false);

  // Load persisted history when the panel first expands
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const opts: { system_id?: string; limit?: number } = { limit: 100 };
      if (fixedSystemId) opts.system_id = fixedSystemId;
      const rows = await fetchRagHistory(opts);
      setHistory(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      // silently ignore — user will see empty history
    } finally {
      setHistoryLoading(false);
    }
  }, [fixedSystemId, onAuthError]);

  useEffect(() => {
    if (expanded && !historyLoaded.current) {
      historyLoaded.current = true;
      loadHistory();
    }
  }, [expanded, loadHistory]);

  // Focus input when panel opens
  useEffect(() => {
    if (expanded) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [expanded]);

  const handleAsk = async () => {
    const q = question.trim();
    if (!q) return;

    setLoading(true);
    setError('');

    try {
      const params: { question: string; system_id?: string; from?: string; to?: string } = {
        question: q,
      };

      // System scope
      const effectiveSystemId = fixedSystemId ?? systemId;
      if (effectiveSystemId) params.system_id = effectiveSystemId;

      // Time range
      if (periodMode === 'custom') {
        const isoFrom = euToIso(fromDate);
        const isoTo = euToIso(toDate);
        if (isoFrom) params.from = isoFrom;
        if (isoTo) params.to = isoTo;
      }

      const res = await askAi(params);

      // Build a synthetic RagHistoryEntry for immediate display
      // (the backend already saved it; we prepend to avoid a full reload)
      let sysName: string | null = null;
      if (fixedSystemId && fixedSystemName) {
        sysName = fixedSystemName;
      } else if (effectiveSystemId && systems) {
        const s = systems.find((sys) => sys.id === effectiveSystemId);
        sysName = s ? s.name : null;
      }

      const entry: RagHistoryEntry = {
        id: crypto.randomUUID?.() ?? String(Date.now()),
        question: q,
        answer: res.answer,
        system_id: effectiveSystemId || null,
        system_name: sysName,
        from_filter: params.from ?? null,
        to_filter: params.to ?? null,
        context_used: res.context_used,
        created_at: new Date().toISOString(),
      };

      setHistory((prev) => [entry, ...prev]);
      setQuestion('');
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
  };

  const handleClearHistory = async () => {
    const scope = fixedSystemId ? `for "${fixedSystemName}"` : '(all systems)';
    if (!window.confirm(`Clear all Ask AI history ${scope}?`)) return;

    setClearing(true);
    try {
      await clearRagHistory(fixedSystemId);
      setHistory([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setClearing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAsk();
    }
  };

  /** Build a human-readable period label for a history entry. */
  const periodLabel = (h: RagHistoryEntry): string => {
    if (!h.from_filter && !h.to_filter) return 'All time';
    const from = h.from_filter ? formatEuDate(h.from_filter) : 'beginning';
    const to = h.to_filter ? formatEuDate(h.to_filter) : 'now';
    return `${from} — ${to}`;
  };

  return (
    <div className="ask-ai-panel">
      <button
        className="ask-ai-toggle"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        <span className="ask-ai-icon">&#x1F916;</span>
        {' '}
        Ask AI
        {history.length > 0 && !expanded && (
          <span className="ask-ai-count">{history.length}</span>
        )}
        <span className="ask-ai-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {expanded && (
        <div className="ask-ai-body">
          <div className="ask-ai-hint">
            Ask a natural-language question about your logs and the AI will answer based on meta-analysis context.
            {fixedSystemName
              ? <> Scoped to <strong>{fixedSystemName}</strong>.</>
              : ' You can optionally narrow by system and time range.'
            }
          </div>

          {/* ── Filters row ── */}
          <div className="ask-ai-filters">
            {!fixedSystemId && systems && systems.length > 0 && (
              <div className="ask-ai-filter-group">
                <label>System</label>
                <select value={systemId} onChange={(e) => setSystemId(e.target.value)}>
                  <option value="">All systems</option>
                  {systems.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="ask-ai-filter-group">
              <label>Period</label>
              <select
                value={periodMode}
                onChange={(e) => setPeriodMode(e.target.value as 'all' | 'custom')}
              >
                <option value="all">All time</option>
                <option value="custom">Custom range</option>
              </select>
            </div>
            {periodMode === 'custom' && (
              <>
                <div className="ask-ai-filter-group">
                  <label>From</label>
                  <EuDateInput value={fromDate} onChange={setFromDate} />
                </div>
                <div className="ask-ai-filter-group">
                  <label>To</label>
                  <EuDateInput value={toDate} onChange={setToDate} />
                </div>
              </>
            )}
          </div>

          {/* ── Question input ── */}
          <div className="ask-ai-input-row">
            <textarea
              ref={inputRef}
              className="ask-ai-textarea"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. What were the main issues in the last 24 hours?"
              rows={2}
              maxLength={500}
              disabled={loading}
            />
            <button
              className="btn btn-accent ask-ai-submit"
              onClick={handleAsk}
              disabled={loading || !question.trim()}
            >
              {loading ? 'Thinking...' : 'Ask'}
            </button>
          </div>
          <div className="ask-ai-shortcut-hint">Ctrl+Enter to submit</div>

          {error && <div className="error-msg" role="alert">{error}</div>}

          {/* ── History header with clear button ── */}
          {history.length > 0 && (
            <div className="ask-ai-history-header">
              <span className="ask-ai-history-title">
                Chat History ({history.length})
              </span>
              <button
                className="btn btn-xs btn-outline"
                onClick={handleClearHistory}
                disabled={clearing}
                title="Clear all chat history"
              >
                {clearing ? '...' : 'Clear History'}
              </button>
            </div>
          )}

          {historyLoading && (
            <div className="ask-ai-history-loading">Loading history...</div>
          )}

          {/* ── Answer history ── */}
          {history.length > 0 && (
            <div className="ask-ai-history">
              {history.map((h) => (
                <div key={h.id} className="ask-ai-entry">
                  <div className="ask-ai-entry-header">
                    <span className="ask-ai-entry-q">Q: {h.question}</span>
                    <span className="ask-ai-entry-meta">
                      {h.system_name ?? 'All systems'}
                      {' · '}
                      {periodLabel(h)}
                      {' · '}
                      {h.context_used} context window{h.context_used !== 1 ? 's' : ''}
                      {' · '}
                      {formatEuDate(h.created_at)}
                    </span>
                  </div>
                  <div className="ask-ai-entry-answer">{h.answer}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
