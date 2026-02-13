import { useEffect, useState, useRef, useCallback, Fragment } from 'react';
import {
  type DashboardSystem,
  type LogEvent,
  type MetaResult,
  type EventScoreRecord,
  type GroupedEventScoreRecord,
  type Finding,
  CRITERIA,
  fetchSystemEvents,
  fetchSystemMeta,
  fetchGroupedEventScores,
  fetchGroupedEventDetails,
  fetchFindings,
  acknowledgeFinding,
  reopenFinding,
  acknowledgeEvents,
  previewNormalBehavior,
  createNormalBehaviorTemplate,
  fetchNormalBehaviorTemplates,
  reEvaluateSystem,
  type NormalBehaviorTemplate,
  type NormalBehaviorPreview,
  fetchDashboardConfig,
} from '../api';
import { ScoreBars, CRITERIA_LABELS } from './ScoreBar';
import { AskAiPanel } from './AskAiPanel';
import { MultiSelect } from './MultiSelect';
import { hasPermission } from '../App';

/** Auto-refresh interval for findings (ms). */
const FINDINGS_POLL_INTERVAL = 60_000; // 60 seconds

interface DrillDownProps {
  system: DashboardSystem;
  onBack: () => void;
  onAuthError: () => void;
  currentUser?: import('../api').CurrentUser | null;
  /** Called after a "Mark OK" template is created so the parent can refresh system scores. */
  onRefreshSystem?: () => void;
}

