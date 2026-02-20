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
  event_source: 'postgresql' | 'elasticsearch';
  es_config: Record<string, unknown> | null;
  es_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSystemBody {
  name: string;
  description?: string;
  retention_days?: number | null;
  tz_offset_minutes?: number | null;
  event_source?: 'postgresql' | 'elasticsearch';
  es_config?: Record<string, unknown> | null;
  es_connection_id?: string | null;
}

export interface UpdateSystemBody {
  name?: string;
  description?: string;
  retention_days?: number | null;
  tz_offset_minutes?: number | null;
  event_source?: 'postgresql' | 'elasticsearch';
  es_config?: Record<string, unknown> | null;
  es_connection_id?: string | null;
}

/** Per-system Elasticsearch configuration stored as JSONB in monitored_systems.es_config. */
export interface EsSystemConfig {
  index_pattern: string;          // e.g. "filebeat-*", "logs-*"
  query_filter?: Record<string, unknown>; // Optional ES query DSL filter
  timestamp_field?: string;       // Default: "@timestamp"
  message_field?: string;         // Default: "message"
  field_mapping?: Record<string, string>; // ES field → LogEvent field mapping
}

/** Row shape for the elasticsearch_connections table. */
export interface ElasticsearchConnection {
  id: string;
  name: string;
  url: string;
  auth_type: 'none' | 'basic' | 'api_key' | 'cloud_id';
  credentials_encrypted?: string | null;
  tls_reject_unauthorized: boolean;
  ca_cert?: string | null;
  request_timeout_ms: number;
  max_retries: number;
  pool_max_connections: number;
  is_default: boolean;
  status: 'unknown' | 'connected' | 'error';
  last_error?: string | null;
  last_health_check_at?: string | null;
  created_at: string;
  updated_at: string;
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
  selector: LogSourceSelector | LogSourceSelector[];
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface CreateLogSourceBody {
  system_id: string;
  label: string;
  selector: LogSourceSelector | LogSourceSelector[];
  priority?: number;
}

export interface UpdateLogSourceBody {
  label?: string;
  selector?: LogSourceSelector | LogSourceSelector[];
  priority?: number;
}

// ── API key scopes ───────────────────────────────────────────

export type ApiKeyScope = 'ingest' | 'admin' | 'read' | 'dashboard';

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  scope: ApiKeyScope;
  name: string;
  description?: string;
  created_by?: string;
  expires_at?: string;
  last_used_at?: string;
  is_active: boolean;
  allowed_ips?: string[] | null;
  created_at: string;
}

// ── User ──────────────────────────────────────────────────────

export type UserRole = string; // Dynamic — any role name from the DB

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name?: string;
  email?: string;
  role: string;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at?: string;
  failed_login_count: number;
  locked_until?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

// ── Session ───────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  ip?: string;
  user_agent?: string;
  expires_at: string;
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
  trigger: 'time' | 'count' | 'manual';
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
