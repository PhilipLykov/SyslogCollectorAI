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
  checkReEvaluateStatus,
  recalculateScores,
  type NormalBehaviorTemplate,
  type NormalBehaviorPreview,
  fetchDashboardConfig,
  acknowledgeEventGroup,
  fetchEventsByIds,
  type EventDetail,
} from '../api';
import { ScoreBars, CRITERIA_LABELS } from './ScoreBar';
import { AskAiPanel } from './AskAiPanel';
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
  const [meta, setMeta] = useState<MetaResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    host?: string;
    program?: string;
  } | null>(null);
  const [markOkPreview, setMarkOkPreview] = useState<NormalBehaviorPreview | null>(null);
  const [markOkPattern, setMarkOkPattern] = useState('');
  const [markOkHostPattern, setMarkOkHostPattern] = useState('');
  const [markOkProgramPattern, setMarkOkProgramPattern] = useState('');
  const [markOkLoading, setMarkOkLoading] = useState(false);
  const [markOkError, setMarkOkError] = useState('');
  const [markOkSuccess, setMarkOkSuccess] = useState('');

  // ── Re-evaluate meta-analysis state ─────────────────────
  const [reEvalLoading, setReEvalLoading] = useState(false);
  const [reEvalMsg, setReEvalMsg] = useState('');
  const reEvalPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // ── Recalculate scores state (fast, no LLM) ────────────
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState('');

  // ── Proof event modal (for events not in the loaded list) ──
  const [proofEvent, setProofEvent] = useState<LogEvent | null>(null);
  const [proofEventLoading, setProofEventLoading] = useState(false);

  // ── Event detail modal (from criterion drill-down) ──────
  const [detailEvent, setDetailEvent] = useState<EventDetail | null>(null);
  const [detailEventLoading, setDetailEventLoading] = useState(false);
  const [detailEventNotFound, setDetailEventNotFound] = useState(false);

  // ── Per-group Ack state ──────────────────────────────────
  const ackingGroupKeys = useRef(new Set<string>());
  const [, forceAckRender] = useState(0);
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  // ── Finding proof events (Show Events) ───────────────────
  const [findingProofEvents, setFindingProofEvents] = useState<EventDetail[]>([]);
  const [findingProofLoading, setFindingProofLoading] = useState<string | null>(null);
  const [findingProofShown, setFindingProofShown] = useState<string | null>(null);

  // ── Dashboard config (score display window label) ─────
  const [scoreWindowDays, setScoreWindowDays] = useState(7);

  // ── Normal behavior templates (for hiding "Mark OK" on already-matched events) ──
  const [normalTemplates, setNormalTemplates] = useState<NormalBehaviorTemplate[]>([]);
  const normalRegexes = useRef<Array<{
    regex: RegExp; hostRegex: RegExp | null; programRegex: RegExp | null; id: string;
  }>>([]);

  /** Compile a set of normal-behavior templates into regex entries. */
  function compileNormalTemplates(templates: NormalBehaviorTemplate[]) {
    const compiled: Array<{
      regex: RegExp; hostRegex: RegExp | null; programRegex: RegExp | null; id: string;
    }> = [];
    for (const t of templates) {
      if (!t.enabled) continue;
      try {
        const regex = new RegExp(t.pattern_regex, 'i');
        let hostRegex: RegExp | null = null;
        let programRegex: RegExp | null = null;
        if (t.host_pattern) try { hostRegex = new RegExp(t.host_pattern, 'i'); } catch { /* skip */ }
        if (t.program_pattern) try { programRegex = new RegExp(t.program_pattern, 'i'); } catch { /* skip */ }
        compiled.push({ regex, hostRegex, programRegex, id: t.id });
      } catch { /* skip invalid regex */ }
    }
    return compiled;
  }

  // Build compiled regexes when templates change
  useEffect(() => {
    normalRegexes.current = compileNormalTemplates(normalTemplates);
  }, [normalTemplates]);

  /**
   * Loads normal-behavior templates and compiles regexes.
   * Returns the fetched templates so callers can use them immediately
   * without waiting for a React re-render cycle.
   */
  const loadNormalTemplates = useCallback(async (): Promise<NormalBehaviorTemplate[]> => {
    try {
      const templates = await fetchNormalBehaviorTemplates({ system_id: system.id, enabled: 'true' });
      setNormalTemplates(templates);
      normalRegexes.current = compileNormalTemplates(templates);
      return templates;
    } catch {
      return [];
    }
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
  const isNormalBehavior = useCallback((message: string, host?: string, program?: string): boolean => {
    for (const entry of normalRegexes.current) {
      if (!entry.regex.test(message)) continue;
      if (entry.hostRegex && !entry.hostRegex.test(host ?? '')) continue;
      if (entry.programRegex && !entry.programRegex.test(program ?? '')) continue;
      return true;
    }
    return false;
  }, []);

  // Stable reference for auth error handler
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  // ── Load meta-analysis summary ─────────────────────────
  const loadData = useCallback(() => {
    setLoading(true);
    setError('');
    fetchSystemMeta(system.id)
      .then((m) => setMeta(m))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Authentication')) {
          onAuthErrorRef.current();
          return;
        }
        if (msg.includes('No meta result') || msg.includes('No windows found')) {
          setMeta(null);
          return;
        }
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [system.id]);

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


  // ── Auto-refresh findings ───────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      loadFindings();
    }, FINDINGS_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [loadFindings]);

  // Cleanup: cancel re-evaluate poll and mark unmounted
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (reEvalPollRef.current) clearTimeout(reEvalPollRef.current);
    };
  }, []);

  // Move focus to heading on mount for accessibility
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /** Build plain-text from an EventScoreRecord (criterion drill-down row). */
  const scoreRecordToText = (ev: EventScoreRecord): string => {
    const lines: string[] = [
      `Event ID:    ${ev.event_id}`,
      `Timestamp:   ${safeDate(ev.timestamp)}`,
      `System:      ${system.name}`,
      `Criterion:   ${ev.criterion_name} (${ev.criterion_slug})`,
      `Score:       ${Math.round((Number(ev.score) || 0) * 100)}%`,
      `Severity:    ${ev.severity ?? '—'}`,
      `Host:        ${ev.host ?? '—'}`,
      `Source IP:   ${ev.source_ip ?? '—'}`,
      `Program:     ${ev.program ?? '—'}`,
    ];
    if (ev.reason_codes?.length) lines.push(`Reasons:     ${ev.reason_codes.join(', ')}`);
    lines.push('', '--- Message ---', ev.message);
    return lines.join('\n');
  };

  /** Build plain-text from a GroupedEventScoreRecord (criterion group row). */
  const groupRecordToText = (grp: GroupedEventScoreRecord): string => {
    const lines: string[] = [
      `System:      ${system.name}`,
      `Criterion:   ${grp.criterion_name} (${grp.criterion_slug})`,
      `Score:       ${Math.round((Number(grp.score) || 0) * 100)}%`,
      `Occurrences: ${grp.occurrence_count}`,
      `First seen:  ${safeDate(grp.first_seen)}`,
      `Last seen:   ${safeDate(grp.last_seen)}`,
      `Severity:    ${grp.severity ?? '—'}`,
      `Hosts:       ${grp.hosts.length > 0 ? grp.hosts.join(', ') : '—'}`,
      `Source IPs:  ${grp.source_ips.length > 0 ? grp.source_ips.join(', ') : '—'}`,
      `Program:     ${grp.program ?? '—'}`,
    ];
    if (grp.reason_codes?.length) lines.push(`Reasons:     ${grp.reason_codes.join(', ')}`);
    lines.push('', '--- Message Pattern ---', grp.message);
    return lines.join('\n');
  };

  /** Copy text to clipboard with fallback. */
  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
  };

  /** Open event detail modal — fetch full event by ID. */
  const openEventDetail = useCallback(async (eventId: string) => {
    setDetailEventLoading(true);
    setDetailEvent(null);
    setDetailEventNotFound(false);
    try {
      const res = await fetchEventsByIds([eventId]);
      if (res.events.length > 0) {
        setDetailEvent(res.events[0]);
      } else {
        setDetailEventNotFound(true);
      }
    } catch {
      setDetailEventNotFound(true);
    } finally {
      setDetailEventLoading(false);
    }
  }, []);

  /** Open event detail for a grouped row (single-event group).
   *  Fetches the group's events first to obtain the real event_id. */
  const openGroupEventDetail = useCallback(async (grp: GroupedEventScoreRecord) => {
    setDetailEventLoading(true);
    setDetailEvent(null);
    setDetailEventNotFound(false);
    const criterion = CRITERIA.find((c) => c.slug === grp.criterion_slug);
    try {
      const events = await fetchGroupedEventDetails(system.id, grp.group_key, {
        criterion_id: criterion?.id,
        limit: 1,
      });
      if (events.length > 0) {
        const res = await fetchEventsByIds([events[0].event_id]);
        if (res.events.length > 0) {
          setDetailEvent(res.events[0]);
        } else {
          setDetailEventNotFound(true);
        }
      } else {
        setDetailEventNotFound(true);
      }
    } catch {
      setDetailEventNotFound(true);
    } finally {
      setDetailEventLoading(false);
    }
  }, [system.id]);

  /** Build plain-text from an EventDetail for clipboard copy. */
  const eventDetailToText = (ev: EventDetail): string => {
    const lines: string[] = [
      `Event ID:    ${ev.id}`,
      `Timestamp:   ${safeDate(ev.timestamp)}`,
      `System:      ${system.name}`,
      `Severity:    ${ev.severity ?? '—'}`,
      `Host:        ${ev.host ?? '—'}`,
      `Source IP:   ${ev.source_ip ?? '—'}`,
      `Program:     ${ev.program ?? '—'}`,
    ];
    if (ev.acknowledged_at) lines.push(`Acknowledged: ${safeDate(ev.acknowledged_at)}`);
    lines.push('', '--- Message ---', ev.message);
    return lines.join('\n');
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
        show_acknowledged: showAcknowledged,
      });
      // Filter out events already marked as normal behavior (defense-in-depth:
      // scores may not be zeroed yet if retroactive update didn't match)
      setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
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
  }, [selectedCriterion, system.id, isNormalBehavior, showAcknowledged]);

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
      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setBulkAckMsg(`Error: ${msg}`);
      setTimeout(() => setBulkAckMsg(''), 5000);
    } finally {
      setBulkAcking(false);
    }
  }, [findings, system.name, onRefreshSystem]);

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

      // Refresh criterion groups if a drill-down is open
      if (selectedCriterion) {
        const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
        if (criterion) {
          try {
            const data = await fetchGroupedEventScores(system.id, {
              criterion_id: criterion.id,
              limit: 50,
              min_score: 0.001,
              show_acknowledged: showAcknowledged,
            });
            setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
            setExpandedGroup(null);
            setExpandedGroupEvents([]);
          } catch { /* ignore refresh error */ }
        }
      }

      // Refresh meta-analysis, findings, and parent scores
      loadData();
      loadFindings();
      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setBulkAckMsg(`Error: ${msg}`);
      setTimeout(() => setBulkAckMsg(''), 5000);
    } finally {
      setBulkAcking(false);
    }
  }, [system.id, system.name, selectedCriterion, showAcknowledged, isNormalBehavior, loadData, loadFindings, onRefreshSystem]);

  // ── Mark as Normal Behavior ────────────────────────────
  const openMarkOkModal = useCallback(async (
    eventIdOrUndef: string | undefined,
    message: string,
    systemId?: string,
    host?: string,
    program?: string,
  ) => {
    setMarkOkModal({ eventId: eventIdOrUndef, message, systemId, host, program });
    setMarkOkPreview(null);
    setMarkOkPattern('');
    setMarkOkHostPattern('');
    setMarkOkProgramPattern('');
    setMarkOkError('');
    setMarkOkSuccess('');
    setMarkOkLoading(true);
    try {
      const preview = eventIdOrUndef
        ? await previewNormalBehavior({ event_id: eventIdOrUndef, host, program })
        : await previewNormalBehavior({ message, host, program });
      setMarkOkPreview(preview);
      setMarkOkPattern(preview.suggested_pattern);
      setMarkOkHostPattern(preview.suggested_host_pattern ?? '');
      setMarkOkProgramPattern(preview.suggested_program_pattern ?? '');
    } catch {
      try {
        const preview = await previewNormalBehavior({ message, host, program });
        setMarkOkPreview(preview);
        setMarkOkPattern(preview.suggested_pattern);
        setMarkOkHostPattern(preview.suggested_host_pattern ?? '');
        setMarkOkProgramPattern(preview.suggested_program_pattern ?? '');
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
        host_pattern: markOkHostPattern.trim() || null,
        program_pattern: markOkProgramPattern.trim() || null,
        message: !markOkModal.eventId ? markOkModal.message : undefined,
        host: markOkModal.host,
        program: markOkModal.program,
      });
      setMarkOkSuccess('Template created. Scores will update shortly. Future matching events will be treated as normal behavior.');
      setTimeout(() => {
        setMarkOkModal(null);
        setMarkOkSuccess('');
      }, 2500);

      await loadNormalTemplates();

      if (selectedCriterion) {
        const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
        if (criterion) {
          try {
            const data = await fetchGroupedEventScores(system.id, {
              criterion_id: criterion.id,
              limit: 50,
              min_score: 0.001,
              show_acknowledged: showAcknowledged,
            });
            setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
            setExpandedGroup(null);
            setExpandedGroupEvents([]);
          } catch { /* ignore refresh error */ }
        }
      }

      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setMarkOkError(`Error: ${msg}`);
    } finally {
      setMarkOkLoading(false);
    }
  }, [markOkModal, markOkPattern, markOkHostPattern, markOkProgramPattern, system.id, selectedCriterion, onRefreshSystem, loadNormalTemplates, isNormalBehavior, showAcknowledged]);

  // Refs for values needed inside the poll closure (avoid stale captures)
  const selectedCriterionRef = useRef(selectedCriterion);
  selectedCriterionRef.current = selectedCriterion;
  const showAcknowledgedRef = useRef(showAcknowledged);
  showAcknowledgedRef.current = showAcknowledged;

  // ── Re-evaluate meta-analysis handler ───────────────────
  const handleReEvaluate = useCallback(async () => {
    if (reEvalLoading) return;
    if (!window.confirm(
      'Re-evaluate meta-analysis for this system?\n\nThis will run a fresh AI analysis on recent events. Progress will be shown below.',
    )) return;

    setReEvalLoading(true);
    setReEvalMsg('Processing...');
    try {
      const res = await reEvaluateSystem(system.id);
      if (!res.jobId) {
        if (mountedRef.current) {
          setReEvalMsg(res.message || 'Done.');
          setTimeout(() => { if (mountedRef.current) setReEvalMsg(''); }, 5000);
          setReEvalLoading(false);
        }
        return;
      }

      const jobId = res.jobId;
      const poll = async () => {
        if (!mountedRef.current) return;
        try {
          const status = await checkReEvaluateStatus(system.id, jobId);
          if (!mountedRef.current) return;

          if (status.status === 'processing') {
            setReEvalMsg(`Analyzing... ${status.elapsed_seconds ?? 0}s elapsed`);
            reEvalPollRef.current = setTimeout(poll, 3000);
            return;
          }
          if (status.status === 'error') {
            setReEvalMsg(`Error: ${status.error ?? 'Unknown error'}`);
            setTimeout(() => { if (mountedRef.current) setReEvalMsg(''); }, 10000);
            setReEvalLoading(false);
            return;
          }
          // Done — use refs to read current values (not stale closure captures)
          setReEvalMsg(status.message || 'Re-evaluation complete.');
          setTimeout(() => { if (mountedRef.current) setReEvalMsg(''); }, 5000);

          const curCriterion = selectedCriterionRef.current;
          if (curCriterion) {
            const criterion = CRITERIA.find((c) => c.slug === curCriterion);
            if (criterion) {
              try {
                const data = await fetchGroupedEventScores(system.id, {
                  criterion_id: criterion.id,
                  limit: 50,
                  min_score: 0.001,
                  show_acknowledged: showAcknowledgedRef.current,
                });
                if (mountedRef.current) {
                  setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
                  setExpandedGroup(null);
                  setExpandedGroupEvents([]);
                }
              } catch { /* ignore */ }
            }
          }
          try {
            const freshMeta = await fetchSystemMeta(system.id);
            if (mountedRef.current && freshMeta) setMeta(freshMeta);
          } catch { /* ignore */ }
          loadFindings();
          onRefreshSystem?.();
          if (mountedRef.current) setReEvalLoading(false);
        } catch (err: unknown) {
          if (!mountedRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
          setReEvalMsg(`Error: ${msg}`);
          setTimeout(() => { if (mountedRef.current) setReEvalMsg(''); }, 10000);
          setReEvalLoading(false);
        }
      };
      reEvalPollRef.current = setTimeout(poll, 3000);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setReEvalMsg(`Error: ${msg}`);
      setTimeout(() => { if (mountedRef.current) setReEvalMsg(''); }, 10000);
      setReEvalLoading(false);
    }
  }, [reEvalLoading, system.id, onRefreshSystem, loadFindings, isNormalBehavior]);

  // ── Recalculate scores handler (fast, no LLM) ──────────
  const handleRecalculate = useCallback(async () => {
    if (recalcLoading) return;
    setRecalcLoading(true);
    setRecalcMsg('');
    try {
      const res = await recalculateScores(system.id);
      setRecalcMsg(`Recalculated (${res.updated_rows} rows)`);
      setTimeout(() => setRecalcMsg(''), 5000);

      if (selectedCriterion) {
        const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
        if (criterion) {
          try {
            const data = await fetchGroupedEventScores(system.id, {
              criterion_id: criterion.id,
              limit: 50,
              min_score: 0.001,
              show_acknowledged: showAcknowledged,
            });
            setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
            setExpandedGroup(null);
            setExpandedGroupEvents([]);
          } catch { /* ignore */ }
        }
      }

      onRefreshSystem?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setRecalcMsg(`Error: ${msg}`);
      setTimeout(() => setRecalcMsg(''), 6000);
    } finally {
      setRecalcLoading(false);
    }
  }, [recalcLoading, system.id, selectedCriterion, onRefreshSystem, isNormalBehavior, showAcknowledged]);

  // ── Per-group Ack handler ───────────────────────────────
  const handleAckGroup = useCallback(async (groupKey: string) => {
    if (ackingGroupKeys.current.has(groupKey)) return;
    ackingGroupKeys.current.add(groupKey);
    forceAckRender((n) => n + 1);
    try {
      await acknowledgeEventGroup({ system_id: system.id, group_key: groupKey });
      if (!showAcknowledged) {
        setCriterionGroups((prev) => prev.filter((g) => g.group_key !== groupKey));
      } else {
        setCriterionGroups((prev) =>
          prev.map((g) => (g.group_key === groupKey ? { ...g, acknowledged: true } : g)),
        );
      }
      onRefreshSystem?.();
      loadFindings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      alert(`Ack failed: ${msg}`);
    } finally {
      ackingGroupKeys.current.delete(groupKey);
      forceAckRender((n) => n + 1);
    }
  }, [system.id, showAcknowledged, onRefreshSystem, loadFindings]);

  // ── Show Events for a finding (fetch by key_event_ids) ──
  const handleShowFindingEvents = useCallback(async (findingId: string, keyEventIds: string[]) => {
    // Toggle off if already showing this finding's events
    if (findingProofShown === findingId) {
      setFindingProofShown(null);
      setFindingProofEvents([]);
      return;
    }
    setFindingProofLoading(findingId);
    setFindingProofShown(findingId);
    setFindingProofEvents([]);
    try {
      const resp = await fetchEventsByIds(keyEventIds.slice(0, 50));
      setFindingProofEvents(resp.events);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthErrorRef.current(); return; }
      setFindingProofShown(null);
      alert(`Failed to load events: ${msg}`);
    } finally {
      setFindingProofLoading(null);
    }
  }, [findingProofShown]);

  // ── Compute filtered findings ───────────────────────────
  const openFindings = findings.filter((f) => f.status === 'open');
  const ackedFindings = findings.filter((f) => f.status === 'acknowledged');
  const resolvedFindings = findings.filter((f) => f.status === 'resolved');
  const displayedFindings =
    findingsTab === 'open' ? openFindings :
    findingsTab === 'acknowledged' ? ackedFindings :
    resolvedFindings;

  const findingsPanelRef = useRef<HTMLDivElement>(null);

  const truncateMsg = (msg: string, max = 500) =>
    msg.length > max ? msg.slice(0, max) + ' \u2026' : msg;

  // Severity breakdown for the banner (only count OPEN findings — acked are handled)
  const severityBreakdown = openFindings.reduce<Record<string, number>>((acc, f) => {
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
      {/* Only show the alarming banner when there are OPEN findings.
          If all findings are acknowledged, the user has already handled them. */}
      {!findingsLoading && openFindings.length > 0 && (
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
            {openFindings.length} open issue{openFindings.length !== 1 ? 's' : ''}
            {ackedFindings.length > 0 && (
              <span className="active-issues-detail">
                {' '}(+ {ackedFindings.length} ack'd)
              </span>
            )}
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
                  <>
                    <label className="show-acked-toggle" title="Show acknowledged events (muted)">
                      <input
                        type="checkbox"
                        checked={showAcknowledged}
                        onChange={(e) => {
                          setShowAcknowledged(e.target.checked);
                          // Re-fetch with the new toggle
                          const criterion = CRITERIA.find((c) => c.slug === selectedCriterion);
                          if (criterion) {
                            fetchGroupedEventScores(system.id, {
                              criterion_id: criterion.id,
                              limit: 50,
                              min_score: 0.001,
                              show_acknowledged: e.target.checked,
                            }).then((data) => {
                              setCriterionGroups(data.filter((g) => !isNormalBehavior(g.message, g.hosts?.[0], g.program ?? undefined)));
                            }).catch(() => { /* ignore */ });
                          }
                        }}
                      />
                      Show ack'd
                    </label>
                    <button
                      className="btn btn-xs btn-primary"
                      onClick={handleRecalculate}
                      disabled={recalcLoading}
                      title="Recalculate scores from existing data (fast, no LLM call)"
                    >
                      {recalcLoading ? 'Recalculating…' : 'Recalculate'}
                    </button>
                  </>
                )}
                <button
                  className="btn btn-xs btn-outline"
                  onClick={() => { setSelectedCriterion(null); setCriterionGroups([]); setExpandedGroup(null); setExpandedGroupEvents([]); }}
                >
                  Close
                </button>
              </div>
            </div>
            {recalcMsg && (
              <div className={`reeval-msg${recalcMsg.startsWith('Error') ? ' reeval-error' : ''}`}>
                {recalcMsg}
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
                      {hasPermission(currentUser ?? null, 'events:acknowledge') && <th style={{ width: '160px' }}>Actions</th>}
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
                            className={`criterion-event-row criterion-group-row${isExpanded ? ' criterion-group-expanded' : ''}${hasMultiple ? ' criterion-group-clickable' : ''}${grp.acknowledged ? ' group-acknowledged' : ''}`}
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
                            <td
                              className={`criterion-message-cell${!hasMultiple ? ' criterion-message-clickable' : ''}`}
                              onClick={!hasMultiple ? (ev) => { ev.stopPropagation(); openGroupEventDetail(grp); } : undefined}
                              title={!hasMultiple ? 'Click to view full event details' : undefined}
                            >
                              {truncateMsg(grp.message)}
                            </td>
                            {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                              <td className="criterion-actions-cell">
                                {grp.acknowledged ? (
                                  <>
                                    <span className="ack-done-label" title="This event group has been acknowledged">Ack&apos;d</span>
                                    <button
                                      className={`btn btn-xs ${copiedId === grp.group_key ? 'btn-success-outline' : 'btn-outline'}`}
                                      onClick={(ev) => { ev.stopPropagation(); copyToClipboard(groupRecordToText(grp), grp.group_key); }}
                                      title="Copy event group details to clipboard"
                                    >
                                      {copiedId === grp.group_key ? '✓' : 'Copy'}
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    {isNormalBehavior(grp.message, grp.hosts?.[0], grp.program ?? undefined) ? (
                                      <span className="mark-ok-done" title="Already marked as normal behavior">✓ Normal</span>
                                    ) : (
                                      <button
                                        className="btn btn-xs btn-mark-ok"
                                        onClick={(ev) => { ev.stopPropagation(); openMarkOkModal(undefined, grp.message, system.id, grp.hosts?.[0], grp.program ?? undefined); }}
                                        title="Mark this event pattern as normal behavior"
                                      >
                                        Mark OK
                                      </button>
                                    )}
                                    <button
                                      className="btn btn-xs btn-ack-group"
                                      onClick={(ev) => { ev.stopPropagation(); handleAckGroup(grp.group_key); }}
                                      disabled={ackingGroupKeys.current.has(grp.group_key)}
                                      title="Acknowledge this event group — removes from score calculation"
                                    >
                                      {ackingGroupKeys.current.has(grp.group_key) ? '…' : 'Ack'}
                                    </button>
                                    <button
                                      className={`btn btn-xs ${copiedId === grp.group_key ? 'btn-success-outline' : 'btn-outline'}`}
                                      onClick={(ev) => { ev.stopPropagation(); copyToClipboard(groupRecordToText(grp), grp.group_key); }}
                                      title="Copy event group details to clipboard"
                                    >
                                      {copiedId === grp.group_key ? '✓' : 'Copy'}
                                    </button>
                                  </>
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
                                  <td
                                    className="criterion-message-cell criterion-message-clickable"
                                    onClick={() => openEventDetail(ev.event_id)}
                                    title="Click to view full event details"
                                  >
                                    {truncateMsg(ev.message)}
                                  </td>
                                  {hasPermission(currentUser ?? null, 'events:acknowledge') && (
                                    <td className="criterion-actions-cell">
                                      {isNormalBehavior(ev.message, ev.host ?? undefined, ev.program ?? undefined) ? (
                                        <span className="mark-ok-done" title="Already marked as normal behavior">✓ Normal</span>
                                      ) : (
                                        <button
                                          className="btn btn-xs btn-mark-ok"
                                          onClick={() => openMarkOkModal(ev.event_id, ev.message, system.id, ev.host ?? undefined, ev.program ?? undefined)}
                                          title="Mark this event pattern as normal behavior"
                                        >
                                          Mark OK
                                        </button>
                                      )}
                                      <button
                                        className={`btn btn-xs ${copiedId === ev.event_id ? 'btn-success-outline' : 'btn-outline'}`}
                                        onClick={() => copyToClipboard(scoreRecordToText(ev), ev.event_id)}
                                        title="Copy event details to clipboard"
                                      >
                                        {copiedId === ev.event_id ? '✓' : 'Copy'}
                                      </button>
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
      {!loading && (
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
          {meta ? (
            <>
              <div className="meta-summary-body">
                {meta.summary}
              </div>
              {meta.recommended_action && (
                <div className="meta-summary-recommendation">
                  <strong>Recommended:</strong> {meta.recommended_action}
                </div>
              )}
            </>
          ) : (
            <div className="meta-summary-body" style={{ opacity: 0.6, fontStyle: 'italic' }}>
              No AI analysis available yet. Click &ldquo;Re-evaluate&rdquo; to run the initial analysis.
            </div>
          )}
        </div>
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
              {findingsTab === 'open' && (ackedFindings.length > 0
                ? 'No open findings. All issues have been acknowledged.'
                : 'No open findings. The AI has not detected any active issues.')}
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
                                    title={`View event ${eid}`}
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setProofEventLoading(true);
                                      setProofEvent(null);
                                      fetchSystemEvents(system.id, { event_ids: [eid], limit: 1 })
                                        .then((evts) => {
                                          if (evts.length > 0) {
                                            setProofEvent(evts[0]);
                                          } else {
                                            setProofEvent({ id: eid, system_id: system.id, timestamp: '', message: '(Event not found — it may have been deleted by retention.)' } as LogEvent);
                                          }
                                        })
                                        .catch(() => {
                                          setProofEvent({ id: eid, system_id: system.id, timestamp: '', message: '(Failed to load event.)' } as LogEvent);
                                        })
                                        .finally(() => setProofEventLoading(false));
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
                      {/* Show Events button — available on all finding statuses when key_event_ids exist */}
                      {f.key_event_ids && f.key_event_ids.length > 0 && (
                        <button
                          className={`btn btn-xs btn-outline${findingProofShown === f.id ? ' btn-active' : ''}`}
                          onClick={() => handleShowFindingEvents(f.id, f.key_event_ids!)}
                          disabled={findingProofLoading === f.id}
                          title={findingProofShown === f.id ? 'Hide source events' : 'Show the source events that contributed to this finding'}
                        >
                          {findingProofLoading === f.id ? 'Loading\u2026' : findingProofShown === f.id ? 'Hide Events' : `Show Events (${f.key_event_ids.length})`}
                        </button>
                      )}
                    </div>
                    {/* Proof events panel — scoped to this finding only */}
                    {findingProofShown === f.id && findingProofEvents.length > 0 && (
                      <div className="finding-proof-events">
                        <div className="finding-proof-events-list">
                          <h5>Source Events</h5>
                          {findingProofEvents.map((ev) => (
                            <div key={ev.id} className="finding-proof-event">
                              <span className="proof-event-time">{safeDate(ev.timestamp)}</span>
                              <span className={`severity-badge ${(ev.severity || 'info').toLowerCase()}`}>{ev.severity || 'info'}</span>
                              <span className="proof-event-host">{ev.host || '\u2014'}</span>
                              <span className="proof-event-program">{ev.program || '\u2014'}</span>
                              <span className="proof-event-message">{truncateMsg(ev.message)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Section divider ── */}
      <hr className="drilldown-section-divider" />

      {/* ── Ask AI (system-scoped) ── */}
      {hasPermission(currentUser ?? null, 'rag:use') && (
        <AskAiPanel
          fixedSystemId={system.id}
          fixedSystemName={system.name}
          onAuthError={onAuthError}
        />
      )}

      {/* ── Mark as Normal Behavior Modal ── */}
      {/* ── Proof Event Detail Modal ── */}
      {(proofEvent || proofEventLoading) && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !proofEventLoading) { setProofEvent(null); } }}>
          <div className="modal-content proof-event-modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>Proof Event</h3>
            {proofEventLoading ? (
              <div className="settings-loading"><div className="spinner" /> Loading event…</div>
            ) : proofEvent ? (
              <div className="proof-event-detail">
                <table className="proof-event-table">
                  <tbody>
                    <tr><th>ID</th><td><code className="proof-event-id">{proofEvent.id}</code></td></tr>
                    {proofEvent.timestamp && <tr><th>Time</th><td>{safeDate(proofEvent.timestamp)}</td></tr>}
                    {proofEvent.severity && <tr><th>Severity</th><td><span className={`severity-badge ${proofEvent.severity.toLowerCase()}`}>{proofEvent.severity}</span></td></tr>}
                    {proofEvent.host && <tr><th>Host</th><td>{proofEvent.host}</td></tr>}
                    {proofEvent.source_ip && <tr><th>Source IP</th><td>{proofEvent.source_ip}</td></tr>}
                    {proofEvent.program && <tr><th>Program</th><td>{proofEvent.program}</td></tr>}
                    {proofEvent.service && <tr><th>Service</th><td>{proofEvent.service}</td></tr>}
                    {proofEvent.facility && <tr><th>Facility</th><td>{proofEvent.facility}</td></tr>}
                  </tbody>
                </table>
                <div className="proof-event-message-block">
                  <strong>Message:</strong>
                  <pre className="proof-event-message">{proofEvent.message}</pre>
                </div>
              </div>
            ) : null}
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setProofEvent(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Event Detail Modal (from criterion drill-down) ── */}
      {(detailEvent || detailEventLoading || detailEventNotFound) && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !detailEventLoading) { setDetailEvent(null); setDetailEventNotFound(false); } }}>
          <div className="modal-content event-detail-modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>Event Details</h3>
            {detailEventLoading ? (
              <div className="settings-loading"><div className="spinner" /> Loading event…</div>
            ) : detailEvent ? (
              <div className="proof-event-detail">
                <table className="proof-event-table">
                  <tbody>
                    <tr><th>ID</th><td><code className="proof-event-id">{detailEvent.id}</code></td></tr>
                    {detailEvent.timestamp && <tr><th>Time</th><td>{safeDate(detailEvent.timestamp)}</td></tr>}
                    {detailEvent.severity && <tr><th>Severity</th><td><span className={`severity-badge ${detailEvent.severity.toLowerCase()}`}>{detailEvent.severity}</span></td></tr>}
                    {detailEvent.host && <tr><th>Host</th><td>{detailEvent.host}</td></tr>}
                    {detailEvent.source_ip && <tr><th>Source IP</th><td>{detailEvent.source_ip}</td></tr>}
                    {detailEvent.program && <tr><th>Program</th><td>{detailEvent.program}</td></tr>}
                    {detailEvent.acknowledged_at && <tr><th>Acknowledged</th><td>{safeDate(detailEvent.acknowledged_at)}</td></tr>}
                  </tbody>
                </table>
                <div className="proof-event-message-block">
                  <strong>Message:</strong>
                  <pre className="proof-event-message">{detailEvent.message}</pre>
                </div>
              </div>
            ) : (
              <p className="text-secondary">Event not found.</p>
            )}
            <div className="modal-actions">
              {detailEvent && (
                <button
                  className={`btn ${copiedId === `detail-${detailEvent.id}` ? 'btn-success-outline' : 'btn-outline'}`}
                  onClick={() => copyToClipboard(eventDetailToText(detailEvent), `detail-${detailEvent.id}`)}
                  title="Copy full event details to clipboard"
                >
                  {copiedId === `detail-${detailEvent.id}` ? 'Copied!' : 'Copy Event'}
                </button>
              )}
              <button className="btn btn-outline" onClick={() => { setDetailEvent(null); setDetailEventNotFound(false); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {markOkModal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !markOkLoading) setMarkOkModal(null); }}>
          <div className="modal-content mark-ok-modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>Mark as Normal Behavior</h3>
            <p className="mark-ok-description">
              Future events matching these patterns will be treated as normal behavior
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
                  Message pattern (regex):
                </label>
                <textarea
                  id="mark-ok-pattern-input"
                  className="mark-ok-pattern-input"
                  value={markOkPattern}
                  onChange={(ev) => setMarkOkPattern(ev.target.value)}
                  rows={3}
                  disabled={markOkLoading}
                />

                <div className="mark-ok-filter-row">
                  <div className="mark-ok-filter-field">
                    <label htmlFor="mark-ok-host-input">Host pattern (regex, empty = any):</label>
                    <input
                      id="mark-ok-host-input"
                      type="text"
                      className="mark-ok-filter-input"
                      value={markOkHostPattern}
                      onChange={(ev) => setMarkOkHostPattern(ev.target.value)}
                      disabled={markOkLoading}
                      placeholder="e.g. ^myserver$"
                    />
                  </div>
                  <div className="mark-ok-filter-field">
                    <label htmlFor="mark-ok-program-input">Program pattern (regex, empty = any):</label>
                    <input
                      id="mark-ok-program-input"
                      type="text"
                      className="mark-ok-filter-input"
                      value={markOkProgramPattern}
                      onChange={(ev) => setMarkOkProgramPattern(ev.target.value)}
                      disabled={markOkLoading}
                      placeholder="e.g. ^postgres$"
                    />
                  </div>
                </div>

                <details className="mark-ok-regex-ref">
                  <summary>Regex quick reference</summary>
                  <table className="regex-ref-table">
                    <tbody>
                      <tr><td><code>{'.*'}</code></td><td>any text (including empty)</td></tr>
                      <tr><td><code>{'.+'}</code></td><td>any text (at least one character)</td></tr>
                      <tr><td><code>{'[^ ]+'}</code></td><td>any non-space word</td></tr>
                      <tr><td><code>{'[0-9]+'}</code></td><td>one or more digits</td></tr>
                      <tr><td><code>{'[0-9a-f]+'}</code></td><td>hex value</td></tr>
                      <tr><td><code>{'[a-zA-Z]+'}</code></td><td>one or more letters</td></tr>
                      <tr><td><code>{'\\.'}</code></td><td>literal dot (unescaped <code>.</code> = any character)</td></tr>
                      <tr><td><code>{'^...$'}</code></td><td>anchors: match entire string from start to end</td></tr>
                      <tr><td><code>{'(a|b)'}</code></td><td>either "a" or "b"</td></tr>
                      <tr><td><code>{'?'}</code></td><td>previous element is optional</td></tr>
                    </tbody>
                  </table>
                  <p className="mark-ok-hint" style={{ marginTop: '0.3rem' }}>
                    The auto-generated pattern replaces variable data (IPs, numbers, IDs)
                    with simple placeholders. You can edit the pattern before saving.
                    Leave host/program empty to match all.
                  </p>
                </details>
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
