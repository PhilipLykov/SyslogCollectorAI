import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import {
  type LlmAdapter,
  type ScoreResult,
  type MetaAnalysisContext,
} from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';
import { CRITERIA } from '../../types/index.js';
import { resolveCustomPrompts } from '../llm/aiConfig.js';
import { loadTokenOptConfig } from './scoringJob.js';
import {
  deduplicateFindings,
  computeFingerprint,
  isHigherSeverity,
  jaccardSimilarity,
  type OpenFinding,
} from './findingDedup.js';
import { loadPrivacyFilterConfig, filterMetaEventForLlm } from '../llm/llmPrivacyFilter.js';
import { getEventSource } from '../../services/eventSourceFactory.js';

const DEFAULT_W_META = 0.7;
/** Number of previous window summaries to include as context. */
const CONTEXT_WINDOW_SIZE = 5;

// ── Meta-analysis configuration defaults ───────────────────────

export interface MetaAnalysisConfig {
  finding_dedup_enabled: boolean;
  finding_dedup_threshold: number;
  max_new_findings_per_window: number;
  /** @deprecated Use severity-tiered auto-resolve settings instead. Kept for backward compat. */
  auto_resolve_after_misses: number;
  severity_decay_enabled: boolean;
  severity_decay_after_occurrences: number;
  max_open_findings_per_system: number;
  // ── Severity-tiered auto-resolve (consecutive_misses thresholds) ──
  auto_resolve_critical_days: number;
  auto_resolve_high_days: number;
  auto_resolve_medium_days: number;
  auto_resolve_low_hours: number;
  auto_resolve_info_hours: number;
  // ── Flapping detection ──
  flapping_threshold: number;       // reopens before marking as flapping
  flapping_lookback_days: number;   // how far back to search for resolved findings
}

const META_CONFIG_DEFAULTS: MetaAnalysisConfig = {
  finding_dedup_enabled: true,
  finding_dedup_threshold: 0.6,
  max_new_findings_per_window: 5,
  auto_resolve_after_misses: 0, // Disabled — superseded by severity-tiered settings
  severity_decay_enabled: true,
  severity_decay_after_occurrences: 10,
  max_open_findings_per_system: 25,
  // Severity-tiered auto-resolve defaults
  auto_resolve_critical_days: 14,
  auto_resolve_high_days: 7,
  auto_resolve_medium_days: 3,
  auto_resolve_low_hours: 24,
  auto_resolve_info_hours: 6,
  // Flapping detection defaults
  flapping_threshold: 3,
  flapping_lookback_days: 14,
};

/** Convert severity-tiered days/hours to consecutive_misses count (5-min windows). */
function severityAutoResolveMisses(severity: string, cfg: MetaAnalysisConfig): number {
  switch (severity) {
    case 'critical': return cfg.auto_resolve_critical_days * 24 * 12;  // days → 5-min windows
    case 'high':     return cfg.auto_resolve_high_days * 24 * 12;
    case 'medium':   return cfg.auto_resolve_medium_days * 24 * 12;
    case 'low':      return cfg.auto_resolve_low_hours * 12;           // hours → 5-min windows
    case 'info':     return cfg.auto_resolve_info_hours * 12;
    default:         return cfg.auto_resolve_medium_days * 24 * 12;    // fallback to medium
  }
}

/** Escalate severity by one level (for flapping detection). */
function escalateSeverity(severity: string): string {
  const escalation: Record<string, string> = {
    info: 'low',
    low: 'medium',
    medium: 'high',
    high: 'critical',
  };
  return escalation[severity] ?? severity;
}

