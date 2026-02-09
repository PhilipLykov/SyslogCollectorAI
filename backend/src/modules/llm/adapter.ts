import { localTimestamp } from '../../config/index.js';
import { CRITERIA_SLUGS, type CriterionSlug, type MetaScores } from '../../types/index.js';

// ── Types ────────────────────────────────────────────────────

export interface ScoreResult {
  it_security: number;
  performance_degradation: number;
  failure_prediction: number;
  anomaly: number;
  compliance_audit: number;
  operational_risk: number;
  reason_codes?: Record<CriterionSlug, string[]>;
}

export interface MetaAnalysisResult {
  meta_scores: MetaScores;
  summary: string;
  findings: string[];
  recommended_action?: string;
  key_event_ids?: string[];
}

export interface LlmUsageInfo {
  model: string;
  token_input: number;
  token_output: number;
  request_count: number;
}

export interface ScoreEventsResult {
  scores: ScoreResult[];
  usage: LlmUsageInfo;
}

export interface MetaAnalyzeResult {
  result: MetaAnalysisResult;
  usage: LlmUsageInfo;
}

// ── LLM Adapter Interface ────────────────────────────────────

export interface LlmAdapter {
  scoreEvents(
    events: Array<{ message: string; severity?: string; host?: string; program?: string }>,
    systemDescription: string,
    sourceLabels: string[],
  ): Promise<ScoreEventsResult>;

  metaAnalyze(
    eventsWithScores: Array<{
      message: string;
      severity?: string;
      scores?: ScoreResult;
      occurrenceCount?: number;
    }>,
    systemDescription: string,
    sourceLabels: string[],
  ): Promise<MetaAnalyzeResult>;
}

// ── OpenAI Adapter ───────────────────────────────────────────

const SCORE_SYSTEM_PROMPT = `You are an expert IT log analyst. Analyze each log event and return a JSON object with a "scores" key containing an array of objects, one per event.

Each object must have exactly these 6 keys (float 0.0 to 1.0):
- it_security: likelihood of security threat
- performance_degradation: indicators of slowness, resource exhaustion
- failure_prediction: signs of impending failure
- anomaly: unusual patterns deviating from normal behavior
- compliance_audit: relevance to compliance/audit
- operational_risk: general service health risk

Example response for 2 events:
{"scores": [{"it_security": 0.8, "performance_degradation": 0.1, "failure_prediction": 0.0, "anomaly": 0.3, "compliance_audit": 0.7, "operational_risk": 0.2}, {"it_security": 0.0, "performance_degradation": 0.6, "failure_prediction": 0.4, "anomaly": 0.1, "compliance_audit": 0.0, "operational_risk": 0.5}]}

Return ONLY valid JSON with the "scores" array.`;

const META_SYSTEM_PROMPT = `You are an expert IT log analyst performing a meta-analysis of a batch of log events from a single monitored system over a time window.

Return a JSON object with:
- meta_scores: object with 6 keys (it_security, performance_degradation, failure_prediction, anomaly, compliance_audit, operational_risk), each a float 0.0–1.0
- summary: 1-3 sentence summary of the window's findings
- findings: array of specific finding strings
- recommended_action: one short recommended action (optional)

Return ONLY valid JSON.`;

export class OpenAiAdapter implements LlmAdapter {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(cfg?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = cfg?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = cfg?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.baseUrl = cfg?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

    if (!this.apiKey) {
      console.warn(`[${localTimestamp()}] WARNING: OPENAI_API_KEY not set. LLM scoring will fail.`);
    }
  }

  /** Update adapter config at runtime (e.g. when user changes settings via UI). */
  updateConfig(cfg: { apiKey?: string; model?: string; baseUrl?: string }): void {
    if (cfg.apiKey !== undefined) this.apiKey = cfg.apiKey;
    if (cfg.model !== undefined) this.model = cfg.model;
    if (cfg.baseUrl !== undefined) this.baseUrl = cfg.baseUrl;
  }

