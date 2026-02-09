import { useState, useRef, useEffect } from 'react';
import { type DashboardSystem, askAi } from '../api';

// ── EU date format helper ────────────────────────────────────

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
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
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

interface HistoryEntry {
  question: string;
  answer: string;
  contextUsed: number;
  systemLabel: string;
  periodLabel: string;
  timestamp: string;
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
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
        if (fromDate) params.from = new Date(fromDate).toISOString();
        if (toDate) params.to = new Date(toDate).toISOString();
      }

      const res = await askAi(params);

      // Build labels for history
      let systemLabel = 'All systems';
      if (fixedSystemId && fixedSystemName) {
        systemLabel = fixedSystemName;
      } else if (effectiveSystemId && systems) {
        const s = systems.find((sys) => sys.id === effectiveSystemId);
        systemLabel = s ? s.name : effectiveSystemId;
      }

      let periodLabel = 'All time';
      if (periodMode === 'custom') {
        const fmtFrom = fromDate ? formatEuDate(new Date(fromDate).toISOString()) : 'beginning';
        const fmtTo = toDate ? formatEuDate(new Date(toDate).toISOString()) : 'now';
        periodLabel = `${fmtFrom} — ${fmtTo}`;
      }

      const entry: HistoryEntry = {
        question: q,
        answer: res.answer,
        contextUsed: res.context_used,
        systemLabel,
        periodLabel,
        timestamp: new Date().toISOString(),
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAsk();
    }
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
                  <input
                    type="datetime-local"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </div>
                <div className="ask-ai-filter-group">
                  <label>To</label>
                  <input
                    type="datetime-local"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
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

          {/* ── Answer history ── */}
          {history.length > 0 && (
            <div className="ask-ai-history">
              {history.map((h, idx) => (
                <div key={idx} className="ask-ai-entry">
                  <div className="ask-ai-entry-header">
                    <span className="ask-ai-entry-q">Q: {h.question}</span>
                    <span className="ask-ai-entry-meta">
                      {h.systemLabel} · {h.periodLabel} · {h.contextUsed} context window{h.contextUsed !== 1 ? 's' : ''}
                      {' · '}
                      {formatEuDate(h.timestamp)}
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
