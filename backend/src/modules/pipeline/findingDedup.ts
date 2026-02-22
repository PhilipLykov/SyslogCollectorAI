/**
 * Finding Deduplication Module
 *
 * Implements TF-IDF cosine similarity and Jaccard similarity for detecting
 * duplicate findings. Inspired by:
 * - Sentry's text-embedding–based issue grouping
 * - Datadog's Deduplicate Processor
 * - PagerDuty's Intelligent Alert Grouping
 *
 * Pure TypeScript — no external ML/NLP dependencies.
 */

import crypto from 'crypto';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

// ── Types ──────────────────────────────────────────────────────

export interface FindingCandidate {
  text: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  criterion?: string;
}

export interface OpenFinding {
  id: string;           // DB UUID
  text: string;
  severity: string;
  criterion_slug?: string | null;
  fingerprint?: string | null;
  occurrence_count: number;
  consecutive_misses: number;
}

export interface DedupResult {
  /** Genuinely new findings to insert. */
  toInsert: FindingCandidate[];
  /** Existing open findings to update (matched a new finding). */
  toUpdate: Array<{
    id: string;             // DB UUID of existing finding
    newLastSeenAt: string;  // ISO timestamp
    incrementOccurrence: boolean;
    escalateSeverity?: string; // new severity if higher
  }>;
  /** Stats for logging. */
  stats: {
    llmReturned: number;
    intraBatchDupes: number;
    crossRefDupes: number;
    inserted: number;
  };
}

// ── Severity ordering (for comparison) ─────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityRank(s: string): number {
  return SEVERITY_ORDER[s] ?? 1;
}

/** Returns true if severity `a` is higher than `b`. */
export function isHigherSeverity(a: string, b: string): boolean {
  return severityRank(a) > severityRank(b);
}

// ── Stop words (common English words to remove for better similarity) ──

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'because', 'if', 'when', 'while', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'they', 'them', 'their', 'here', 'there',
  // Domain-specific noise words
  'indicating', 'indicate', 'indicates', 'continue', 'continues', 'continued',
  'ongoing', 'requiring', 'requires', 'require', 'immediate', 'immediately',
  'resolution', 'attention', 'potential', 'particularly', 'overall',
  'poses', 'posing', 'pose',
]);

// ── Text Normalization ─────────────────────────────────────────

/**
 * Normalize finding text for comparison:
 * 1. Lowercase
 * 2. Replace UUIDs, container IDs (hex 12+), IP addresses with <ID>
 * 3. Remove punctuation (keep hyphens and underscores)
 * 4. Collapse whitespace
 * 5. Remove stop words
 */
export function normalizeFindingText(text: string): string {
  let t = text.toLowerCase();

  // Replace UUIDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<ID>');

  // Replace long hex strings (container IDs, SHA hashes) — 12+ hex chars
  t = t.replace(/\b[0-9a-f]{12,}\b/g, '<ID>');

  // Replace IP addresses (v4)
  t = t.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '<IP>');

  // Remove LLM event references: "(events [1], [2], [3]...)" or "(event [5])"
  t = t.replace(/\(events?\s*\[[\d\],\s\[]*\]\s*\)/g, '');

  // Remove standalone [N] references (e.g. "[1]", "[42]", "[377]")
  t = t.replace(/\[\d+\]/g, '');

  // Replace ALL isolated numbers (event refs, counts, timestamps)
  t = t.replace(/\b\d+\b/g, '<NUM>');

  // Remove punctuation except hyphens, underscores, angle brackets (for our placeholders)
  t = t.replace(/[^\w\s\-<>]/g, ' ');

  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