/** Load meta-analysis config from app_config, with defaults. */
export async function loadMetaAnalysisConfig(db: Knex): Promise<MetaAnalysisConfig> {
  try {
    const row = await db('app_config').where({ key: 'meta_analysis_config' }).first();
    if (row) {
      let parsed = row.value;
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      return { ...META_CONFIG_DEFAULTS, ...(parsed as Partial<MetaAnalysisConfig>) };
    }
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to load meta_analysis_config:`, err);
  }
  return { ...META_CONFIG_DEFAULTS };
}

/** Extended open finding — includes internal DB fields used within the pipeline. */
interface ExtendedOpenFinding {
  index: number; text: string; severity: string; criterion?: string;
  status?: string; created_at?: string; last_seen_at?: string;
  occurrence_count?: number; reopen_count?: number; is_flapping?: boolean;
  _dbId: string; _fingerprint?: string; _occurrence_count: number; _consecutive_misses: number;
}

/** Extended context type returned by buildMetaContext — includes _dbId etc. */
interface ExtendedMetaContext extends MetaAnalysisContext {
  openFindings: ExtendedOpenFinding[];
}

// ── Severity decay helpers ─────────────────────────────────────

const SEVERITY_DECAY_MAP: Record<string, string> = {
  critical: 'high',
  high: 'medium',
  // medium and below: no decay
};

function decaySeverity(severity: string): string | null {
  return SEVERITY_DECAY_MAP[severity] ?? null;
}

/**
 * Meta-analyze a window: gather events + scores, build historical context,
 * call LLM, store meta_results + findings, compute effective scores.
 *
 * Enhanced with:
 *   - TF-IDF cosine / Jaccard finding deduplication (post-LLM safety net)
 *   - Auto-resolution of stale findings (consecutive_misses)
 *   - Severity decay for persistent non-escalating findings
 *   - Max open findings cap with priority eviction
 */
export async function metaAnalyzeWindow(
  db: Knex,
  llm: LlmAdapter,
  windowId: string,
  options?: { wMeta?: number },
): Promise<void> {
  const wMeta = options?.wMeta ?? DEFAULT_W_META;

  const window = await db('windows').where({ id: windowId }).first();
  if (!window) throw new Error(`Window ${windowId} not found`);

  const system = await db('monitored_systems').where({ id: window.system_id }).first();
  if (!system) throw new Error(`System ${window.system_id} not found`);

  const sources = await db('log_sources').where({ system_id: system.id }).select('label');
  const sourceLabels = sources.map((s: any) => s.label);

  // Resolve custom system prompt (if configured by user)
  const customPrompts = await resolveCustomPrompts(db);

  // ── Resolve token optimisation config ───────────────────
  const tokenOpt = await loadTokenOptConfig(db);
  const metaMaxEvents = Math.max(10, Math.min(tokenOpt.meta_max_events, 2000));
  const prioritizeHighScores = tokenOpt.meta_prioritize_high_scores;

  // ── Resolve meta-analysis config ────────────────────────
  const metaCfg = await loadMetaAnalysisConfig(db);

  // ── Resolve event ack config ────────────────────────────
  const ackRows = await db('app_config')
    .whereIn('key', ['event_ack_mode', 'event_ack_prompt'])
    .select('key', 'value');
  const ackCfg: Record<string, string> = {};
  for (const row of ackRows) {
    let v = row.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* ok */ } }
    if (typeof v === 'string') ackCfg[row.key] = v;
  }
  const ackMode = ackCfg['event_ack_mode'] || 'context_only';
  const ackPrompt = ackCfg['event_ack_prompt'] ||
    'Previously acknowledged by user — use only for pattern recognition context. ' +
    'Do not score, do not raise new findings for these events.';

  // ── Gather events in window — via EventSource abstraction (system-aware) ──
  const eventSource = getEventSource(system, db);
  const events = await eventSource.getEventsInTimeRange(
    system.id,
    window.from_ts,
    window.to_ts,
    {
      limit: metaMaxEvents,
      excludeAcknowledged: ackMode === 'skip',
    },
  );

  if (events.length === 0) {
    console.log(`[${localTimestamp()}] Meta-analyze: no events in window ${windowId}`);
    return;
  }

  // ── Gather per-event scores ─────────────────────────────
  const eventIds = events.map((e: any) => e.id);
  const allScores: any[] = [];
  for (let i = 0; i < eventIds.length; i += 100) {
    const chunk = eventIds.slice(i, i + 100);
    const rows = await db('event_scores')
      .whereIn('event_id', chunk)
      .select('event_id', 'criterion_id', 'score');
    allScores.push(...rows);
  }

  // Build score map: event_id → ScoreResult
  const scoreMap = new Map<string, ScoreResult>();
  for (const row of allScores) {
    if (!scoreMap.has(row.event_id)) {
      scoreMap.set(row.event_id, {
        it_security: 0, performance_degradation: 0, failure_prediction: 0,
        anomaly: 0, compliance_audit: 0, operational_risk: 0,
      });
    }
    const criterion = CRITERIA.find((c) => c.id === Number(row.criterion_id));
    if (criterion) {
      (scoreMap.get(row.event_id)! as any)[criterion.slug] = Number(row.score) || 0;
    }
  }

  // Deduplicate by template for LLM input
  const templateGroups = new Map<string, {
    message: string; severity?: string; count: number;
    scores?: ScoreResult; acknowledged: boolean;
  }>();
  for (const event of events) {
    const key = event.template_id ?? event.id;
    if (!templateGroups.has(key)) {
      templateGroups.set(key, {
        message: event.message,
        severity: event.severity,
        count: 0,
        scores: scoreMap.get(event.id),
        acknowledged: !!event.acknowledged_at,
      });
    }
    templateGroups.get(key)!.count++;
  }

  let eventsForLlm = Array.from(templateGroups.values()).map((g) => {
    // In context_only mode, annotate acknowledged events with the ack prompt
    if (g.acknowledged && ackMode === 'context_only') {
      return {
        message: `[ACK] ${g.message} — ${ackPrompt}`,
        severity: g.severity,
        scores: g.scores,
        occurrenceCount: g.count,
      };
    }
    return {
      message: g.message,
      severity: g.severity,
      scores: g.scores,
      occurrenceCount: g.count,
    };
  });

  // ── Privacy filtering ──────────────────────────────────────
  const privacyConfig = await loadPrivacyFilterConfig(db);
  eventsForLlm = eventsForLlm.map((e) => filterMetaEventForLlm(e, privacyConfig));

  // ── High-score prioritisation ─────────────────────────────
  // Sort by max score descending so the most important events are always
  // included even when the template count exceeds the cap.
  if (prioritizeHighScores && eventsForLlm.length > 1) {
    eventsForLlm = eventsForLlm.sort((a, b) => {
      const safeMax = (s: typeof a.scores) => {
        if (!s) return 0;
        return Math.max(
          Number(s.it_security) || 0, Number(s.performance_degradation) || 0,
          Number(s.failure_prediction) || 0, Number(s.anomaly) || 0,
          Number(s.compliance_audit) || 0, Number(s.operational_risk) || 0,
        );
      };
      return safeMax(b.scores) - safeMax(a.scores); // descending
    });
  }

  // ── Build historical context (sliding window) ───────────
  const context = await buildMetaContext(db, system.id, windowId);

  // ── Call LLM for meta-analysis ──────────────────────────
  const { result, usage } = await llm.metaAnalyze(
    eventsForLlm,
    system.description ?? '',
    sourceLabels,
    context,
    { systemPrompt: customPrompts.metaSystemPrompt },
  );

  // ── Finding deduplication (post-LLM safety net) ─────────
  // Build OpenFinding[] from context for dedup module
  const openFindingsForDedup: OpenFinding[] = context.openFindings.map((f) => ({
    id: f._dbId,
    text: f.text,
    severity: f.severity,
    criterion_slug: f.criterion ?? null,
    fingerprint: f._fingerprint ?? null,
    occurrence_count: f._occurrence_count ?? 1,
    consecutive_misses: f._consecutive_misses ?? 0,
  }));

  let findingsToInsert = result.findings;
  let findingsToUpdate: Awaited<ReturnType<typeof deduplicateFindings>>['toUpdate'] = [];

  if (metaCfg.finding_dedup_enabled && result.findings.length > 0) {
    const dedupResult = deduplicateFindings(
      result.findings,
      openFindingsForDedup,
      metaCfg.finding_dedup_threshold,
      metaCfg.max_new_findings_per_window,
    );
    findingsToInsert = dedupResult.toInsert;
    findingsToUpdate = dedupResult.toUpdate;
  } else if (result.findings.length > metaCfg.max_new_findings_per_window) {
    // Even without dedup, apply the hard cap
    findingsToInsert = result.findings.slice(0, metaCfg.max_new_findings_per_window);
  }

  // Track which open findings were matched (seen in this window)
  const matchedOpenIds = new Set(findingsToUpdate.map((u) => u.id));

  // ── Flapping detection: dedup new findings against recently resolved ──
  // If a new finding matches a recently resolved one, reopen it instead of
  // creating a duplicate. Track reopen_count for flapping detection.
  const findingsToReopen: Array<{
    id: string; newSeverity?: string; reopen_count: number; is_flapping: boolean;
  }> = [];
  const remainingToInsert: typeof findingsToInsert = [];

  if (metaCfg.finding_dedup_enabled && findingsToInsert.length > 0) {
    const lookbackDate = new Date(
      Date.now() - metaCfg.flapping_lookback_days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const resolvedRows = await db('findings')
      .where({ system_id: system.id, status: 'resolved' })
      .where('resolved_at', '>=', lookbackDate)
      .orderBy('resolved_at', 'desc')
      .limit(50)
      .select('id', 'text', 'severity', 'criterion_slug', 'fingerprint',
              'reopen_count', 'is_flapping');

    // Track already-matched resolved IDs to prevent two new findings from
    // reopening the same resolved finding (which would silently drop one).
    const matchedResolvedIds = new Set<string>();

    for (const finding of findingsToInsert) {
      let matched = false;

      if (resolvedRows.length > 0) {
        const fp = computeFingerprint(finding.text);

        // Try fingerprint exact match first
        const fpMatch = resolvedRows.find(
          (rf: any) => rf.fingerprint === fp &&
            !matchedResolvedIds.has(rf.id) &&
            criterionMatchSimple(finding.criterion, rf.criterion_slug),
        );

        if (fpMatch) {
          const newReopenCount = (Number(fpMatch.reopen_count) || 0) + 1;
          const isFlapping = newReopenCount >= metaCfg.flapping_threshold;
          findingsToReopen.push({
            id: fpMatch.id,
            newSeverity: isHigherSeverity(finding.severity, fpMatch.severity) ? finding.severity
              : isFlapping ? escalateSeverity(fpMatch.severity) : undefined,
            reopen_count: newReopenCount,
            is_flapping: isFlapping || Boolean(fpMatch.is_flapping),
          });
          matchedResolvedIds.add(fpMatch.id);
          matched = true;
        }

        // If no fingerprint match, try Jaccard similarity
        if (!matched) {
          for (const rf of resolvedRows) {
            if (matchedResolvedIds.has(rf.id)) continue;
            if (!criterionMatchSimple(finding.criterion, rf.criterion_slug)) continue;
            const sim = jaccardSimilarity(finding.text, rf.text);
            if (sim >= metaCfg.finding_dedup_threshold) {
              const newReopenCount = (Number(rf.reopen_count) || 0) + 1;
              const isFlapping = newReopenCount >= metaCfg.flapping_threshold;
              findingsToReopen.push({
                id: rf.id,
                newSeverity: isHigherSeverity(finding.severity, rf.severity) ? finding.severity
                  : isFlapping ? escalateSeverity(rf.severity) : undefined,
                reopen_count: newReopenCount,
                is_flapping: isFlapping || Boolean(rf.is_flapping),
              });
              matchedResolvedIds.add(rf.id);
              matched = true;
              break;
            }
          }
        }
      }

      if (!matched) {
        remainingToInsert.push(finding);
      }
    }
  } else {
    remainingToInsert.push(...findingsToInsert);
  }

  // Replace findingsToInsert with the remaining ones after flapping dedup
  findingsToInsert = remainingToInsert;

  // ── Persist everything in a transaction ─────────────────
  await db.transaction(async (trx) => {
    // Store meta_result (findings field kept for backward compat / fallback display)
    const metaId = uuidv4();
    await trx('meta_results').insert({
      id: metaId,
      window_id: windowId,
      meta_scores: JSON.stringify(result.meta_scores),
      summary: result.summary,
      findings: JSON.stringify(result.findingsFlat),
      recommended_action: result.recommended_action ?? null,
      key_event_ids: result.key_event_ids ? JSON.stringify(result.key_event_ids) : null,
    });

    // ── Persist NEW findings (after dedup) ────────────────
    const nowIso = new Date().toISOString();
    const newlyInsertedIds: string[] = [];
    for (const finding of findingsToInsert) {
      const newId = uuidv4();
      newlyInsertedIds.push(newId);
      await trx('findings').insert({
        id: newId,
        system_id: system.id,
        meta_result_id: metaId,
        text: finding.text,
        severity: finding.severity,
        criterion_slug: finding.criterion ?? null,
        status: 'open',
        fingerprint: computeFingerprint(finding.text),
        last_seen_at: nowIso,
        occurrence_count: 1,
        consecutive_misses: 0,
        original_severity: finding.severity,
      });
    }

    // ── Update existing findings matched by dedup ─────────
    for (const update of findingsToUpdate) {
      const updateFields: Record<string, any> = {
        last_seen_at: update.newLastSeenAt,
        consecutive_misses: 0, // Reset misses on match
      };
      if (update.incrementOccurrence) {
        updateFields.occurrence_count = trx.raw('occurrence_count + 1');
      }
      if (update.escalateSeverity) {
        updateFields.severity = update.escalateSeverity;
      }
      await trx('findings')
        .where({ id: update.id })
        .whereIn('status', ['open', 'acknowledged'])
        .update(updateFields);
    }

    // ── Reopen resolved findings (flapping detection) ────
    for (const reopen of findingsToReopen) {
      const updateFields: Record<string, any> = {
        status: 'open',
        resolved_at: null,
        resolved_by_meta_id: null,
        resolution_evidence: null,
        last_seen_at: nowIso,
        consecutive_misses: 0,
        occurrence_count: trx.raw('occurrence_count + 1'),
        reopen_count: reopen.reopen_count,
        is_flapping: reopen.is_flapping,
      };
      if (reopen.newSeverity) {
        updateFields.severity = reopen.newSeverity;
      }
      await trx('findings')
        .where({ id: reopen.id, status: 'resolved' })
        .update(updateFields);

      if (reopen.is_flapping) {
        console.log(
          `[${localTimestamp()}] Flapping detected: finding ${reopen.id} ` +
          `reopened ${reopen.reopen_count} times (threshold: ${metaCfg.flapping_threshold})`,
        );
      }
    }

    // ── Mark LLM-resolved findings (with resolution evidence) ──
    if (result.resolvedFindingIndices.length > 0 && context.openFindings.length > 0) {
      for (const resolvedEntry of result.resolvedFindings) {
        const openFinding = context.openFindings.find((f) => f.index === resolvedEntry.index);
        if (!openFinding) continue;
        const dbId = openFinding._dbId;
        if (!dbId) continue;
        await trx('findings')
          .where({ id: dbId })
          .whereIn('status', ['open', 'acknowledged'])
          .update({
            status: 'resolved',
            resolved_at: nowIso,
            resolved_by_meta_id: metaId,
            resolution_evidence: resolvedEntry.evidence ?? null,
          });
      }
    }

    // ── Handle LLM-confirmed "still active" findings ───────
    // The LLM can confirm that an open finding is still active even if no new
    // duplicate finding was emitted.  We reset consecutive_misses for these and
    // refresh last_seen_at so they don't age out.
    const stillActiveDbIds = new Set<string>();
    if (result.stillActiveFindingIndices.length > 0 && context.openFindings.length > 0) {
      for (const idx of result.stillActiveFindingIndices) {
        const openF = context.openFindings.find((f) => f.index === idx);
        if (!openF?._dbId) continue;
        // Skip findings that were already resolved by the LLM in the same window
        const alreadyResolved = result.resolvedFindingIndices.includes(idx);
        if (alreadyResolved) continue;
        stillActiveDbIds.add(openF._dbId);
      }
      if (stillActiveDbIds.size > 0) {
        await trx('findings')
          .whereIn('id', Array.from(stillActiveDbIds))
          .whereIn('status', ['open', 'acknowledged'])
          .update({
            consecutive_misses: 0,
            last_seen_at: nowIso,
          });
        console.log(
          `[${localTimestamp()}] Reset consecutive_misses for ${stillActiveDbIds.size} ` +
          `LLM-confirmed still-active finding(s) (system ${system.id})`,
        );
      }
    }

    // ── Increment consecutive_misses for unmatched findings ─
    // ALL open/acknowledged findings for this system that were NOT matched by
    // dedup, NOT reopened, NOT resolved by the LLM, and NOT confirmed as still
    // active have "missed" a window.
    // Uses a system-wide query (no limit) so findings beyond the LLM context
    // cap (30) are still tracked and can eventually be auto-resolved.
    const excludeFromMissIds = new Set<string>(matchedOpenIds);
    // Add LLM-resolved finding IDs to the exclusion set
    if (result.resolvedFindingIndices.length > 0 && context.openFindings.length > 0) {
      for (const idx of result.resolvedFindingIndices) {
        const openF = context.openFindings.find((f) => f.index === idx);
        if (openF) excludeFromMissIds.add(openF._dbId);
      }
    }
    // Add LLM-confirmed still-active finding IDs (already reset above)
    for (const id of stillActiveDbIds) {
      excludeFromMissIds.add(id);
    }
    // Add newly inserted finding IDs (they start at consecutive_misses=0)
    for (const id of newlyInsertedIds) {
      excludeFromMissIds.add(id);
    }
    // Add reopened finding IDs (they were reset to consecutive_misses=0)
    for (const reopen of findingsToReopen) {
      excludeFromMissIds.add(reopen.id);
    }

    // Increment consecutive_misses for all other open/acknowledged findings
    const missIncrementQuery = trx('findings')
      .where({ system_id: system.id })
      .whereIn('status', ['open', 'acknowledged']);
    if (excludeFromMissIds.size > 0) {
      missIncrementQuery.whereNotIn('id', Array.from(excludeFromMissIds));
    }
    await missIncrementQuery.update({
      consecutive_misses: trx.raw('consecutive_misses + 1'),
    });

    // ── Auto-resolve stale findings (severity-tiered) ─────
    // Each severity level has its own threshold (in consecutive_misses).
    // E.g. critical findings persist for 14 days, info for 6 hours.
    {
      const staleFindings = await trx('findings')
        .where({ system_id: system.id })
        .whereIn('status', ['open', 'acknowledged'])
        .select('id', 'severity', 'consecutive_misses');

      const toAutoResolve: string[] = [];
      for (const f of staleFindings) {
        const threshold = severityAutoResolveMisses(f.severity, metaCfg);
        if (threshold > 0 && Number(f.consecutive_misses) >= threshold) {
          toAutoResolve.push(f.id);
        }
      }

      if (toAutoResolve.length > 0) {
        for (const findingId of toAutoResolve) {
          const finding = staleFindings.find((f: any) => f.id === findingId);
          const threshold = finding ? severityAutoResolveMisses(finding.severity, metaCfg) : 0;
          const windowCount = Number(finding?.consecutive_misses ?? threshold);
          const timespan = `${Math.round(windowCount * 5 / 60)} hours`;
          await trx('findings')
            .where({ id: findingId })
            .update({
              status: 'resolved',
              resolved_at: nowIso,
              resolved_by_meta_id: metaId,
              resolution_evidence: `Auto-resolved: not detected for ${windowCount} consecutive analysis windows (~${timespan})`,
            });
        }
        console.log(
          `[${localTimestamp()}] Auto-resolved ${toAutoResolve.length} stale finding(s) ` +
          `(severity-tiered thresholds)`,
        );
      }
    }

    // ── Severity decay for persistent non-escalating findings ──
    if (metaCfg.severity_decay_enabled && metaCfg.severity_decay_after_occurrences > 0) {
      const decayCandidates = await trx('findings')
        .where({ system_id: system.id, status: 'open' })
        .where('occurrence_count', '>=', metaCfg.severity_decay_after_occurrences)
        .whereIn('severity', ['critical', 'high'])
        .select('id', 'severity', 'original_severity');

      for (const f of decayCandidates) {
        const decayed = decaySeverity(f.severity);
        if (decayed) {
          await trx('findings')
            .where({ id: f.id })
            .update({ severity: decayed });
          console.log(
            `[${localTimestamp()}] Severity decay: finding ${f.id} ` +
            `${f.severity} → ${decayed} (occurrence_count >= ${metaCfg.severity_decay_after_occurrences})`,
          );
        }
      }
    }

    // ── Max open findings cap with priority eviction ──────
    if (metaCfg.max_open_findings_per_system > 0) {
      const openCount = await trx('findings')
        .where({ system_id: system.id, status: 'open' })
        .count('id as cnt')
        .first();
      const totalOpen = Number((openCount as any)?.cnt ?? 0);
      const excess = totalOpen - metaCfg.max_open_findings_per_system;

      if (excess > 0) {
        // Evict lowest-priority: info first, then low, then medium; oldest first within each
        const toEvict = await trx('findings')
          .where({ system_id: system.id, status: 'open' })
          .orderByRaw(`
            CASE severity
              WHEN 'info' THEN 0
              WHEN 'low' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'high' THEN 3
              WHEN 'critical' THEN 4
              ELSE 2
            END ASC,
            last_seen_at ASC NULLS FIRST
          `)
          .limit(excess)
          .select('id');

        if (toEvict.length > 0) {
          const evictIds = toEvict.map((f: any) => f.id);
          await trx('findings')
            .whereIn('id', evictIds)
            .update({
              status: 'resolved',
              resolved_at: nowIso,
              resolved_by_meta_id: metaId,
              resolution_evidence: `Auto-resolved: evicted due to open findings cap (max=${metaCfg.max_open_findings_per_system})`,
            });
          console.log(
            `[${localTimestamp()}] Evicted ${evictIds.length} finding(s) ` +
            `(exceeded max_open_findings_per_system=${metaCfg.max_open_findings_per_system})`,
          );
        }
      }
    }

    // ── Compute effective scores per criterion ──────────
    for (const criterion of CRITERIA) {
      const metaScore = (result.meta_scores as any)[criterion.slug] ?? 0;

      const maxEventRow = await trx('event_scores')
        .whereIn('event_id', eventIds)
        .where({ criterion_id: criterion.id })
        .max('score as max_score')
        .first();

      const maxEventScore = Number(maxEventRow?.max_score ?? 0);
      const effectiveValue = wMeta * metaScore + (1 - wMeta) * maxEventScore;

      await trx.raw(`
        INSERT INTO effective_scores (window_id, system_id, criterion_id, effective_value, meta_score, max_event_score, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (window_id, system_id, criterion_id)
        DO UPDATE SET effective_value = EXCLUDED.effective_value,
                      meta_score = EXCLUDED.meta_score,
                      max_event_score = EXCLUDED.max_event_score,
                      updated_at = EXCLUDED.updated_at
      `, [windowId, system.id, criterion.id, effectiveValue, metaScore, maxEventScore, nowIso]);
    }

    // ── Track LLM usage ─────────────────────────────────
    await trx('llm_usage').insert({
      id: uuidv4(),
      run_type: 'meta',
      model: usage.model || null,
      system_id: system.id,
      window_id: windowId,
      event_count: events.length,
      token_input: usage.token_input,
      token_output: usage.token_output,
      request_count: usage.request_count,
      cost_estimate: usage.model ? estimateCost(usage.token_input, usage.token_output, usage.model) : null,
    });
  });

  console.log(
    `[${localTimestamp()}] Meta-analyze window ${windowId}: ` +
    `${events.length} events, ${eventsForLlm.length} templates, ` +
    `LLM returned ${result.findings.length} findings → ` +
    `${findingsToInsert.length} new, ${findingsToUpdate.length} dedup-merged, ` +
    `${findingsToReopen.length} reopened, ` +
    `${result.resolvedFindingIndices.length} LLM-resolved, ` +
    `tokens=${usage.token_input + usage.token_output}`,
  );
}

// ────────────────────────────────────────────────────────────────
// Context builder — gathers historical data for the LLM's
// "sliding context window".
// ────────────────────────────────────────────────────────────────

async function buildMetaContext(
  db: Knex,
  systemId: string,
  currentWindowId: string,
): Promise<ExtendedMetaContext> {
  // 1. Previous window summaries (last N, excluding the current window)
  const prevMetas = await db('meta_results')
    .join('windows', 'meta_results.window_id', 'windows.id')
    .where('windows.system_id', systemId)
    .whereNot('windows.id', currentWindowId)
    .orderBy('windows.to_ts', 'desc')
    .limit(CONTEXT_WINDOW_SIZE)
    .select('meta_results.summary', 'windows.from_ts', 'windows.to_ts');

  const previousSummaries = prevMetas.map((m: any) => ({
    windowTime: `${formatShort(m.from_ts)} – ${formatShort(m.to_ts)}`,
    summary: m.summary,
  }));

  // 2. Currently open AND acknowledged findings for this system.
  // Including acknowledged findings prevents the LLM from creating duplicate
  // findings for issues that an operator has already seen.
  const openRows = await db('findings')
    .where({ system_id: systemId })
    .whereIn('status', ['open', 'acknowledged'])
    .orderBy('created_at', 'desc')
    .limit(30) // Cap to avoid huge prompts
    .select('id', 'text', 'severity', 'criterion_slug', 'fingerprint',
            'occurrence_count', 'consecutive_misses', 'status',
            'created_at', 'last_seen_at', 'reopen_count', 'is_flapping');

  const openFindings = openRows.map((f: any, i: number) => ({
    index: i,
    text: f.text,
    severity: f.severity,
    criterion: f.criterion_slug ?? undefined,
    status: f.status,
    created_at: f.created_at ?? undefined,
    last_seen_at: f.last_seen_at ?? undefined,
    occurrence_count: Number(f.occurrence_count) || 1,
    reopen_count: Number(f.reopen_count) || 0,
    is_flapping: Boolean(f.is_flapping),
    _dbId: f.id, // internal: used to resolve by DB ID later
    _fingerprint: f.fingerprint ?? undefined,
    _occurrence_count: Number(f.occurrence_count) || 1,
    _consecutive_misses: Number(f.consecutive_misses) || 0,
  }));

  return { previousSummaries, openFindings };
}

/** Check if two criteria match (null matches anything). */
function criterionMatchSimple(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return a === b;
}

/** Format a timestamp concisely for the LLM context. */
function formatShort(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return ts;
  }
}
