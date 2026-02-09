// ── Analysis criteria (the 6 fixed IDs) ─────────────────────

export const CRITERIA_SLUGS = [
  'it_security',
  'performance_degradation',
  'failure_prediction',
  'anomaly',
  'compliance_audit',
  'operational_risk',
] as const;

export type CriterionSlug = (typeof CRITERIA_SLUGS)[number];

export const CRITERIA: ReadonlyArray<{ id: number; slug: CriterionSlug; name: string }> = [
  { id: 1, slug: 'it_security', name: 'IT Security' },
  { id: 2, slug: 'performance_degradation', name: 'Performance Degradation' },
  { id: 3, slug: 'failure_prediction', name: 'Failure Prediction' },
  { id: 4, slug: 'anomaly', name: 'Anomaly / Unusual Patterns' },
  { id: 5, slug: 'compliance_audit', name: 'Compliance / Audit Relevance' },
  { id: 6, slug: 'operational_risk', name: 'Operational Risk / Service Health' },
];

// ── Normalized event shape (internal schema) ─────────────────

export interface NormalizedEvent {
  timestamp: string;          // ISO 8601 / timestamptz
  message: string;
  severity?: string;
  host?: string;
  source_ip?: string;         // IP address of the event source
  service?: string;
  facility?: string;
  program?: string;
  trace_id?: string;
  span_id?: string;
  raw?: Record<string, unknown>;
  external_id?: string;
  connector_id?: string;
}

// ── Stored event (after source matching and persistence) ─────

export interface StoredEvent extends NormalizedEvent {
  id: string;
  system_id: string;
  log_source_id: string;
  received_at: string;
  normalized_hash: string;
}

// ── Monitored system ─────────────────────────────────────────

export interface MonitoredSystem {
  id: string;
  name: string;
  description: string;
  retention_days: number | null; // NULL = use global default
  created_at: string;
  updated_at: string;
}

export interface CreateSystemBody {
  name: string;
  description?: string;
  retention_days?: number | null;
}

export interface UpdateSystemBody {
  name?: string;
  description?: string;
  retention_days?: number | null;
}

// ── Log source ───────────────────────────────────────────────

export interface LogSourceSelector {
  facility?: string;
  program?: string;
  service?: string;
  host?: string;
  source_ip?: string;
  tag?: string;
  [key: string]: string | undefined;
}

export interface LogSource {
  id: string;
  system_id: string;
  label: string;
  selector: LogSourceSelector;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface CreateLogSourceBody {
  system_id: string;
  label: string;
  selector: LogSourceSelector;
  priority?: number;
}

export interface UpdateLogSourceBody {
  label?: string;
  selector?: LogSourceSelector;
  priority?: number;
}

// ── API key scopes ───────────────────────────────────────────

export type ApiKeyScope = 'ingest' | 'admin' | 'read' | 'dashboard';

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  scope: ApiKeyScope;
  name: string;
  created_at: string;
}

// ── Ingest payload (what callers POST) ───────────────────────

export interface IngestEntry {
  timestamp?: string;
  message: string;
  severity?: string;
  host?: string;
  source_ip?: string;
  service?: string;
  facility?: string;
  program?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

export interface IngestPayload {
  events: IngestEntry[];
}

export interface IngestResponse {
  accepted: number;
  rejected: number;
  errors?: string[];
}

// ── Score types ──────────────────────────────────────────────

export type ScoreType = 'event' | 'meta';

export interface EventScore {
  id: string;
  event_id: string;
  criterion_id: number;
  score: number;
  reason_codes?: string[];
  score_type: ScoreType;
  severity_label?: string;
  created_at: string;
}

// ── Window ───────────────────────────────────────────────────

export interface Window {
  id: string;
  system_id: string;
  from_ts: string;
  to_ts: string;
  trigger: 'time' | 'count';
  created_at: string;
}

// ── Meta result ──────────────────────────────────────────────

export interface MetaScores {
  it_security: number;
  performance_degradation: number;
  failure_prediction: number;
  anomaly: number;
  compliance_audit: number;
  operational_risk: number;
}

export interface MetaResult {
  id: string;
  window_id: string;
  meta_scores: MetaScores;
  summary: string;
  findings: string[];
  recommended_action?: string;
  key_event_ids?: string[];
  created_at: string;
}