/** Extract word tokens from normalized text, filtering out stop words. */
export function tokenize(normalizedText: string): string[] {
  return normalizedText
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Compute a fingerprint (SHA-256 hash) from normalized tokenized text.
 * Used for fast exact-match dedup.
 */
export function computeFingerprint(text: string): string {
  const normalized = normalizeFindingText(text);
  const tokens = tokenize(normalized).sort(); // Sort for order-independence
  const canonical = tokens.join(' ');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// ── Jaccard Similarity ─────────────────────────────────────────

/**
 * Word-set Jaccard similarity: |intersection| / |union|.
 * Used as fallback when corpus is too small for TF-IDF.
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  const tokensA = new Set(tokenize(normalizeFindingText(textA)));
  const tokensB = new Set(tokenize(normalizeFindingText(textB)));

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const word of tokensA) {
    if (tokensB.has(word)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── TF-IDF Cosine Similarity ───────────────────────────────────

/**
 * Build a TF-IDF model from a corpus of texts and compute cosine similarity
 * between a query text and each corpus document.
 *
 * TF(term, doc) = count(term in doc) / total_terms_in_doc
 * IDF(term) = log(N / (1 + docs_containing_term))
 * TF-IDF = TF * IDF
 *
 * This weights domain-specific terms (e.g. "ShouldRestart", "docker0") more
 * heavily than common words, making it more robust than raw Jaccard for
 * catching paraphrased findings.
 */
export class TfIdfSimilarity {
  private corpusDocs: string[][];     // tokenized documents
  private idf: Map<string, number>;   // term → IDF weight
  private docVectors: Map<string, number>[]; // TF-IDF vectors per doc
  private docTexts: string[];         // original texts for reference

  constructor(corpusTexts: string[]) {
    this.docTexts = corpusTexts;
    this.corpusDocs = corpusTexts.map((t) => tokenize(normalizeFindingText(t)));

    // Compute IDF
    const N = this.corpusDocs.length;
    const docFreq = new Map<string, number>();
    for (const doc of this.corpusDocs) {
      const uniqueTerms = new Set(doc);
      for (const term of uniqueTerms) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    this.idf = new Map();
    for (const [term, df] of docFreq.entries()) {
      this.idf.set(term, Math.log((N + 1) / (1 + df)) + 1); // Smoothed IDF
    }

    // Compute TF-IDF vectors for corpus documents
    this.docVectors = this.corpusDocs.map((doc) => this.computeTfIdfVector(doc));
  }

  private computeTfIdfVector(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    const vec = new Map<string, number>();
    const totalTerms = tokens.length || 1;
    for (const [term, count] of tf.entries()) {
      const tfVal = count / totalTerms;
      const idfVal = this.idf.get(term) ?? 1;
      vec.set(term, tfVal * idfVal);
    }
    return vec;
  }

  /**
   * Compute cosine similarity between a query text and a specific corpus document.
   */
  similarityWithDoc(queryText: string, docIndex: number): number {
    const queryTokens = tokenize(normalizeFindingText(queryText));
    // Include query terms in IDF calculation (add as extra document)
    const queryVec = this.computeTfIdfVector(queryTokens);
    const docVec = this.docVectors[docIndex];
    if (!docVec) return 0;

    return cosineSimilarity(queryVec, docVec);
  }

  /**
   * Find the best matching corpus document for a query text.
   * Returns { index, similarity } or null if no match above minSimilarity.
   */
  bestMatch(queryText: string, minSimilarity: number): {
    index: number;
    similarity: number;
  } | null {
    const queryTokens = tokenize(normalizeFindingText(queryText));
    const queryVec = this.computeTfIdfVector(queryTokens);

    let bestIdx = -1;
    let bestSim = 0;

    for (let i = 0; i < this.docVectors.length; i++) {
      const sim = cosineSimilarity(queryVec, this.docVectors[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= minSimilarity) {
      return { index: bestIdx, similarity: bestSim };
    }
    return null;
  }
}

/** Cosine similarity between two sparse vectors (Map<string, number>). */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, valA] of a.entries()) {
    normA += valA * valA;
    const valB = b.get(term);
    if (valB !== undefined) {
      dotProduct += valA * valB;
    }
  }
  for (const valB of b.values()) {
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Main Dedup Function ────────────────────────────────────────

/**
 * Deduplicate new findings from the LLM against each other (intra-batch)
 * and against existing open findings (cross-reference).
 *
 * @param newFindings - Findings returned by the LLM in this window
 * @param openFindings - Currently open findings from the database
 * @param threshold - Similarity threshold (0.0-1.0, default 0.6)
 * @param maxNewFindings - Hard cap on new findings per window
 * @returns DedupResult with toInsert, toUpdate, and stats
 */
export function deduplicateFindings(
  newFindings: FindingCandidate[],
  openFindings: OpenFinding[],
  threshold: number = 0.6,
  maxNewFindings: number = 5,
): DedupResult {
  const stats = {
    llmReturned: newFindings.length,
    intraBatchDupes: 0,
    crossRefDupes: 0,
    inserted: 0,
  };

  if (newFindings.length === 0) {
    return { toInsert: [], toUpdate: [], stats };
  }

  // ── Step A: Intra-batch dedup ──────────────────────────────
  // Remove duplicates within the LLM's own output
  const batchDeduped: FindingCandidate[] = [];

  for (const finding of newFindings) {
    let isDupe = false;
    for (let i = 0; i < batchDeduped.length; i++) {
      const existing = batchDeduped[i];
      // Same or no criterion? Check similarity
      if (criterionMatch(finding.criterion, existing.criterion)) {
        const sim = jaccardSimilarity(finding.text, existing.text);
        if (sim >= threshold) {
          // Keep the higher severity one
          if (isHigherSeverity(finding.severity, existing.severity)) {
            batchDeduped[i] = finding;
          }
          isDupe = true;
          stats.intraBatchDupes++;
          break;
        }
      }
    }
    if (!isDupe) {
      batchDeduped.push(finding);
    }
  }

  // ── Step B: Cross-reference dedup against open findings ────
  const toInsert: FindingCandidate[] = [];
  const toUpdate: DedupResult['toUpdate'] = [];
  const matchedOpenIds = new Set<string>(); // Track which open findings were matched

  // Use TF-IDF if we have enough open findings, otherwise fall back to Jaccard
  const useTfIdf = openFindings.length >= 3;
  let tfidf: TfIdfSimilarity | null = null;
  if (useTfIdf) {
    tfidf = new TfIdfSimilarity(openFindings.map((f) => f.text));
  }

  for (const finding of batchDeduped) {
    let matched = false;

    // First, try fingerprint exact match
    const fp = computeFingerprint(finding.text);
    const fpMatch = openFindings.find(
      (of) => of.fingerprint === fp && criterionMatch(finding.criterion, of.criterion_slug),
    );
    if (fpMatch && !matchedOpenIds.has(fpMatch.id)) {
      matchedOpenIds.add(fpMatch.id);
      toUpdate.push({
        id: fpMatch.id,
        newLastSeenAt: new Date().toISOString(),
        incrementOccurrence: true,
        escalateSeverity: isHigherSeverity(finding.severity, fpMatch.severity)
          ? finding.severity : undefined,
      });
      matched = true;
      stats.crossRefDupes++;
    }

    // If no fingerprint match, try similarity
    if (!matched) {
      if (useTfIdf && tfidf) {
        // TF-IDF cosine similarity
        const bestMatch = tfidf.bestMatch(finding.text, threshold);
        if (bestMatch) {
          const openF = openFindings[bestMatch.index];
          if (openF && criterionMatch(finding.criterion, openF.criterion_slug) && !matchedOpenIds.has(openF.id)) {
            matchedOpenIds.add(openF.id);
            toUpdate.push({
              id: openF.id,
              newLastSeenAt: new Date().toISOString(),
              incrementOccurrence: true,
              escalateSeverity: isHigherSeverity(finding.severity, openF.severity)
                ? finding.severity : undefined,
            });
            matched = true;
            stats.crossRefDupes++;
          }
        }
      }

      if (!matched) {
        // Fallback: Jaccard against each open finding with matching criterion
        for (const openF of openFindings) {
          if (matchedOpenIds.has(openF.id)) continue;
          if (!criterionMatch(finding.criterion, openF.criterion_slug)) continue;

          const sim = jaccardSimilarity(finding.text, openF.text);
          if (sim >= threshold) {
            matchedOpenIds.add(openF.id);
            toUpdate.push({
              id: openF.id,
              newLastSeenAt: new Date().toISOString(),
              incrementOccurrence: true,
              escalateSeverity: isHigherSeverity(finding.severity, openF.severity)
                ? finding.severity : undefined,
            });
            matched = true;
            stats.crossRefDupes++;
            break;
          }
        }
      }
    }

    if (!matched) {
      toInsert.push(finding);
    }
  }

  // Apply hard cap on new findings
  if (toInsert.length > maxNewFindings) {
    // Keep the highest severity ones
    toInsert.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    toInsert.splice(maxNewFindings);
  }

  stats.inserted = toInsert.length;

  logger.debug(
    `[${localTimestamp()}] Finding dedup: LLM returned ${stats.llmReturned}, ` +
    `intra-batch dupes=${stats.intraBatchDupes}, cross-ref dupes=${stats.crossRefDupes}, ` +
    `new to insert=${stats.inserted}`,
  );

  return { toInsert, toUpdate, stats };
}

// ── Helpers ────────────────────────────────────────────────────

/** Check if two criteria match (null matches anything). */
function criterionMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // null/undefined criterion matches anything
  return a === b;
}
