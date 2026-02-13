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
  jaccardSimilarity,
  type OpenFinding,
} from './findingDedup.js';
import { loadPrivacyFilterConfig, filterMetaEventForLlm } from '../llm/llmPrivacyFilter.js';
import { getEventSource } from '../../services/eventSourceFactory.js';
import { loadNormalBehaviorTemplates, filterNormalBehaviorEvents } from './normalBehavior.js';

const DEFAULT_W_META = 0.7;
/** Default number of previous window summaries to include as context. */
const DEFAULT_CONTEXT_WINDOW_SIZE = 5;

// ── Meta-analysis configuration defaults ───────────────────────

export interface MetaAnalysisConfig {
  finding_dedup_enabled: boolean;
  finding_dedup_threshold: number;
  max_new_findings_per_window: number;
  /** @deprecated No longer used — auto-resolve by time is removed. Kept for backward compat. */
  auto_resolve_after_misses: number;
  /** @deprecated Severity decay is removed — severity only changes with user action or event evidence. */
  severity_decay_enabled: boolean;
  severity_decay_after_occurrences: number;
  max_open_findings_per_system: number;
  /** @deprecated No longer used — auto-resolve by time is removed. Kept for backward compat. */
  auto_resolve_critical_days: number;
  auto_resolve_high_days: number;
  auto_resolve_medium_days: number;
  auto_resolve_low_hours: number;
  auto_resolve_info_hours: number;
  /** @deprecated Flapping detection removed — resolved findings are never reopened. */
  flapping_threshold: number;
  /** How many days back to check for recently resolved findings when detecting recurring issues. */
  recurring_lookback_days: number;
  /** Number of previous window summaries to include as LLM context. */
  context_window_size: number;
}

const META_CONFIG_DEFAULTS: MetaAnalysisConfig = {
  finding_dedup_enabled: true,
  finding_dedup_threshold: 0.6,
  max_new_findings_per_window: 3,
  auto_resolve_after_misses: 0,        // Disabled — auto-resolve by time is removed
  severity_decay_enabled: false,        // Disabled — severity only changes with evidence
  severity_decay_after_occurrences: 10,
  max_open_findings_per_system: 50,
  // Legacy auto-resolve fields (kept for backward compat, no longer used)
  auto_resolve_critical_days: 14,
  auto_resolve_high_days: 10,
  auto_resolve_medium_days: 7,
  auto_resolve_low_hours: 72,
  auto_resolve_info_hours: 48,
  // Legacy flapping fields (kept for backward compat, no longer used)
  flapping_threshold: 3,
  recurring_lookback_days: 14,
  // Context window
  context_window_size: DEFAULT_CONTEXT_WINDOW_SIZE,
};

/** Load meta-analysis config from app_config, with defaults.
 *  Handles backward compat: old DB configs may store `flapping_lookback_days`
 *  which has been renamed to `recurring_lookback_days`. */