export function DrillDown({ system, onBack, onAuthError, currentUser, onRefreshSystem }: DrillDownProps) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [meta, setMeta] = useState<MetaResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Criterion drill-down state (grouped view)
  const [selectedCriterion, setSelectedCriterion] = useState<string | null>(null);
  const [criterionGroups, setCriterionGroups] = useState<GroupedEventScoreRecord[]>([]);
  const [criterionLoading, setCriterionLoading] = useState(false);
  const [criterionError, setCriterionError] = useState('');
  // Expanded group: tracks which group_key is expanded + its loaded events
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [expandedGroupEvents, setExpandedGroupEvents] = useState<EventScoreRecord[]>([]);
  const [expandedGroupLoading, setExpandedGroupLoading] = useState(false);

  // Findings state
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [findingsTab, setFindingsTab] = useState<'open' | 'acknowledged' | 'resolved'>('open');
  const [ackingId, setAckingId] = useState<string | null>(null);

  // ── "Mark as Normal Behavior" modal state ───────────────
  const [markOkModal, setMarkOkModal] = useState<{
    eventId?: string;
    message: string;
    systemId?: string;
  } | null>(null);
  const [markOkPreview, setMarkOkPreview] = useState<NormalBehaviorPreview | null>(null);
  const [markOkPattern, setMarkOkPattern] = useState('');
  const [markOkLoading, setMarkOkLoading] = useState(false);
  const [markOkError, setMarkOkError] = useState('');
  const [markOkSuccess, setMarkOkSuccess] = useState('');

  // ── Re-evaluate meta-analysis state ─────────────────────
  const [reEvalLoading, setReEvalLoading] = useState(false);
  const [reEvalMsg, setReEvalMsg] = useState('');

  // ── Dashboard config (score display window label) ─────
  const [scoreWindowDays, setScoreWindowDays] = useState(7);

  // ── Normal behavior templates (for hiding "Mark OK" on already-matched events) ──
  const [normalTemplates, setNormalTemplates] = useState<NormalBehaviorTemplate[]>([]);
  const normalRegexes = useRef<Array<{ regex: RegExp; id: string }>>([]);

  // Build compiled regexes when templates change
  useEffect(() => {
    const compiled: Array<{ regex: RegExp; id: string }> = [];
    for (const t of normalTemplates) {
      if (!t.enabled) continue;
      try {
        compiled.push({ regex: new RegExp(t.pattern_regex, 'i'), id: t.id });
      } catch { /* skip invalid regex */ }
    }
    normalRegexes.current = compiled;
  }, [normalTemplates]);

  const loadNormalTemplates = useCallback(() => {
    fetchNormalBehaviorTemplates({ system_id: system.id, enabled: 'true' })
      .then(setNormalTemplates)
      .catch(() => { /* ignore — Mark OK visibility is best-effort */ });
  }, [system.id]);

  useEffect(() => { loadNormalTemplates(); }, [loadNormalTemplates]);

  // Load dashboard config to display the correct time range label
  useEffect(() => {
    fetchDashboardConfig()
      .then((resp) => {
        if (resp?.config?.score_display_window_days) {
          setScoreWindowDays(resp.config.score_display_window_days);
        }
      })
      .catch(() => { /* use default 7 */ });
  }, []);

  /** Check if a message matches any active normal-behavior template. */
  const isNormalBehavior = useCallback((message: string): boolean => {
    for (const entry of normalRegexes.current) {
      if (entry.regex.test(message)) return true;
    }
    return false;
  }, []);

  // ── Event filter state (multi-select) ───────────────────
  const [filterSeverity, setFilterSeverity] = useState<string[]>([]);
  const [filterHost, setFilterHost] = useState<string[]>([]);
  const [filterProgram, setFilterProgram] = useState<string[]>([]);
  const [filterService, setFilterService] = useState<string[]>([]);
  const [filterFacility, setFilterFacility] = useState<string[]>([]);

  // Track all unique values seen (accumulated across loads to keep options stable)
  const [filterOptions, setFilterOptions] = useState<{
    severity: string[]; host: string[]; program: string[]; service: string[]; facility: string[];
  }>({ severity: [], host: [], program: [], service: [], facility: [] });

  // Stable reference for auth error handler
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  // ── Load events + meta ──────────────────────────────────
  const loadData = useCallback(() => {
    setLoading(true);
    setError('');

    Promise.all([
      fetchSystemEvents(system.id, {
        limit: 200,
        severity: filterSeverity.length > 0 ? filterSeverity : undefined,
        host: filterHost.length > 0 ? filterHost : undefined,
        program: filterProgram.length > 0 ? filterProgram : undefined,
        service: filterService.length > 0 ? filterService : undefined,
        facility: filterFacility.length > 0 ? filterFacility : undefined,
      }),
      fetchSystemMeta(system.id).catch(() => null),
    ])
      .then(([evts, m]) => {
        setEvents(evts);
        setMeta(m);

        // Accumulate unique filter option values (merge with existing to keep options stable)
        setFilterOptions((prev) => {
          const merge = (existing: string[], newVals: (string | null | undefined)[]) => {
            const set = new Set(existing);
            for (const v of newVals) { if (v) set.add(v); }
            return Array.from(set).sort();
          };
          return {
            severity: merge(prev.severity, evts.map((e) => e.severity)),
            host: merge(prev.host, evts.map((e) => e.host)),
            program: merge(prev.program, evts.map((e) => e.program)),
            service: merge(prev.service, evts.map((e) => e.service)),
            facility: merge(prev.facility, evts.map((e) => e.facility)),
          };
        });
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Authentication')) {
          onAuthErrorRef.current();
          return;
        }
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [system.id, filterSeverity, filterHost, filterProgram, filterService, filterFacility]);

  // ── Load findings ───────────────────────────────────────
  const loadFindings = useCallback(async () => {
    setFindingsLoading(true);
    try {
      // Fetch all findings (including resolved for display)
      const all = await fetchFindings(system.id, { limit: 200 });
      setFindings(all);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
      }
      // Don't set error for findings — just keep stale data
    } finally {
      setFindingsLoading(false);
    }
  }, [system.id]);

  useEffect(() => {
    loadData();
    loadFindings();
  }, [loadData, loadFindings]);

  // ── Seed filter options from an unfiltered fetch (runs once) ──
  // When user applies a filter, loadData fetches only matching events.
  // This one-time unfiltered fetch ensures dropdown options include ALL values.
  const filterSeeded = useRef(false);
  useEffect(() => {
    if (filterSeeded.current) return;
    filterSeeded.current = true;
    // Only seed if filters are already active (initial unfiltered loadData covers the initial case)
    const hasFilters = filterSeverity.length > 0 || filterHost.length > 0 || filterProgram.length > 0 || filterService.length > 0 || filterFacility.length > 0;
    if (hasFilters) {
      fetchSystemEvents(system.id, { limit: 200 }).then((evts) => {
        setFilterOptions((prev) => {
          const merge = (existing: string[], newVals: (string | null | undefined)[]) => {
            const set = new Set(existing);
            for (const v of newVals) { if (v) set.add(v); }
            return Array.from(set).sort();
          };
          return {
            severity: merge(prev.severity, evts.map((e) => e.severity)),
            host: merge(prev.host, evts.map((e) => e.host)),
            program: merge(prev.program, evts.map((e) => e.program)),
            service: merge(prev.service, evts.map((e) => e.service)),
            facility: merge(prev.facility, evts.map((e) => e.facility)),
          };
        });
      }).catch(() => { /* ignore — main loadData will show error */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system.id]);

  // ── Auto-refresh findings ───────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      loadFindings();
    }, FINDINGS_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [loadFindings]);

  // Move focus to heading on mount for accessibility
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const toggleRow = (id: string) => {
    setExpandedRow((prev) => (prev === id ? null : id));
  };

  /** Build plain-text representation of an event for clipboard. */
  const eventToText = (e: LogEvent): string => {
    const lines: string[] = [
      `Event ID:    ${e.id}`,
      `Timestamp:   ${safeDate(e.timestamp)}`,
      `System:      ${system.name}`,
      `Severity:    ${e.severity ?? '—'}`,
      `Host:        ${e.host ?? '—'}`,
      `Source IP:   ${e.source_ip ?? '—'}`,
      `Program:     ${e.program ?? '—'}`,
      `Service:     ${e.service ?? '—'}`,
      `Facility:    ${e.facility ?? '—'}`,
    ];
    if (e.received_at) lines.push(`Received:    ${safeDate(e.received_at)}`);
    if (e.trace_id) lines.push(`Trace ID:    ${e.trace_id}`);
    if (e.span_id) lines.push(`Span ID:     ${e.span_id}`);
    if (e.external_id) lines.push(`External ID: ${e.external_id}`);
    if (e.acknowledged_at) lines.push(`Acknowledged: ${safeDate(e.acknowledged_at)}`);
    lines.push('', '--- Message ---', e.message);
    if (e.raw) {
      lines.push('', '--- Raw Data ---', typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw, null, 2));
    }
    return lines.join('\n');
  };

  const handleCopyEvent = async (e: LogEvent) => {
    try {
      await navigator.clipboard.writeText(eventToText(e));
      setCopiedId(e.id);
      setTimeout(() => setCopiedId((prev) => (prev === e.id ? null : prev)), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = eventToText(e);
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(e.id);
      setTimeout(() => setCopiedId((prev) => (prev === e.id ? null : prev)), 2000);
    }
  };

  // ── Criterion click handler (grouped view) ─────────────
  const handleCriterionClick = useCallback(async (slug: string) => {
    if (selectedCriterion === slug) {
      setSelectedCriterion(null);
      setCriterionGroups([]);
      setExpandedGroup(null);
      setExpandedGroupEvents([]);
      return;
    }

    setSelectedCriterion(slug);
    setCriterionGroups([]);
    setExpandedGroup(null);
    setExpandedGroupEvents([]);
    setCriterionLoading(true);
    setCriterionError('');

    const criterion = CRITERIA.find((c) => c.slug === slug);
    if (!criterion) {
      setCriterionError(`Unknown criterion: ${slug}`);
      setCriterionLoading(false);
      return;
    }

    try {
      const data = await fetchGroupedEventScores(system.id, {
        criterion_id: criterion.id,
        limit: 50,
        min_score: 0.001,
      });
      setCriterionGroups(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
        return;
      }
      setCriterionError(msg);
    } finally {
      setCriterionLoading(false);
    }
  }, [selectedCriterion, system.id]);

  // ── Expand a grouped row to show individual events ─────
  const handleExpandGroup = useCallback(async (groupKey: string) => {
    if (expandedGroup === groupKey) {
      setExpandedGroup(null);
      setExpandedGroupEvents([]);
      return;
    }

    setExpandedGroup(groupKey);
    setExpandedGroupEvents([]);
    setExpandedGroupLoading(true);

    const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);

    try {
      const data = await fetchGroupedEventDetails(system.id, groupKey, {
        criterion_id: criterion?.id,
        limit: 100,
      });
      setExpandedGroupEvents(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
        return;
      }
      // Silently fail — the user can click again
      console.error('Failed to load group detail:', msg);
    } finally {
      setExpandedGroupLoading(false);
    }
  }, [expandedGroup, selectedCriterion, system.id]);

  // ── Finding acknowledge / reopen ────────────────────────
  const handleAcknowledge = useCallback(async (findingId: string) => {
    setAckingId(findingId);
    try {
      const updated = await acknowledgeFinding(findingId);
      setFindings((prev) => prev.map((f) => (f.id === findingId ? updated : f)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
        return;
      }
      // Silently swallow — user can try again
    } finally {
      setAckingId(null);
    }
  }, []);

  const handleReopen = useCallback(async (findingId: string) => {
    setAckingId(findingId);
    try {
      const updated = await reopenFinding(findingId);
      setFindings((prev) => prev.map((f) => (f.id === findingId ? updated : f)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthErrorRef.current();
        return;
      }
    } finally {
      setAckingId(null);
    }
  }, []);

  // ── Bulk ack: all open findings ─────────────────────────
  const [bulkAcking, setBulkAcking] = useState(false);
  const [bulkAckMsg, setBulkAckMsg] = useState('');

  const handleAckAllFindings = useCallback(async () => {
    const open = findings.filter((f) => f.status === 'open');
    if (open.length === 0) return;
    if (!window.confirm(
      `Acknowledge ALL ${open.length} open finding${open.length !== 1 ? 's' : ''} for "${system.name}"?`,
    )) return;

    setBulkAcking(true);
    setBulkAckMsg('');
    try {
      let acked = 0;
      for (const f of open) {
        const updated = await acknowledgeFinding(f.id);
        setFindings((prev) => prev.map((x) => (x.id === f.id ? updated : x)));
        acked++;
      }
      setBulkAckMsg(`${acked} finding${acked !== 1 ? 's' : ''} acknowledged.`);
      setTimeout(() => setBulkAckMsg(''), 4000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setBulkAckMsg(`Error: ${msg}`);
      setTimeout(() => setBulkAckMsg(''), 5000);
    } finally {
      setBulkAcking(false);
    }
  }, [findings, system.name]);

  // ── Bulk ack: all events ──────────────────────────────
  const handleAckAllEvents = useCallback(async () => {
    if (!window.confirm(
      `Acknowledge ALL events for "${system.name}" up to now?\n\nAcknowledged events will be excluded from future LLM scoring.`,
    )) return;

    setBulkAcking(true);
    setBulkAckMsg('');
    try {
      const res = await acknowledgeEvents({ system_id: system.id });
      setBulkAckMsg(res.message);
      setTimeout(() => setBulkAckMsg(''), 4000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setBulkAckMsg(`Error: ${msg}`);
      setTimeout(() => setBulkAckMsg(''), 5000);
    } finally {
      setBulkAcking(false);
    }
  }, [system.id, system.name]);

  // ── Mark as Normal Behavior ────────────────────────────
  const openMarkOkModal = useCallback(async (eventIdOrUndef: string | undefined, message: string, systemId?: string) => {
    setMarkOkModal({ eventId: eventIdOrUndef, message, systemId });
    setMarkOkPreview(null);
    setMarkOkPattern('');
    setMarkOkError('');
    setMarkOkSuccess('');
    setMarkOkLoading(true);
    try {
      // Use event_id when available (individual events), fall back to message (group rows)
      const preview = eventIdOrUndef
        ? await previewNormalBehavior({ event_id: eventIdOrUndef })
        : await previewNormalBehavior({ message });
      setMarkOkPreview(preview);
      setMarkOkPattern(preview.suggested_pattern);
    } catch (err: unknown) {
      // Fallback: try message-based preview
      try {
        const preview = await previewNormalBehavior({ message });
        setMarkOkPreview(preview);
        setMarkOkPattern(preview.suggested_pattern);
      } catch {
        setMarkOkError('Failed to generate pattern preview');
      }
    } finally {
      setMarkOkLoading(false);
    }
  }, []);

  const handleMarkOkConfirm = useCallback(async () => {
    if (!markOkModal || !markOkPattern.trim()) return;
    setMarkOkLoading(true);
    setMarkOkError('');
    try {
      await createNormalBehaviorTemplate({
        event_id: markOkModal.eventId,
        system_id: markOkModal.systemId ?? system.id,
        pattern: markOkPattern.trim(),
        message: !markOkModal.eventId ? markOkModal.message : undefined,
      });
      setMarkOkSuccess('Template created. Scores recalculated. Future matching events will be treated as normal behavior.');
      setTimeout(() => {
        setMarkOkModal(null);
        setMarkOkSuccess('');
      }, 2500);

      // Reload normal-behavior templates so the "Mark OK" button hides for matching events
      loadNormalTemplates();

      // Refresh criterion drill-down data (event scores are now zeroed for matching events)
      if (selectedCriterion) {
        const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
        if (criterion) {
          try {
            const data = await fetchGroupedEventScores(system.id, {
              criterion_id: criterion.id,
              limit: 50,
              min_score: 0.001,
            });
            setCriterionGroups(data);
            setExpandedGroup(null);
            setExpandedGroupEvents([]);
          } catch { /* ignore refresh error */ }
        }
      }

      // Notify parent to refresh system scores on the dashboard
      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setMarkOkError(`Error: ${msg}`);
    } finally {
      setMarkOkLoading(false);
    }
  }, [markOkModal, markOkPattern, system.id, selectedCriterion, onRefreshSystem, loadNormalTemplates]);

  // ── Re-evaluate meta-analysis handler ───────────────────
  const handleReEvaluate = useCallback(async () => {
    if (reEvalLoading) return;
    if (!window.confirm(
      'Re-evaluate meta-analysis for this system?\n\nThis will run a fresh AI analysis on recent events (excluding normal-behavior events). It may take 10-30 seconds.',
    )) return;

    setReEvalLoading(true);
    setReEvalMsg('');
    try {
      const res = await reEvaluateSystem(system.id);
      setReEvalMsg(res.message);
      setTimeout(() => setReEvalMsg(''), 5000);

      // Refresh criterion drill-down if open
      if (selectedCriterion) {
        const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
        if (criterion) {
          try {
            const data = await fetchGroupedEventScores(system.id, {
              criterion_id: criterion.id,
              limit: 50,
              min_score: 0.001,
            });
            setCriterionGroups(data);
            setExpandedGroup(null);
            setExpandedGroupEvents([]);
          } catch { /* ignore */ }
        }
      }

      // Refresh meta summary text
      try {
        const freshMeta = await fetchSystemMeta(system.id);
        if (freshMeta) setMeta(freshMeta);
      } catch { /* ignore */ }

      // Refresh findings (re-evaluate may auto-resolve findings matching normal behavior)
      loadFindings();

      // Refresh parent dashboard scores
      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setReEvalMsg(`Error: ${msg}`);
      setTimeout(() => setReEvalMsg(''), 6000);
    } finally {
      setReEvalLoading(false);
    }
  }, [reEvalLoading, system.id, selectedCriterion, onRefreshSystem, loadFindings]);

  // ── Compute filtered findings ───────────────────────────
  const openFindings = findings.filter((f) => f.status === 'open');
  const ackedFindings = findings.filter((f) => f.status === 'acknowledged');
  const resolvedFindings = findings.filter((f) => f.status === 'resolved');
  const displayedFindings =
    findingsTab === 'open' ? openFindings :
    findingsTab === 'acknowledged' ? ackedFindings :
    resolvedFindings;

  // Active issues = open + acknowledged (things that need attention)
  const activeFindings = [...openFindings, ...ackedFindings];
  const findingsPanelRef = useRef<HTMLDivElement>(null);

  // Severity breakdown for the banner
  const severityBreakdown = activeFindings.reduce<Record<string, number>>((acc, f) => {
    const sev = (f.severity ?? 'info').toLowerCase();
    acc[sev] = (acc[sev] ?? 0) + 1;
    return acc;
  }, {});

  // Flapping detection removed — resolved findings are never reopened.
  // Recurring issues create new findings with "Recurring:" prefix.

  return (
    <div className="drill-down">
      <button
        className="back-btn"
        onClick={onBack}
        aria-label="Back to systems overview"
      >
        ← Back to overview
      </button>

      <div className="dd-top-row">
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="drill-down-heading">
            {system.name}
          </h2>
          {system.description && (
            <p className="drill-down-description">{system.description}</p>
          )}
        </div>
        <div className="dd-top-actions">
          {hasPermission(currentUser ?? null, 'events:acknowledge') && (
            <button
              className="btn btn-sm btn-danger"
              onClick={handleAckAllEvents}
              disabled={bulkAcking}
              title="Acknowledge all events for this system up to now"
            >
              {bulkAcking ? '...' : 'Ack All Events'}
            </button>
          )}
        </div>
      </div>

      {/* ── Bulk ack status message ── */}
      {bulkAckMsg && (
        <div className={`bulk-ack-msg${bulkAckMsg.startsWith('Error') ? ' bulk-ack-error' : ''}`}>
          {bulkAckMsg}
        </div>
      )}

      {/* ── Active Issues Summary banner ── */}
      {!findingsLoading && activeFindings.length > 0 && (
        <div
          className="active-issues-banner"
          onClick={() => findingsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              findingsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }}
          title="Click to scroll to findings"
        >
          <span className="active-issues-count">
            {activeFindings.length} active issue{activeFindings.length !== 1 ? 's' : ''}
          </span>
          <span className="active-issues-breakdown">
            {(['critical', 'high', 'medium', 'low', 'info'] as const)
              .filter((sev) => severityBreakdown[sev])
              .map((sev) => (
                <span key={sev} className={`active-issues-sev active-issues-sev-${sev}`}>
                  <span className={`active-issues-dot severity-dot-${sev}`} />
                  {severityBreakdown[sev]} {sev}
                </span>
              ))}
          </span>
        </div>
      )}

      {/* Current scores — clickable for criterion drill-down */}
      {Object.keys(system.scores).length > 0 && (
        <div className="drill-down-scores">
          <p className="drill-down-score-hint">Click a score bar to see the highest-scoring events for that criterion. <span className="score-timerange">Scores reflect last {scoreWindowDays} day{scoreWindowDays !== 1 ? 's' : ''}.</span></p>
          <ScoreBars
            scores={system.scores}
            onCriterionClick={handleCriterionClick}
            selectedCriterion={selectedCriterion}
          />
        </div>
      )}

      {/* ── Criterion drill-down panel ── */}
      {selectedCriterion && (() => {
        const scoreInfo = system.scores[selectedCriterion];
        const effectivePct = scoreInfo ? Math.round((Number(scoreInfo.effective) || 0) * 100) : 0;
        const metaPct = scoreInfo ? Math.round((Number(scoreInfo.meta) || 0) * 100) : 0;
        const maxEventPct = scoreInfo ? Math.round((Number(scoreInfo.max_event) || 0) * 100) : 0;
        const criterionLabel = CRITERIA_LABELS[selectedCriterion] ?? selectedCriterion;

        return (
          <div className="criterion-drilldown">
            <div className="criterion-drilldown-header">
              <h4>
                Events scored for: <span className="criterion-drilldown-name">{criterionLabel}</span>
              </h4>
              <div className="criterion-drilldown-actions">
                {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={handleReEvaluate}
                    disabled={reEvalLoading}
                    title="Re-run AI meta-analysis on recent events (excludes events marked as normal behavior)"
                  >
                    {reEvalLoading ? 'Analyzing…' : 'Re-evaluate'}
                  </button>
                )}
                <button
                  className="btn btn-xs btn-outline"
                  onClick={() => { setSelectedCriterion(null); setCriterionGroups([]); setExpandedGroup(null); setExpandedGroupEvents([]); }}
                >
                  Close
                </button>
              </div>
            </div>
            {reEvalMsg && (
              <div className={`reeval-msg${reEvalMsg.startsWith('Error') ? ' reeval-error' : ''}`}>
                {reEvalMsg}
              </div>
            )}

            {/* Score breakdown: meta vs event components */}
            {scoreInfo && effectivePct > 0 && (
              <div className="criterion-score-breakdown">
                <span className="breakdown-item">
                  <strong>Dashboard Score:</strong>{' '}
                  <span style={{ color: scoreColorFromValue(Number(scoreInfo.effective) || 0) }}>{effectivePct}%</span>
                </span>
                <span className="breakdown-separator">= </span>
                <span className="breakdown-item" title="Score from AI meta-analysis (holistic assessment of all events together)">
                  Meta-analysis: <span style={{ color: metaPct > 0 ? scoreColorFromValue(Number(scoreInfo.meta) || 0) : 'var(--muted)' }}>{metaPct}%</span>
                  <span className="breakdown-weight"> (&times;70%)</span>
                </span>
                <span className="breakdown-separator"> + </span>
                <span className="breakdown-item" title="Highest individual event score for this criterion">
                  Max event: <span style={{ color: maxEventPct > 0 ? scoreColorFromValue(Number(scoreInfo.max_event) || 0) : 'var(--muted)' }}>{maxEventPct}%</span>
                  <span className="breakdown-weight"> (&times;30%)</span>
                </span>
              </div>
            )}

            {criterionLoading && (
              <div className="settings-loading"><div className="spinner" /> Loading scored events…</div>
            )}
            {criterionError && <div className="error-msg" role="alert">{criterionError}</div>}

            {!criterionLoading && !criterionError && criterionGroups.length === 0 && (
              <div className="criterion-drilldown-empty">
                {effectivePct > 0 && metaPct > 0 && maxEventPct === 0 ? (
                  <>
                    No individual events scored above 0% for <strong>{criterionLabel}</strong>.
                    The dashboard score of {effectivePct}% comes entirely from the{' '}
                    <strong>AI meta-analysis</strong> ({metaPct}%), which evaluates all events holistically
                    and detected concerns relevant to this criterion across the event pattern.
                  </>
                ) : (
                  <>
                    No events have been scored for this criterion yet. Events are scored by the AI pipeline every 5 minutes.
                  </>
                )}
              </div>
            )}

            {!criterionLoading && criterionGroups.length > 0 && (
              <div className="table-responsive">
                <table className="criterion-events-table criterion-grouped-table" aria-label={`Event patterns scored for ${criterionLabel}`}>
                  <thead>
                    <tr>
                      <th style={{ width: '32px' }}></th>
                      <th>Score</th>
                      <th>Count</th>
                      <th>Severity</th>
                      <th>Time Range</th>
                      <th>Hosts</th>
                      <th>Program</th>
                      <th>Message</th>
                      {hasPermission(currentUser ?? null, 'events:acknowledge') && <th style={{ width: '80px' }}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {criterionGroups.map((grp) => {
                      const score = Number(grp.score) || 0;
                      const pct = Math.round(score * 100);
                      const isExpanded = expandedGroup === grp.group_key;
                      const hasMultiple = grp.occurrence_count > 1;
                      return (
                        <Fragment key={grp.group_key}>
                          <tr
                            className={`criterion-event-row criterion-group-row${isExpanded ? ' criterion-group-expanded' : ''}${hasMultiple ? ' criterion-group-clickable' : ''}`}
                            onClick={hasMultiple ? () => handleExpandGroup(grp.group_key) : undefined}
                            style={hasMultiple ? { cursor: 'pointer' } : undefined}
                            title={hasMultiple ? (isExpanded ? 'Click to collapse' : `Click to see all ${grp.occurrence_count} events`) : undefined}
                          >
                            <td className="criterion-expand-cell">
                              {hasMultiple && (
                                <span className={`criterion-expand-icon${isExpanded ? ' expanded' : ''}`}>&#9656;</span>
                              )}
                            </td>
                            <td className="criterion-score-cell">
                              <span
                                className="criterion-score-badge"
                                style={{ color: scoreColorFromValue(score) }}
                              >
                                {pct}%
                              </span>
                            </td>
                            <td className="criterion-count-cell">
                              {hasMultiple ? (
                                <span className="criterion-count-badge">&times;{grp.occurrence_count}</span>
                              ) : (
                                <span className="criterion-count-single">1</span>
                              )}
                            </td>
                            <td>
                              {grp.severity && (
                                <span className={`severity-badge ${grp.severity.toLowerCase()}`}>
                                  {grp.severity}
                                </span>
                              )}
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {grp.first_seen === grp.last_seen
                                ? safeDate(grp.first_seen)
                                : `${safeDate(grp.first_seen)} — ${safeDate(grp.last_seen)}`
                              }
                            </td>
                            <td>{grp.hosts.length > 0 ? grp.hosts.join(', ') : '—'}</td>
                            <td>{grp.program ?? '—'}</td>
                            <td className="criterion-message-cell">{grp.message}</td>
                            {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                              <td className="criterion-actions-cell">
                                {isNormalBehavior(grp.message) ? (
                                  <span className="mark-ok-done" title="Already marked as normal behavior">✓ Normal</span>
                                ) : (
                                  <button
                                    className="btn btn-xs btn-mark-ok"
                                    onClick={(ev) => { ev.stopPropagation(); openMarkOkModal(undefined, grp.message, system.id); }}
                                    title="Mark this event pattern as normal behavior"
                                  >
                                    Mark OK
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>

                          {/* Expanded detail rows */}
                          {isExpanded && (
                            expandedGroupLoading ? (
                              <tr className="criterion-detail-loading-row">
                                <td colSpan={hasPermission(currentUser ?? null, 'events:acknowledge') ? 9 : 8}>
                                  <div className="settings-loading"><div className="spinner" /> Loading events…</div>
                                </td>
                              </tr>
                            ) : (
                              expandedGroupEvents.map((ev, idx) => (
                                <tr key={`${ev.event_id}-${idx}`} className="criterion-event-row criterion-detail-row">
                                  <td></td>
                                  <td className="criterion-score-cell">
                                    <span className="criterion-score-badge" style={{ color: scoreColorFromValue(Number(ev.score) || 0) }}>
                                      {Math.round((Number(ev.score) || 0) * 100)}%
                                    </span>
                                  </td>
                                  <td></td>
                                  <td>
                                    {ev.severity && (
                                      <span className={`severity-badge ${ev.severity.toLowerCase()}`}>{ev.severity}</span>
                                    )}
                                  </td>
                                  <td style={{ whiteSpace: 'nowrap' }}>{safeDate(ev.timestamp)}</td>
                                  <td>{ev.host ?? '—'}</td>
                                  <td>{ev.program ?? '—'}</td>
                                  <td className="criterion-message-cell">{ev.message}</td>
                                  {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                                    <td className="criterion-actions-cell">
                                      {isNormalBehavior(ev.message) ? (
                                        <span className="mark-ok-done" title="Already marked as normal behavior">✓ Normal</span>
                                      ) : (
                                        <button
                                          className="btn btn-xs btn-mark-ok"
                                          onClick={() => openMarkOkModal(ev.event_id, ev.message, system.id)}
                                          title="Mark this event pattern as normal behavior"
                                        >
                                          Mark OK
                                        </button>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))
                            )
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {(() => {
                  const totalEvents = criterionGroups.reduce((sum, g) => sum + g.occurrence_count, 0);
                  return (
                    <p className="truncation-notice">
                      {criterionGroups.length} unique pattern{criterionGroups.length !== 1 ? 's' : ''} across {totalEvents} total event{totalEvents !== 1 ? 's' : ''}.
                    </p>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })()}

      {error && <div className="error-msg" role="alert">{error}</div>}
      {loading && (
        <div className="loading" aria-live="polite">
          <div className="spinner" />
          Loading…
        </div>
      )}

      {/* ── Meta summary ── */}
      {meta && (
        <div className="meta-summary">
          <div className="meta-summary-header">
            <span className="meta-summary-icon">&#x1F9E0;</span>
            <h4>Meta Analysis Summary</h4>
            {hasPermission(currentUser ?? null, 'events:acknowledge') && (
              <button
                className="btn btn-xs btn-primary"
                style={{ marginLeft: 'auto' }}
                onClick={handleReEvaluate}
                disabled={reEvalLoading}
                title="Re-run AI meta-analysis on recent events (excludes events marked as normal behavior)"
              >
                {reEvalLoading ? 'Analyzing…' : 'Re-evaluate'}
              </button>
            )}
          </div>
          {reEvalMsg && (
            <div className={`reeval-msg${reEvalMsg.startsWith('Error') ? ' reeval-error' : ''}`}>
              {reEvalMsg}
            </div>
          )}
          <div className="meta-summary-body">
            {meta.summary}
          </div>
          {meta.recommended_action && (
            <div className="meta-summary-recommendation">
              <strong>Recommended:</strong> {meta.recommended_action}
            </div>
          )}
        </div>
      )}

      {/* ── Ask AI (system-scoped) ── */}
      {hasPermission(currentUser ?? null, 'rag:use') && (
        <AskAiPanel
          fixedSystemId={system.id}
          fixedSystemName={system.name}
          onAuthError={onAuthError}
        />
      )}

      {/* ── Persistent Findings panel ── */}
      {!loading && (
        <div className="findings-panel" ref={findingsPanelRef}>
          <div className="findings-panel-header">
            <h4>AI Findings</h4>
            <div className="findings-tabs">
              <button
                className={`findings-tab${findingsTab === 'open' ? ' active' : ''}`}
                onClick={() => setFindingsTab('open')}
              >
                Open{openFindings.length > 0 && <span className="findings-tab-count">{openFindings.length}</span>}
              </button>
              <button
                className={`findings-tab${findingsTab === 'acknowledged' ? ' active' : ''}`}
                onClick={() => setFindingsTab('acknowledged')}
              >
                Ack&apos;d{ackedFindings.length > 0 && <span className="findings-tab-count">{ackedFindings.length}</span>}
              </button>
              <button
                className={`findings-tab${findingsTab === 'resolved' ? ' active' : ''}`}
                onClick={() => setFindingsTab('resolved')}
              >
                Resolved{resolvedFindings.length > 0 && <span className="findings-tab-count">{resolvedFindings.length}</span>}
              </button>
            </div>
            {findingsTab === 'open' && openFindings.length > 0 && hasPermission(currentUser ?? null, 'events:acknowledge') && (
              <button
                className="btn btn-xs btn-ack"
                onClick={handleAckAllFindings}
                disabled={bulkAcking || ackingId !== null}
                title="Acknowledge all open findings"
              >
                {bulkAcking ? '...' : 'Ack All'}
              </button>
            )}
            <button className="btn btn-xs btn-outline" onClick={loadFindings} title="Refresh findings">
              ↻ Refresh
            </button>
          </div>

          {findingsLoading && (
            <div className="settings-loading"><div className="spinner" /> Loading findings…</div>
          )}

          {displayedFindings.length === 0 && !findingsLoading && (
            <div className="findings-empty">
              {findingsTab === 'open' && 'No open findings. The AI has not detected any active issues.'}
              {findingsTab === 'acknowledged' && 'No acknowledged findings.'}
              {findingsTab === 'resolved' && 'No resolved findings yet.'}
            </div>
          )}

          {displayedFindings.length > 0 && (
            <div className="findings-list-new">
              {displayedFindings.map((f) => {
                const occurrences = Number(f.occurrence_count) || 1;
                // Robust check: PostgreSQL boolean may arrive as true, 't', or 1 over JSON
                const hasDecay = f.original_severity && f.original_severity !== f.severity;
                const showLastSeen = occurrences > 1 && f.last_seen_at;
                return (
                  <div key={f.id} className={`finding-card finding-status-${f.status}`}>
                    <div className="finding-card-top">
                      <span className={`finding-severity finding-severity-${f.severity}`}>
                        {hasDecay && (
                          <span className="finding-severity-decay" title={`Originally ${f.original_severity}, decayed due to ${occurrences} occurrences`}>
                            <s>{f.original_severity}</s>&rarr;
                          </span>
                        )}
                        {f.severity}
                      </span>
                      {occurrences > 1 && (
                        <span
                          className="finding-occurrence-badge"
                          title={`Detected ${occurrences} times across analysis windows`}
                        >
                          &times;{occurrences}
                        </span>
                      )}
                      {f.criterion_slug && (
                        <span className="finding-criterion">
                          {CRITERIA_LABELS[f.criterion_slug] ?? f.criterion_slug}
                        </span>
                      )}
                      <span className="finding-time">
                        {safeDate(f.created_at)}
                        {showLastSeen && (
                          <span className="finding-last-seen" title="Last seen at">
                            {' '}| last: {safeDate(f.last_seen_at!)}
                          </span>
                        )}
                      </span>
                    </div>
                    <p className="finding-text">{f.text}</p>
                    {/* Resolution evidence for resolved findings — with clickable event links */}
                    {f.status === 'resolved' && f.resolution_evidence && (() => {
                      let evidence: { text?: string; event_ids?: string[] } | null = null;
                      try {
                        evidence = typeof f.resolution_evidence === 'string'
                          ? JSON.parse(f.resolution_evidence)
                          : f.resolution_evidence as { text?: string; event_ids?: string[] };
                      } catch { /* legacy plain-text evidence */ }

                      if (evidence && typeof evidence === 'object' && evidence.text) {
                        return (
                          <div className="finding-resolution-evidence" title="Evidence for resolution">
                            <strong>Resolution:</strong> {evidence.text}
                            {evidence.event_ids && evidence.event_ids.length > 0 && (
                              <div className="resolution-event-links">
                                <span className="resolution-links-label">Proof events:</span>
                                {evidence.event_ids.map((eid, idx) => (
                                  <button
                                    key={eid}
                                    className="resolution-event-link"
                                    title={`Scroll to event ${eid}`}
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      const row = document.getElementById(`event-row-${eid}`);
                                      if (row) {
                                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        setExpandedRow(eid);
                                        row.classList.add('event-row-highlight');
                                        setTimeout(() => row.classList.remove('event-row-highlight'), 3000);
                                      }
                                    }}
                                  >
                                    Event #{idx + 1}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      }

                      // Fallback for legacy plain-text evidence
                      return (
                        <p className="finding-resolution-evidence" title="Evidence for resolution">
                          Resolution: {String(f.resolution_evidence)}
                        </p>
                      );
                    })()}
                    <div className="finding-card-actions">
                      {f.status === 'open' && hasPermission(currentUser ?? null, 'events:acknowledge') && (
                        <button
                          className="btn btn-xs btn-ack"
                          onClick={() => handleAcknowledge(f.id)}
                          disabled={ackingId === f.id}
                        >
                          {ackingId === f.id ? 'Acknowledging…' : '✓ Acknowledge'}
                        </button>
                      )}
                      {f.status === 'acknowledged' && (
                        <>
                          <span className="finding-acked-info">
                            Ack&apos;d {f.acknowledged_at ? safeDate(f.acknowledged_at) : ''}
                          </span>
                          {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() => handleReopen(f.id)}
                              disabled={ackingId === f.id}
                            >
                              Reopen
                            </button>
                          )}
                        </>
                      )}
                      {f.status === 'resolved' && f.resolved_at && (
                        <span className="finding-resolved-info">
                          Resolved by AI {safeDate(f.resolved_at)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Event filters ─────────────────────────────────── */}
      {(events.length > 0 || filterSeverity.length > 0 || filterHost.length > 0 || filterProgram.length > 0 || filterService.length > 0 || filterFacility.length > 0) && (
        <div className="event-filters-bar">
          <span className="event-filters-label">Filters:</span>
          <div className="event-filter-item">
            <label>Severity</label>
            <MultiSelect
              value={filterSeverity}
              options={filterOptions.severity}
              onChange={setFilterSeverity}
              placeholder="All"
            />
          </div>
          <div className="event-filter-item">
            <label>Host</label>
            <MultiSelect
              value={filterHost}
              options={filterOptions.host}
              onChange={setFilterHost}
              placeholder="All"
            />
          </div>
          <div className="event-filter-item">
            <label>Program</label>
            <MultiSelect
              value={filterProgram}
              options={filterOptions.program}
              onChange={setFilterProgram}
              placeholder="All"
            />
          </div>
          <div className="event-filter-item">
            <label>Service</label>
            <MultiSelect
              value={filterService}
              options={filterOptions.service}
              onChange={setFilterService}
              placeholder="All"
            />
          </div>
          <div className="event-filter-item">
            <label>Facility</label>
            <MultiSelect
              value={filterFacility}
              options={filterOptions.facility}
              onChange={setFilterFacility}
              placeholder="All"
            />
          </div>
          {(filterSeverity.length > 0 || filterHost.length > 0 || filterProgram.length > 0 || filterService.length > 0 || filterFacility.length > 0) && (
            <button
              type="button"
              className="btn btn-sm btn-outline event-filters-clear"
              onClick={() => {
                setFilterSeverity([]);
                setFilterHost([]);
                setFilterProgram([]);
                setFilterService([]);
                setFilterFacility([]);
              }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Events table */}
      {events.length > 0 && (
        <div className="table-responsive">
          <table className="events-table" aria-label={`Recent events for ${system.name}`}>
            <caption className="sr-only">
              Showing {events.length} most recent events for {system.name}
              {events.length >= 200 && ' (limited to 200)'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Severity</th>
                <th scope="col">Host</th>
                <th scope="col">Source IP</th>
                <th scope="col">Program</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr
                    id={`event-row-${e.id}`}
                    className={`event-row ${expandedRow === e.id ? 'expanded' : ''}`}
                    onClick={() => toggleRow(e.id)}
                    tabIndex={0}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        toggleRow(e.id);
                      }
                    }}
                    aria-expanded={expandedRow === e.id}
                    role="row"
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {safeDate(e.timestamp)}
                    </td>
                    <td>
                      {e.severity && (
                        <span className={`severity-badge ${e.severity.toLowerCase()}`}>
                          {e.severity}
                        </span>
                      )}
                    </td>
                    <td>{e.host ?? '—'}</td>
                    <td>{e.source_ip ?? '—'}</td>
                    <td>{e.program ?? '—'}</td>
                    <td className={expandedRow === e.id ? 'message-expanded' : 'message-truncated'}>
                      {e.message}
                    </td>
                  </tr>
                  {expandedRow === e.id && (
                    <tr className="ee-detail-row">
                      <td colSpan={6}>
                        <div className="ee-detail-content">
                          <div className="ee-detail-grid">
                            <div className="ee-detail-field ee-detail-field-wide">
                              <strong>Event ID:</strong> <code className="ee-id-code">{e.id}</code>
                            </div>
                            <div className="ee-detail-field">
                              <strong>Source IP:</strong> {e.source_ip ?? '—'}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Received:</strong> {e.received_at ? safeDate(e.received_at) : '—'}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Service:</strong> {e.service ?? '—'}
                            </div>
                            <div className="ee-detail-field">
                              <strong>Facility:</strong> {e.facility ?? '—'}
                            </div>
                            {e.trace_id && (
                              <div className="ee-detail-field">
                                <strong>Trace ID:</strong> <code>{e.trace_id}</code>
                              </div>
                            )}
                            {e.span_id && (
                              <div className="ee-detail-field">
                                <strong>Span ID:</strong> <code>{e.span_id}</code>
                              </div>
                            )}
                          </div>
                          <div className="ee-detail-message">
                            <strong>Full message:</strong>
                            <pre>{e.message}</pre>
                          </div>
                          {e.raw && (
                            <div className="ee-detail-raw">
                              <strong>Raw data:</strong>
                              <pre>{typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw, null, 2)}</pre>
                            </div>
                          )}
                          <div className="ee-detail-actions">
                            <button
                              className={`btn btn-sm ${copiedId === e.id ? 'btn-success-outline' : 'btn-outline'}`}
                              onClick={(ev) => { ev.stopPropagation(); handleCopyEvent(e); }}
                              title="Copy full event details to clipboard"
                            >
                              {copiedId === e.id ? 'Copied!' : 'Copy Event'}
                            </button>
                            {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                              isNormalBehavior(e.message) ? (
                                <span className="mark-ok-done" title="Already marked as normal behavior">✓ Normal</span>
                              ) : (
                                <button
                                  className="btn btn-sm btn-mark-ok"
                                  onClick={(ev) => { ev.stopPropagation(); openMarkOkModal(e.id, e.message, system.id); }}
                                  title="Mark this event pattern as normal behavior — future similar events will be ignored by AI"
                                >
                                  Mark OK
                                </button>
                              )
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>

          {events.length >= 200 && (
            <p className="truncation-notice">
              Showing the latest 200 events. Use the API for full access.
            </p>
          )}
        </div>
      )}

      {!loading && events.length === 0 && (
        <div className="empty-state">
          {(filterSeverity.length > 0 || filterHost.length > 0 || filterProgram.length > 0 || filterService.length > 0 || filterFacility.length > 0) ? (
            <>
              <h3>No matching events</h3>
              <p>No events match the current filters. Try adjusting or clearing the filters.</p>
            </>
          ) : (
            <>
              <h3>No events</h3>
              <p>No events found for this system yet.</p>
            </>
          )}
        </div>
      )}

      {/* ── Mark as Normal Behavior Modal ── */}
      {markOkModal && (
        <div className="modal-overlay" onClick={() => !markOkLoading && setMarkOkModal(null)}>
          <div className="modal-content mark-ok-modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>Mark as Normal Behavior</h3>
            <p className="mark-ok-description">
              Future events matching this pattern will be treated as normal behavior
              and excluded from AI scoring and analysis.
            </p>

            <div className="mark-ok-original">
              <label>Original message:</label>
              <pre className="mark-ok-message">{markOkModal.message}</pre>
            </div>

            {markOkLoading && !markOkPreview && (
              <div className="settings-loading"><div className="spinner" /> Generating pattern…</div>
            )}

            {markOkPreview && (
              <div className="mark-ok-pattern-section">
                <label htmlFor="mark-ok-pattern-input">
                  Pattern template (<code>*</code> = matches anything):
                </label>
                <textarea
                  id="mark-ok-pattern-input"
                  className="mark-ok-pattern-input"
                  value={markOkPattern}
                  onChange={(ev) => setMarkOkPattern(ev.target.value)}
                  rows={3}
                  disabled={markOkLoading}
                />
                <p className="mark-ok-hint">
                  You can edit the pattern above. Use <code>*</code> for variable parts
                  (ports, IPs, device names, numbers).
                </p>
              </div>
            )}

            {markOkError && <div className="error-msg" role="alert">{markOkError}</div>}
            {markOkSuccess && <div className="success-msg" role="status">{markOkSuccess}</div>}

            <div className="mark-ok-actions">
              <button
                className="btn btn-outline"
                onClick={() => setMarkOkModal(null)}
                disabled={markOkLoading}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleMarkOkConfirm}
                disabled={markOkLoading || !markOkPattern.trim() || !!markOkSuccess}
              >
                {markOkLoading ? 'Saving…' : 'Confirm — Mark as Normal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Safely format a date as DD-MM-YYYY HH:MM:SS (EU format). */
function safeDate(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
  } catch {
    return ts;
  }
}

/** Score colour matching ScoreBar's logic. */
function scoreColorFromValue(value: number): string {
  if (value >= 0.75) return 'var(--red)';
  if (value >= 0.5) return 'var(--orange)';
  if (value >= 0.25) return 'var(--yellow)';
  return 'var(--green)';
}