  /** Check whether the adapter has a valid API key configured. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async scoreEvents(
    events: Array<{ message: string; severity?: string; host?: string; program?: string }>,
    systemDescription: string,
    sourceLabels: string[],
  ): Promise<ScoreEventsResult> {
    const userContent = [
      `System: ${systemDescription}`,
      `Sources: ${sourceLabels.join(', ')}`,
      `Number of events: ${events.length}`,
      '',
      'Events to analyze:',
      ...events.map((e, i) =>
        `[${i + 1}] ${e.severity ? `[${e.severity}]` : ''} ${e.host ? `host=${e.host}` : ''} ${e.program ? `prog=${e.program}` : ''} ${e.message}`
      ),
    ].join('\n');

    const response = await this.chatCompletion(SCORE_SYSTEM_PROMPT, userContent);

    let scores: ScoreResult[];
    try {
      const parsed = JSON.parse(response.content);
      // Handle both {"scores": [...]} and direct array (if provider doesn't use json_object)
      const rawScores = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.scores)
          ? parsed.scores
          : [parsed];
      scores = rawScores.map(normalizeScoreResult);

      // Pad scores array if LLM returned fewer than expected
      while (scores.length < events.length) {
        scores.push(emptyScoreResult());
      }
    } catch (err) {
      console.error(`[${localTimestamp()}] Failed to parse LLM score response:`, err);
      console.error(`[${localTimestamp()}] Raw response: ${response.content.slice(0, 500)}`);
      // Return zero scores rather than crash
      scores = events.map(() => emptyScoreResult());
    }

    return { scores, usage: response.usage };
  }

  async metaAnalyze(
    eventsWithScores: Array<{
      message: string;
      severity?: string;
      scores?: ScoreResult;
      occurrenceCount?: number;
    }>,
    systemDescription: string,
    sourceLabels: string[],
  ): Promise<MetaAnalyzeResult> {
    const userContent = [
      `System: ${systemDescription}`,
      `Sources: ${sourceLabels.join(', ')}`,
      `Event count: ${eventsWithScores.length}`,
      '',
      'Events in window:',
      ...eventsWithScores.map((e, i) => {
        let line = `[${i + 1}] ${e.severity ? `[${e.severity}]` : ''} ${e.message}`;
        if (e.occurrenceCount && e.occurrenceCount > 1) {
          line += ` (×${e.occurrenceCount})`;
        }
        if (e.scores) {
          const maxScore = Math.max(
            e.scores.it_security, e.scores.performance_degradation,
            e.scores.failure_prediction, e.scores.anomaly,
            e.scores.compliance_audit, e.scores.operational_risk,
          );
          line += ` [max_score=${maxScore.toFixed(2)}]`;
        }
        return line;
      }),
    ].join('\n');

    const response = await this.chatCompletion(META_SYSTEM_PROMPT, userContent);

    try {
      const parsed = JSON.parse(response.content);

      const metaScores: MetaScores = {
        it_security: clamp(parsed.meta_scores?.it_security ?? 0),
        performance_degradation: clamp(parsed.meta_scores?.performance_degradation ?? 0),
        failure_prediction: clamp(parsed.meta_scores?.failure_prediction ?? 0),
        anomaly: clamp(parsed.meta_scores?.anomaly ?? 0),
        compliance_audit: clamp(parsed.meta_scores?.compliance_audit ?? 0),
        operational_risk: clamp(parsed.meta_scores?.operational_risk ?? 0),
      };

      return {
        result: {
          meta_scores: metaScores,
          summary: parsed.summary ?? '',
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
          recommended_action: parsed.recommended_action,
          key_event_ids: parsed.key_event_ids,
        },
        usage: response.usage,
      };
    } catch (err) {
      console.error(`[${localTimestamp()}] Failed to parse LLM meta response:`, err);
      console.error(`[${localTimestamp()}] Raw response: ${response.content.slice(0, 500)}`);
      throw new Error('Failed to parse meta-analysis LLM response');
    }
  }

  private async chatCompletion(
    systemPrompt: string,
    userContent: string,
  ): Promise<{ content: string; usage: LlmUsageInfo }> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' as const },
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`[${localTimestamp()}] LLM returned empty content (model=${this.model})`);
    }
    const usage: LlmUsageInfo = {
      model: this.model,
      token_input: data.usage?.prompt_tokens ?? 0,
      token_output: data.usage?.completion_tokens ?? 0,
      request_count: 1,
    };

    return { content: content ?? '{}', usage };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function clamp(v: unknown): number {
  const n = typeof v === 'number' ? v : 0;
  return Math.max(0, Math.min(1, n));
}

/** Normalize a raw LLM score object: ensure all 6 fields exist, clamp 0-1. */
function normalizeScoreResult(raw: Record<string, unknown>): ScoreResult {
  const result: Record<string, number> = {};
  for (const slug of CRITERIA_SLUGS) {
    result[slug] = clamp(raw[slug]);
  }
  return result as unknown as ScoreResult;
}

function emptyScoreResult(): ScoreResult {
  return {
    it_security: 0,
    performance_degradation: 0,
    failure_prediction: 0,
    anomaly: 0,
    compliance_audit: 0,
    operational_risk: 0,
  };
}