export async function loadMetaAnalysisConfig(db: Knex): Promise<MetaAnalysisConfig> {
  try {
    const row = await db('app_config').where({ key: 'meta_analysis_config' }).first();
    if (row) {
      let parsed = row.value;
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      // Backward compat: migrate old key name if present
      if (parsed && typeof parsed === 'object' && 'flapping_lookback_days' in parsed && !('recurring_lookback_days' in parsed)) {
        (parsed as Record<string, unknown>).recurring_lookback_days = (parsed as Record<string, unknown>).flapping_lookback_days;
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

/**
 * Meta-analyze a window: gather events + scores, build historical context,
 * call LLM, store meta_results + findings, compute effective scores.
 *
 * Design principles:
 *   - Findings only close with EVENT EVIDENCE (no time-based auto-resolve)
 *   - Resolved findings are NEVER reopened (recurring issues create new findings)
 *   - TF-IDF cosine / Jaccard finding deduplication (post-LLM safety net)
 *   - Max open findings cap with priority eviction
 *   - Resolution evidence stored as JSON with event IDs for traceability
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

  // Idempotency guard: skip if this window has already been analyzed
  const existingMeta = await db('meta_results').where({ window_id: windowId }).first();
  if (existingMeta) {
    console.log(`[${localTimestamp()}] Meta-analyze: window ${windowId} already has a meta_result (${existingMeta.id}), skipping duplicate run.`);
    return;
  }

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
  let events = await eventSource.getEventsInTimeRange(
    system.id,
    window.from_ts,
    window.to_ts,
    {
      limit: metaMaxEvents,
      excludeAcknowledged: ackMode === 'skip',
    },
  );

  // ── Exclude normal-behavior events ────────────────────────
  const normalTemplates = await loadNormalBehaviorTemplates(db, system.id);
  if (normalTemplates.length > 0) {
    const { filtered, excludedCount } = filterNormalBehaviorEvents(events, normalTemplates);
    if (excludedCount > 0) {
      console.log(
        `[${localTimestamp()}] Meta-analyze: ${excludedCount} events excluded as normal behavior (window=${windowId})`,
      );
      events = filtered;
    }
  }

  // ── Handle quiet windows: write zero effective scores ────
  if (events.length === 0) {
    console.log(`[${localTimestamp()}] Meta-analyze: no events in window ${windowId}, writing zero scores`);
    const nowIso = new Date().toISOString();
    for (const criterion of CRITERIA) {
      await db.raw(`
        INSERT INTO effective_scores (window_id, system_id, criterion_id, effective_value, meta_score, max_event_score, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, ?)
        ON CONFLICT (window_id, system_id, criterion_id)
        DO UPDATE SET effective_value = 0,
                      meta_score = 0,
                      max_event_score = 0,
                      updated_at = EXCLUDED.updated_at
      `, [windowId, system.id, criterion.id, nowIso]);
    }
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

  // Deduplicate by template for LLM input — also track representative event ID
  const templateGroups = new Map<string, {
    message: string; severity?: string; count: number;
    scores?: ScoreResult; acknowledged: boolean;
    representativeEventId: string; // First event's real ID for evidence linking
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
        representativeEventId: event.id,
      });
    }
    templateGroups.get(key)!.count++;
  }

  // Build eventsForLlm AND the index→eventId mapping for evidence linking
  const templateGroupValues = Array.from(templateGroups.values());
  const eventIndexToId = new Map<number, string>(); // 1-indexed → event UUID
  const eventIndexToMessage = new Map<number, string>(); // 1-indexed → event message

  let eventsForLlm = templateGroupValues.map((g, i) => {
    // Track mapping: LLM event number (1-indexed) → representative event ID + message
    eventIndexToId.set(i + 1, g.representativeEventId);
    eventIndexToMessage.set(i + 1, g.message);

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
  // NOTE: After sorting, the eventIndexToId / eventIndexToMessage mappings are rebuilt to stay in sync.
  if (prioritizeHighScores && eventsForLlm.length > 1) {
    // Pair events with their original representative IDs + messages before sorting
    const paired = eventsForLlm.map((e, i) => ({
      event: e,
      repId: templateGroupValues[i].representativeEventId,
      message: templateGroupValues[i].message,
    }));
    paired.sort((a, b) => {
      const safeMax = (s: typeof a.event.scores) => {
        if (!s) return 0;
        return Math.max(
          Number(s.it_security) || 0, Number(s.performance_degradation) || 0,
          Number(s.failure_prediction) || 0, Number(s.anomaly) || 0,
          Number(s.compliance_audit) || 0, Number(s.operational_risk) || 0,
        );
      };
      return safeMax(b.event.scores) - safeMax(a.event.scores); // descending
    });
    // Rebuild all arrays/maps in sorted order
    eventsForLlm = paired.map((p) => p.event);
    eventIndexToId.clear();
    eventIndexToMessage.clear();
    for (let i = 0; i < paired.length; i++) {
      eventIndexToId.set(i + 1, paired[i].repId);
      eventIndexToMessage.set(i + 1, paired[i].message);
    }
  }

  // ── Build historical context (sliding window) ───────────
  const contextWindowSize = metaCfg.context_window_size ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const context = await buildMetaContext(db, system.id, windowId, contextWindowSize);

  // ── Call LLM for meta-analysis ──────────────────────────
  let result: Awaited<ReturnType<typeof llm.metaAnalyze>>['result'];
  let usage: Awaited<ReturnType<typeof llm.metaAnalyze>>['usage'];
  try {
    ({ result, usage } = await llm.metaAnalyze(
      eventsForLlm,
      system.description ?? '',
      sourceLabels,
      context,
      { systemPrompt: customPrompts.metaSystemPrompt },
    ));
  } catch (err) {
    console.error(
      `[${localTimestamp()}] LLM meta-analysis failed for window ${windowId} ` +
      `(system=${system.name}): ${err instanceof Error ? err.message : err}`,
    );
    // Write zero effective scores so the dashboard reflects this window consistently
    const nowIso = new Date().toISOString();
    for (const criterion of CRITERIA) {
      await db.raw(`
        INSERT INTO effective_scores (window_id, system_id, criterion_id, effective_value, meta_score, max_event_score, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, ?)
        ON CONFLICT (window_id, system_id, criterion_id)
        DO UPDATE SET effective_value = 0,
                      meta_score = 0,
                      max_event_score = 0,
                      updated_at = EXCLUDED.updated_at
      `, [windowId, system.id, criterion.id, nowIso]);
    }
    return;
  }

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

  // ── Recurring issue detection: check new findings against recently resolved ──
  // Instead of reopening resolved findings (which causes flapping), we create
  // a NEW finding with a reference to the previous one. Resolved findings
  // stay resolved permanently.
  const remainingToInsert: typeof findingsToInsert = [];

  if (metaCfg.finding_dedup_enabled && findingsToInsert.length > 0) {
    const lookbackDate = new Date(
      Date.now() - (metaCfg.recurring_lookback_days || 14) * 24 * 60 * 60 * 1000,
    ).toISOString();

    const resolvedRows = await db('findings')
      .where({ system_id: system.id, status: 'resolved' })
      .where('resolved_at', '>=', lookbackDate)
      .orderBy('resolved_at', 'desc')
      .limit(50)
      .select('id', 'text', 'severity', 'criterion_slug', 'fingerprint', 'resolved_at');

    const matchedResolvedIds = new Set<string>();

    for (const finding of findingsToInsert) {
      let matchedResolved: any = null;

      if (resolvedRows.length > 0) {
        const fp = computeFingerprint(finding.text);

        // Try fingerprint exact match first
        const fpMatch = resolvedRows.find(
          (rf: any) => rf.fingerprint === fp &&
            !matchedResolvedIds.has(rf.id) &&
            criterionMatchSimple(finding.criterion, rf.criterion_slug),
        );

        if (fpMatch) {
          matchedResolved = fpMatch;
          matchedResolvedIds.add(fpMatch.id);
        }

        // If no fingerprint match, try Jaccard similarity
        if (!matchedResolved) {
          for (const rf of resolvedRows) {
            if (matchedResolvedIds.has(rf.id)) continue;
            if (!criterionMatchSimple(finding.criterion, rf.criterion_slug)) continue;
            const sim = jaccardSimilarity(finding.text, rf.text);
            if (sim >= metaCfg.finding_dedup_threshold) {
              matchedResolved = rf;
              matchedResolvedIds.add(rf.id);
              break;
            }
          }
        }
      }

      if (matchedResolved) {
        // Create a NEW finding with reference to the previous resolved one
        const resolvedDate = matchedResolved.resolved_at
          ? formatShort(matchedResolved.resolved_at)
          : 'recently';
        remainingToInsert.push({
          text: `Recurring: ${finding.text} (previously resolved ${resolvedDate})`,
          severity: finding.severity,
          criterion: finding.criterion,
        });
        console.log(
          `[${localTimestamp()}] Recurring issue detected: new finding references ` +
          `resolved finding ${matchedResolved.id} (system ${system.id})`,
        );
      } else {
        remainingToInsert.push(finding);
      }
    }
  } else {
    remainingToInsert.push(...findingsToInsert);
  }

  // Replace findingsToInsert with the processed ones
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

    // ── Mark LLM-resolved findings (with event evidence) ────
    // Only accept resolutions that include event_refs (specific event references).
    // Resolutions without event proof are rejected to prevent false closures.
    if (result.resolvedFindingIndices.length > 0 && context.openFindings.length > 0) {
      for (const resolvedEntry of result.resolvedFindings) {
        const openFinding = context.openFindings.find((f) => f.index === resolvedEntry.index);
        if (!openFinding) continue;
        const dbId = openFinding._dbId;
        if (!dbId) continue;

        // Map event_refs to real event IDs
        const eventRefs: number[] = resolvedEntry.event_refs ?? [];
        const mappedEventIds: string[] = [];
        for (const ref of eventRefs) {
          const realId = eventIndexToId.get(ref);
          if (realId) mappedEventIds.push(realId);
        }

        // Reject resolutions without event evidence
        if (mappedEventIds.length === 0) {
          console.log(
            `[${localTimestamp()}] Rejected LLM resolution for finding index ${resolvedEntry.index} ` +
            `(${openFinding.text.slice(0, 60)}…): no event_refs provided. ` +
            `Findings require event evidence to be resolved.`,
          );
          continue;
        }

        // ── Guardrail 1: Reject contradictory evidence ────────
        // If the LLM's own evidence text says the issue is NOT resolved,
        // the resolution is clearly a hallucination / logic failure.
        const evidenceText = (resolvedEntry.evidence ?? '').toLowerCase();
        const contradictoryPhrases = [
          'remains unresolved', 'not resolved', 'still unresolved',
          'issue remains', 'issue persists', 'still active',
          'still occurring', 'still happening', 'still ongoing',
          'not been resolved', 'has not been fixed', 'not yet resolved',
          'no evidence of resolution', 'no resolution',
          'issue continues', 'problem persists', 'problem remains',
          'still present', 'still exists',
        ];
        const isContradictory = contradictoryPhrases.some((p) => evidenceText.includes(p));
        if (isContradictory) {
          console.log(
            `[${localTimestamp()}] Rejected LLM resolution for finding index ${resolvedEntry.index} ` +
            `(${openFinding.text.slice(0, 60)}…): evidence text contradicts resolution ` +
            `("${resolvedEntry.evidence?.slice(0, 100)}…"). Treating as still-active instead.`,
          );
          // Treat as still-active: reset consecutive_misses and refresh last_seen
          await trx('findings')
            .where({ id: dbId })
            .whereIn('status', ['open', 'acknowledged'])
            .update({
              consecutive_misses: 0,
              last_seen_at: nowIso,
              occurrence_count: trx.raw('occurrence_count + 1'),
            });
          continue;
        }

        // ── Guardrail 2: Reject self-referential resolutions ──
        // If every referenced event's message is substantially similar to the
        // finding's own text, the LLM is resolving the finding with the same
        // problem — not a counter-event. This is always invalid.
        const stripPunctuation = (s: string) => s.replace(/[^a-z0-9\s]/g, '');
        const findingTextClean = stripPunctuation(openFinding.text.toLowerCase());
        const findingWords = new Set(findingTextClean.split(/\s+/).filter((w) => w.length > 3));
        let allSelfReferential = true;
        for (const ref of eventRefs) {
          const refMessage = stripPunctuation((eventIndexToMessage.get(ref) ?? '').toLowerCase());
          if (!refMessage) continue;
          const refWords = new Set(refMessage.split(/\s+/).filter((w) => w.length > 3));
          // One-directional overlap: if ≥50% of the finding's significant words
          // appear in the event message, the event describes the same problem.
          let overlap = 0;
          for (const w of findingWords) {
            if (refWords.has(w)) overlap++;
          }
          const overlapRatio = findingWords.size > 0 ? overlap / findingWords.size : 0;
          if (overlapRatio < 0.5) {
            allSelfReferential = false;
            break;
          }
        }
        if (allSelfReferential) {
          console.log(
            `[${localTimestamp()}] Rejected LLM resolution for finding index ${resolvedEntry.index} ` +
            `(${openFinding.text.slice(0, 60)}…): proof events describe the same problem, ` +
            `not a counter-event. Treating as still-active instead.`,
          );
          await trx('findings')
            .where({ id: dbId })
            .whereIn('status', ['open', 'acknowledged'])
            .update({
              consecutive_misses: 0,
              last_seen_at: nowIso,
              occurrence_count: trx.raw('occurrence_count + 1'),
            });
          continue;
        }

        // Store resolution evidence as JSON with event IDs
        const evidenceObj = {
          text: resolvedEntry.evidence ?? '',
          event_ids: mappedEventIds,
        };

        await trx('findings')
          .where({ id: dbId })
          .whereIn('status', ['open', 'acknowledged'])
          .update({
            status: 'resolved',
            resolved_at: nowIso,
            resolved_by_meta_id: metaId,
            resolution_evidence: JSON.stringify(evidenceObj),
          });

        console.log(
          `[${localTimestamp()}] Resolved finding ${dbId} with event evidence: ` +
          `${mappedEventIds.length} event(s) referenced`,
        );
      }
    }

    // ── Handle LLM-confirmed "still active" findings ───────
    // The LLM can confirm that an open finding is still active even if no new
    // duplicate finding was emitted.  We reset consecutive_misses for these and
    // refresh last_seen_at so they are clearly marked as recently observed.
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

    // ── Safeguard: detect empty LLM classification ─────────
    // If the LLM returned no still_active_indices AND no resolved_indices AND
    // there are open findings in context, it likely failed to classify them.
    // In this case, skip the consecutive_misses increment entirely for this
    // window to avoid inflating the dormancy counter due to LLM failures.
    const llmClassifiedAnything =
      result.stillActiveFindingIndices.length > 0 ||
      result.resolvedFindingIndices.length > 0;
    const hasOpenFindingsInContext = context.openFindings.length > 0;
    const skipMissIncrement = hasOpenFindingsInContext && !llmClassifiedAnything;

    if (skipMissIncrement) {
      console.log(
        `[${localTimestamp()}] Skipping consecutive_misses increment: LLM returned empty ` +
        `still_active + resolved lists with ${context.openFindings.length} open finding(s) ` +
        `in context (system ${system.id})`,
      );
    }

    // ── Increment consecutive_misses for unmatched findings ─
    // ALL open/acknowledged findings for this system that were NOT matched by
    // dedup, NOT resolved by the LLM, and NOT confirmed as still active have
    // "missed" a window. This counter is used as a dormancy indicator in the UI.
    // NOTE: This counter does NOT trigger auto-resolution (removed by design).
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

    // Increment consecutive_misses for all other open/acknowledged findings
    // (skipped when LLM failed to classify any findings — see safeguard above)
    if (!skipMissIncrement) {
      const missIncrementQuery = trx('findings')
        .where({ system_id: system.id })
        .whereIn('status', ['open', 'acknowledged']);
      if (excludeFromMissIds.size > 0) {
        missIncrementQuery.whereNotIn('id', Array.from(excludeFromMissIds));
      }
      await missIncrementQuery.update({
        consecutive_misses: trx.raw('consecutive_misses + 1'),
      });
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
              resolution_evidence: JSON.stringify({
                text: `Auto-closed: evicted due to open findings cap (max=${metaCfg.max_open_findings_per_system})`,
                event_ids: [],
              }),
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

  // Count accepted resolutions (those with event evidence)
  const acceptedResolutions = result.resolvedFindings.filter((r) => {
    const refs = r.event_refs ?? [];
    return refs.some((ref) => eventIndexToId.has(ref));
  }).length;

  console.log(
    `[${localTimestamp()}] Meta-analyze window ${windowId}: ` +
    `${events.length} events, ${eventsForLlm.length} templates, ` +
    `LLM returned ${result.findings.length} findings → ` +
    `${findingsToInsert.length} new, ${findingsToUpdate.length} dedup-merged, ` +
    `${acceptedResolutions} resolved (with evidence), ` +
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
  contextWindowSize: number = DEFAULT_CONTEXT_WINDOW_SIZE,
): Promise<ExtendedMetaContext> {
  // 1. Previous window summaries (last N, excluding the current window)
  const prevMetas = await db('meta_results')
    .join('windows', 'meta_results.window_id', 'windows.id')
    .where('windows.system_id', systemId)
    .whereNot('windows.id', currentWindowId)
    .orderBy('windows.to_ts', 'desc')
    .limit(contextWindowSize)
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
