const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function getApiKey(): string {
  return localStorage.getItem('apiKey') ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem('apiKey', key);
}

export function getStoredApiKey(): string {
  return getApiKey();
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'X-API-Key': getApiKey(),
    ...init?.headers as Record<string, string>,
  };

  // Only set Content-Type when there is actually a body to send.
  // Sending Content-Type: application/json with no body causes Fastify to
  // attempt JSON parsing on an empty payload, resulting in a 400 error.
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new Error('Network error — check your connection and try again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `API ${res.status}`);
  }

  // Handle 204 No Content (e.g., DELETE responses)
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────

export interface SystemScoreInfo {
  effective: number;
  meta: number;
  max_event: number;
}

export interface DashboardSystem {
  id: string;
  name: string;
  description: string;
  source_count: number;
  event_count_24h: number;
  latest_window: { id: string; from: string; to: string } | null;
  scores: Record<string, SystemScoreInfo>;
  updated_at: string;
}

export interface MonitoredSystem {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface LogSource {
  id: string;
  system_id: string;
  label: string;
  selector: Record<string, string>;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface LogEvent {
  id: string;
  system_id: string;
  system_name?: string;
  log_source_id: string;
  timestamp: string;
  received_at?: string;
  message: string;
  severity?: string;
  host?: string;
  service?: string;
  program?: string;
  facility?: string;
  trace_id?: string;
  span_id?: string;
  external_id?: string;
  raw?: Record<string, unknown> | string;
  acknowledged_at?: string | null;
}

export interface MetaResult {
  id: string;
  window_id: string;
  meta_scores: Record<string, number>;
  summary: string;
  findings: string[];
  recommended_action?: string;
}

// ── Findings (persistent, per-system) ────────────────────────

export interface Finding {
  id: string;
  system_id: string;
  meta_result_id: string;
  text: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  criterion_slug: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by_meta_id: string | null;
  created_at: string;
}

export async function fetchFindings(
  systemId: string,
  opts?: { status?: 'open' | 'acknowledged' | 'resolved' | 'active'; limit?: number },
): Promise<Finding[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/api/v1/systems/${systemId}/findings?${params}`);
}

export async function acknowledgeFinding(findingId: string): Promise<Finding> {
  return apiFetch(`/api/v1/findings/${findingId}/acknowledge`, { method: 'PUT' });
}

export async function reopenFinding(findingId: string): Promise<Finding> {
  return apiFetch(`/api/v1/findings/${findingId}/reopen`, { method: 'PUT' });
}

// ── Dashboard API calls ──────────────────────────────────────

export async function fetchDashboardSystems(): Promise<DashboardSystem[]> {
  return apiFetch('/api/v1/dashboard/systems');
}

export async function fetchSystemEvents(
  systemId: string,
  opts?: { from?: string; to?: string; limit?: number },
): Promise<LogEvent[]> {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to) params.set('to', opts.to);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/api/v1/systems/${systemId}/events?${params}`);
}

export async function fetchSystemMeta(
  systemId: string,
  windowId?: string,
): Promise<MetaResult> {
  const params = windowId ? `?window_id=${windowId}` : '';
  return apiFetch(`/api/v1/systems/${systemId}/meta${params}`);
}

// ── Systems CRUD ─────────────────────────────────────────────

export async function fetchSystems(): Promise<MonitoredSystem[]> {
  return apiFetch('/api/v1/systems');
}

export async function createSystem(data: { name: string; description?: string }): Promise<MonitoredSystem> {
  return apiFetch('/api/v1/systems', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateSystem(
  id: string,
  data: { name?: string; description?: string },
): Promise<MonitoredSystem> {
  return apiFetch(`/api/v1/systems/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteSystem(id: string): Promise<void> {
  return apiFetch(`/api/v1/systems/${id}`, { method: 'DELETE' });
}

// ── Log Sources CRUD ─────────────────────────────────────────

export async function fetchSources(systemId?: string): Promise<LogSource[]> {
  const params = systemId ? `?system_id=${systemId}` : '';
  return apiFetch(`/api/v1/sources${params}`);
}

export async function createSource(data: {
  system_id: string;
  label: string;
  selector: Record<string, string>;
  priority?: number;
}): Promise<LogSource> {
  return apiFetch('/api/v1/sources', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateSource(
  id: string,
  data: { label?: string; selector?: Record<string, string>; priority?: number },
): Promise<LogSource> {
  return apiFetch(`/api/v1/sources/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteSource(id: string): Promise<void> {
  return apiFetch(`/api/v1/sources/${id}`, { method: 'DELETE' });
}

// ── AI Configuration ─────────────────────────────────────────

export interface AiConfigResponse {
  model: string;
  base_url: string;
  api_key_set: boolean;
  api_key_hint: string;
  api_key_source: 'database' | 'environment' | 'none';
}

export async function fetchAiConfig(): Promise<AiConfigResponse> {
  return apiFetch('/api/v1/ai-config');
}

export async function updateAiConfig(data: {
  model?: string;
  base_url?: string;
  api_key?: string;
}): Promise<AiConfigResponse> {
  return apiFetch('/api/v1/ai-config', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── AI System Prompts ────────────────────────────────────────

export interface AiPromptsResponse {
  scoring_system_prompt: string | null;
  meta_system_prompt: string | null;
  scoring_is_custom: boolean;
  meta_is_custom: boolean;
  default_scoring_system_prompt: string;
  default_meta_system_prompt: string;
}

export async function fetchAiPrompts(): Promise<AiPromptsResponse> {
  return apiFetch('/api/v1/ai-prompts');
}

export async function updateAiPrompts(data: {
  scoring_system_prompt?: string | null;
  meta_system_prompt?: string | null;
}): Promise<AiPromptsResponse> {
  return apiFetch('/api/v1/ai-prompts', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── Notification Channels ────────────────────────────────────

export type ChannelType = 'webhook' | 'pushover' | 'ntfy' | 'gotify' | 'telegram';

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  scope: string;
  created_at: string;
  updated_at: string;
}

export async function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  return apiFetch('/api/v1/notification-channels');
}

export async function createNotificationChannel(data: {
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<NotificationChannel> {
  return apiFetch('/api/v1/notification-channels', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateNotificationChannel(
  id: string,
  data: {
    name?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<NotificationChannel> {
  return apiFetch(`/api/v1/notification-channels/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteNotificationChannel(id: string): Promise<void> {
  return apiFetch(`/api/v1/notification-channels/${id}`, { method: 'DELETE' });
}

export async function testNotificationChannel(id: string): Promise<{ status: string; message: string }> {
  return apiFetch(`/api/v1/notification-channels/${id}/test`, { method: 'POST' });
}

// ── Notification Rules ───────────────────────────────────────

export interface NotificationRule {
  id: string;
  channel_id: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  filters: Record<string, unknown> | null;
  throttle_interval_seconds: number | null;
  send_recovery: boolean;
  notify_only_on_state_change: boolean;
  template_title: string | null;
  template_body: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function fetchNotificationRules(): Promise<NotificationRule[]> {
  return apiFetch('/api/v1/notification-rules');
}

export async function createNotificationRule(data: {
  channel_id: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  filters?: Record<string, unknown>;
  throttle_interval_seconds?: number;
  send_recovery?: boolean;
  notify_only_on_state_change?: boolean;
  enabled?: boolean;
}): Promise<NotificationRule> {
  return apiFetch('/api/v1/notification-rules', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateNotificationRule(
  id: string,
  data: Partial<{
    trigger_config: Record<string, unknown>;
    filters: Record<string, unknown> | null;
    throttle_interval_seconds: number | null;
    send_recovery: boolean;
    notify_only_on_state_change: boolean;
    enabled: boolean;
  }>,
): Promise<NotificationRule> {
  return apiFetch(`/api/v1/notification-rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteNotificationRule(id: string): Promise<void> {
  return apiFetch(`/api/v1/notification-rules/${id}`, { method: 'DELETE' });
}

// ── Alert History ────────────────────────────────────────────

export interface AlertHistoryRecord {
  id: string;
  rule_id: string;
  channel_id: string;
  system_id: string;
  window_id: string | null;
  criterion_id: number | null;
  state: 'firing' | 'resolved';
  severity: string | null;
  created_at: string;
}

export async function fetchAlertHistory(opts?: {
  system_id?: string;
  rule_id?: string;
  state?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<AlertHistoryRecord[]> {
  const params = new URLSearchParams();
  if (opts?.system_id) params.set('system_id', opts.system_id);
  if (opts?.rule_id) params.set('rule_id', opts.rule_id);
  if (opts?.state) params.set('state', opts.state);
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to) params.set('to', opts.to);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/api/v1/alerts?${params}`);
}

// ── Silences ─────────────────────────────────────────────────

export interface Silence {
  id: string;
  name: string | null;
  starts_at: string;
  ends_at: string;
  scope: { global?: boolean; system_ids?: string[]; rule_ids?: string[] };
  comment: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function fetchSilences(): Promise<Silence[]> {
  return apiFetch('/api/v1/silences');
}

export async function createSilence(data: {
  name?: string;
  starts_at: string;
  ends_at: string;
  scope: { global?: boolean; system_ids?: string[]; rule_ids?: string[] };
  comment?: string;
}): Promise<Silence> {
  return apiFetch('/api/v1/silences', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteSilence(id: string): Promise<void> {
  return apiFetch(`/api/v1/silences/${id}`, { method: 'DELETE' });
}

// ── Event Scores (criterion drill-down) ──────────────────────

export interface EventScoreRecord {
  event_id: string;
  timestamp: string;
  message: string;
  severity: string | null;
  host: string | null;
  program: string | null;
  criterion_slug: string;
  criterion_name: string;
  score: number;
  severity_label: string | null;
  reason_codes: string[] | null;
}

export async function fetchEventScores(
  systemId: string,
  opts?: { criterion_id?: number; limit?: number },
): Promise<EventScoreRecord[]> {
  const params = new URLSearchParams();
  if (opts?.criterion_id) params.set('criterion_id', String(opts.criterion_id));
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/api/v1/systems/${systemId}/event-scores?${params}`);
}

// ── Scoring Criteria (static, matches backend CRITERIA) ──────

export const CRITERIA = [
  { id: 1, slug: 'it_security', name: 'IT Security' },
  { id: 2, slug: 'performance_degradation', name: 'Performance Degradation' },
  { id: 3, slug: 'failure_prediction', name: 'Failure Prediction' },
  { id: 4, slug: 'anomaly', name: 'Anomaly / Unusual Patterns' },
  { id: 5, slug: 'compliance_audit', name: 'Compliance / Audit Relevance' },
  { id: 6, slug: 'operational_risk', name: 'Operational Risk / Service Health' },
] as const;

// ── LLM Usage ────────────────────────────────────────────────

export interface LlmUsageRecord {
  id: string;
  run_type: string;
  system_id: string | null;
  system_name: string | null;
  window_id: string | null;
  model: string;
  event_count: number;
  token_input: number;
  token_output: number;
  request_count: number;
  cost_estimate: number | null;
  created_at: string;
}

export interface LlmUsageTotals {
  total_input: number | null;
  total_output: number | null;
  total_requests: number | null;
  total_cost: number | null;
}

export interface LlmUsageResponse {
  records: LlmUsageRecord[];
  totals: LlmUsageTotals;
  current_model: string;
  pricing: { input: number; output: number } | null;
}

export async function fetchLlmUsage(opts?: {
  from?: string;
  to?: string;
  system_id?: string;
}): Promise<LlmUsageResponse> {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to) params.set('to', opts.to);
  if (opts?.system_id) params.set('system_id', opts.system_id);
  return apiFetch(`/api/v1/llm-usage?${params}`);
}

// ── Event Search / Explorer ──────────────────────────────────

export interface SearchEventsParams {
  q?: string;
  q_mode?: 'fulltext' | 'contains';
  system_id?: string;
  severity?: string;        // comma-separated
  host?: string;
  program?: string;
  service?: string;
  trace_id?: string;
  from?: string;
  to?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface SearchEventsResponse {
  events: LogEvent[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

export async function searchEvents(params: SearchEventsParams): Promise<SearchEventsResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.q_mode) qs.set('q_mode', params.q_mode);
  if (params.system_id) qs.set('system_id', params.system_id);
  if (params.severity) qs.set('severity', params.severity);
  if (params.host) qs.set('host', params.host);
  if (params.program) qs.set('program', params.program);
  if (params.service) qs.set('service', params.service);
  if (params.trace_id) qs.set('trace_id', params.trace_id);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.sort_by) qs.set('sort_by', params.sort_by);
  if (params.sort_dir) qs.set('sort_dir', params.sort_dir);
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return apiFetch(`/api/v1/events/search?${qs}`);
}

export interface EventFacets {
  severities: string[];
  hosts: string[];
  programs: string[];
  systems: Array<{ id: string; name: string }>;
}

export async function fetchEventFacets(opts?: {
  system_id?: string;
  days?: number;
}): Promise<EventFacets> {
  const qs = new URLSearchParams();
  if (opts?.system_id) qs.set('system_id', opts.system_id);
  if (opts?.days) qs.set('days', String(opts.days));
  return apiFetch(`/api/v1/events/facets?${qs}`);
}

export interface TraceSystemGroup {
  system_id: string;
  system_name: string;
  events: LogEvent[];
}

export interface TraceEventsResponse {
  value: string;
  field: string;
  window: { from: string; to: string };
  total: number;
  systems: TraceSystemGroup[];
  events: LogEvent[];
}

export async function traceEvents(params: {
  value: string;
  field?: 'trace_id' | 'message' | 'all';
  anchor_time?: string;
  window_hours?: number;
  limit?: number;
}): Promise<TraceEventsResponse> {
  const qs = new URLSearchParams();
  qs.set('value', params.value);
  if (params.field) qs.set('field', params.field);
  if (params.anchor_time) qs.set('anchor_time', params.anchor_time);
  if (params.window_hours) qs.set('window_hours', String(params.window_hours));
  if (params.limit) qs.set('limit', String(params.limit));
  return apiFetch(`/api/v1/events/trace?${qs}`);
}

// ── Event Acknowledgement ────────────────────────────────────

export interface AckEventsParams {
  system_id?: string;
  from?: string;
  to?: string;
}

export interface AckEventsResponse {
  acknowledged: number;
  message: string;
}

export async function acknowledgeEvents(params: AckEventsParams): Promise<AckEventsResponse> {
  return apiFetch('/api/v1/events/acknowledge', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function unacknowledgeEvents(params: AckEventsParams): Promise<{ unacknowledged: number; message: string }> {
  return apiFetch('/api/v1/events/unacknowledge', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface AckConfigResponse {
  mode: 'skip' | 'context_only';
  prompt: string;
  default_prompt: string;
}

export async function fetchAckConfig(): Promise<AckConfigResponse> {
  return apiFetch('/api/v1/events/ack-config');
}

export async function updateAckConfig(data: {
  mode?: 'skip' | 'context_only';
  prompt?: string;
}): Promise<AckConfigResponse> {
  return apiFetch('/api/v1/events/ack-config', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Validate an API key against the backend.
 * Returns true if valid, false if 401/403.
 * Throws on network errors so callers can distinguish "bad key" from "server unreachable".
 */
export async function validateApiKey(key: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/api/v1/dashboard/systems`, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
    },
  });
  return res.ok;
}

/**
 * Create an SSE connection for real-time score updates.
 * Note: EventSource does not support custom headers, so the API key is passed
 * as a query parameter. In production, consider using a session-based approach
 * or a custom EventSource polyfill with header support.
 */
export function createScoreStream(onMessage: (data: unknown) => void): EventSource {
  const url = `${BASE_URL}/api/v1/scores/stream`;
  const es = new EventSource(`${url}?key=${encodeURIComponent(getApiKey())}`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch { /* ignore parse errors */ }
  };
  return es;
}
