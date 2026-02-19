# LogSentinel AI

**AI-Powered Log Intelligence and SIEM Platform**

LogSentinel AI transforms raw log streams into actionable security and operational intelligence. It continuously collects, normalizes, and stores log events from any source, then applies multi-dimensional AI analysis to surface threats, predict failures, and detect anomalies — all through an intuitive real-time dashboard.

---

## Why LogSentinel AI?

### AI-Powered Analysis

- **6-Criteria Event Scoring** — Every ingested event is evaluated by an LLM across IT Security, Performance Degradation, Failure Prediction, Anomaly Detection, Compliance/Audit, and Operational Risk. Each criterion uses a dedicated, tunable system prompt so domain experts can calibrate the AI's judgment without touching code.
- **Meta-Analysis with Findings** — A sliding-window pipeline aggregates per-event scores into holistic assessments, producing structured findings with full lifecycle management: automatic deduplication (TF-IDF + Jaccard similarity), severity decay, and auto-resolution when issues no longer recur.
- **Content-Based Severity Enrichment** — Syslog header severity is often inaccurate (e.g., Docker logs everything as "info"). The platform scans message bodies for error/warning indicators and upgrades severity automatically, so events like `error: permission denied` are correctly classified.
- **RAG "Ask AI"** — Natural language interface to query your entire event history. Ask questions like *"Were there any failed SSH logins last night?"* or *"Summarize the Docker container issues from the past week"* with persistent chat history.
- **Token Optimization** — Intelligent deduplication via template extraction, score caching, severity pre-filtering, and configurable batch sizing reduce LLM costs by up to 80% without sacrificing analysis quality. Real-time usage tracking with per-model cost estimation keeps spending visible.
- **JSON-Aware Event Grouping** — Structured log messages (Pino, Winston, Bunyan JSON) are automatically unpacked: the inner `msg`/`message` field is extracted for deduplication, preventing unrelated JSON events from collapsing into the same template.
- **Dynamic Pipeline Scheduling** — The analysis pipeline adapts its interval based on activity: faster when events arrive (configurable min, default 15 min), exponential back-off to a configurable max (default 2 hours) during quiet periods, minimizing LLM calls for idle systems.
- **Smart Re-evaluation Flow** — Manual re-evaluation first runs per-event scoring on any unscored events, then recalculates effective scores, then triggers LLM meta-analysis with a fresh context window. Configurable re-evaluation time window (default 7 days) and event cap (default 500).
- **Production-Grade Logging** — Centralized, level-aware logging across all backend modules. Automatic request logging disabled to prevent self-ingestion loops. `LOG_LEVEL` environment variable controls verbosity (default `warn` in production Docker, `info` in development). Fluent Bit self-filter patterns auto-detect project containers by naming convention.

### UX & UI

- **Real-Time Dashboard** — Live score bars per system across all 6 criteria with automatic SSE-based refresh. Click any score bar to drill into the contributing events with a transparent breakdown showing how much comes from AI meta-analysis vs. individual event scoring.
- **Event Explorer** — Full-text search with instant filtering by system, severity, host, source IP, or program. Paginated results with direct page navigation input, keyword highlighting, sortable columns, filtered count indicator, and cross-system event tracing by trace ID or message correlation.
- **AI Findings Panel** — Tabbed interface (Open / Acknowledged / Resolved) with one-click acknowledgment, bulk operations, and automatic lifecycle transitions. Each finding shows a "Show Events" button to view the source events that triggered it. The meta-analysis summary is prominently displayed with visual distinction.
- **Per-Group Event Acknowledgement** — Acknowledge individual event groups directly from the criterion drill-down with a single click. Acknowledged events are excluded from score calculations and meta-analysis. Toggle visibility of acknowledged events with the "Show acknowledged" checkbox.
- **Fully GUI-Configurable** — Every setting is adjustable through the web interface: AI model parameters, system prompts, notification channels, database maintenance schedules, privacy filters, user accounts, and API keys. No SSH or config file editing required after initial deployment.
- **Responsive Alerting** — Visual notification configuration with test buttons for each channel. Define alert rules with severity thresholds, silence windows, throttling, and recovery notifications.

### Security & Privacy

- **Role-Based Access Control (RBAC)** — Three built-in roles (Administrator, Auditor, Monitoring Agent) with 20 granular permissions controlling access to every UI element and API endpoint. Auditors get read-only access; monitoring agents see dashboards and acknowledge events but cannot change settings.
- **User Management** — Username/password authentication with bcrypt hashing (cost 12), mandatory password complexity (12+ chars, mixed case, digits, special characters), automatic account lockout after failed attempts, and forced password change on first login.
- **Session & API Key Security** — Sessions use cryptographically random tokens stored as SHA-256 hashes with configurable expiry. API keys support scope-based permissions, IP allowlists, expiration dates, and one-click revocation.
- **Immutable Audit Log** — Every administrative action is recorded with timestamp, actor, IP address, and full details. A PostgreSQL trigger physically prevents modification or deletion of audit records. Export as CSV or JSON for compliance reporting.
- **Privacy Controls** — PII masking (IP addresses, emails, phone numbers, URLs, MAC addresses, credit cards, passwords, API keys, usernames) with configurable custom regex patterns. Field stripping removes sensitive fields before LLM submission. Bulk event deletion with confirmation safeguard.
- **OWASP Top 10 Compliance** — Parameterized queries (A03), secure headers via Helmet (A05), rate limiting (A04), secrets stored only in environment variables (A02), non-root Docker containers (A05), generic error messages (A07), and comprehensive security logging (A09).

### Scalability

- **Time-Based Table Partitioning** — The events table is automatically partitioned by month. New partitions are created on demand; old data is cleaned up by dropping entire partitions rather than row-by-row deletion, enabling instant cleanup of millions of records.
- **Efficient Indexing** — Composite indexes on system_id + timestamp, severity, source_ip, and full-text search columns. Scheduled REINDEX CONCURRENTLY and VACUUM ANALYZE keep query performance stable as data grows.
- **Configurable Data Retention** — Global and per-system retention policies automatically purge old events. Combined with partitioning, this allows different systems to have different retention windows (e.g., 30 days for debug logs, 365 days for security events).
- **Horizontal Event Ingestion** — The stateless ingest API accepts events in three JSON formats (batch, array, single) from any number of log shippers simultaneously. Compatible with Fluent Bit, Vector, Logstash, rsyslog, and custom HTTP clients.
- **Built-in Log Collector** — Optional Fluent Bit container receives Syslog (UDP/TCP) and OpenTelemetry (OTLP/HTTP + gRPC) and forwards to the ingest API. Deploy with `--profile collector`. ECS fields from OTel/Beats agents are automatically flattened.
- **Automated Database Backup** — Scheduled pg_dump backups with configurable format (custom binary or plain SQL), retention limits, and direct download from the UI.
- **Elasticsearch Integration** — Hybrid event storage: each monitored system can read events directly from an existing Elasticsearch cluster (read-only) while AI analysis results stay in PostgreSQL. Supports multiple ES connections, index browser, field auto-detection, and ECS field flattening. No need to duplicate log data.

### Enterprise-Grade Features

- **Multi-System Monitoring** — Monitor unlimited systems from a single deployment. Each system has independent log source selectors (regex-based field matching with priority ordering), retention policies, and AI analysis pipelines.
- **Flexible Log Source Matching** — Regex-based selectors match incoming events to systems by any combination of fields (host, source_ip, service, program, facility). Priority ordering ensures specific rules take precedence over catch-all rules.
- **Comprehensive Alerting** — Five notification channels (Webhook, Pushover, NTfy, Gotify, Telegram) with configurable rules, severity thresholds, silence windows, throttle intervals, and recovery alerts. Secrets referenced via environment variables — never stored in the database.
- **Compliance Export** — One-click export of events, scores, and findings in CSV or JSON format for regulatory compliance and external auditing.
- **Per-Criterion AI Prompts** — Each of the 6 scoring criteria has an independently configurable system prompt, allowing security teams to inject domain-specific guidance (e.g., *"Flag any SSH brute force patterns"* for IT Security, *"Watch for disk I/O saturation"* for Performance).
- **LLM Provider Flexibility** — Works with any OpenAI-compatible API (OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM). Change models or providers through the GUI without redeployment.

---

## Architecture

```
                   ┌─────────────────────────────────────────────┐
                   │         Log Sources                         │
                   │  Syslog (UDP/TCP)  │  OpenTelemetry (OTLP)  │
                   │  Beats / Logstash  │  Custom HTTP clients   │
                   └────────┬──────────────────┬─────────────────┘
                            │                  │
              ┌─────────────▼──────────┐       │
              │  Fluent Bit Collector  │       │
              │  (--profile collector) │       │
              │  Syslog + OTel inputs  │       │
              └─────────────┬──────────┘       │
                            │                  │
                   ┌────────▼──────────────────▼─────────────────┐
                   │             Ingest API (HTTP)               │
                   │  ECS Flatten → Normalize → Severity Enrich  │
                   │  → Source Match → Privacy Redact → Persist  │
                   └────────┬────────────────────────────────────┘
                            │
         ┌──────────────────▼───────────────────────────────┐
         │  Event Storage                                    │
         │  PostgreSQL (default)  │  Elasticsearch (hybrid)  │
         └──────────┬─────────────────────┬─────────────────┘
                    │                     │
         ┌──────────▼─────────────────────▼─────────────────┐
         │  AI Pipeline                                      │
         │  Dedup → Per-Event Scoring → Windowing            │
         │  → Meta-Analysis → Finding Dedup (TF-IDF)        │
         └────────────────────┬─────────────────────────────┘
                              │
         ┌────────────────────▼─────────────────────────────┐
         │  Dashboard (React)  ←→  Alerting Engine          │
         │  • Event Explorer (search, filter, trace, ack)   │
         │  • AI Findings (open, acknowledged, resolved)    │
         │  • RAG "Ask AI" (natural language queries)       │
         │  • Settings (AI, Elasticsearch, privacy, DB)     │
         │  • User Management (RBAC, API keys, audit log)   │
         │  • LLM Usage & Cost Tracking                     │
         └──────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 22, Fastify, TypeScript |
| Database | PostgreSQL 14+ (partitioned), Knex.js migrations, Elasticsearch 7+/8+ (optional, read-only hybrid) |
| Frontend | React 19, Vite, TypeScript |
| AI | OpenAI-compatible API (GPT-4o-mini, GPT-4o, Ollama, etc.) |
| Auth | bcrypt, SHA-256 session tokens, RBAC (20 permissions) |
| Deployment | Docker, docker-compose, nginx |
| Security | Helmet, CORS, rate limiting, immutable audit log |

---

## Installation Guide

> **See [INSTALL.md](./INSTALL.md) for the complete step-by-step installation guide** covering Docker deployment, standalone installation, syslog forwarder setup, and log shipper integration.

### Quick Start (Docker — 5 minutes)

You only need Docker. AI model and API key are configured via the web UI after first login.

#### Option A — All-in-One (PostgreSQL included)

Everything runs inside Docker — no external database needed.

```bash
git clone https://github.com/PhilipLykov/LogSentinelAI.git
cd LogSentinelAI/docker
cp .env.example .env
# Edit .env: set DB_PASSWORD (pick any strong password) and DB_HOST=postgres
docker compose --profile db up -d --build
```

#### Option B — External PostgreSQL (bring your own database)

Use your existing PostgreSQL server. Only the backend and dashboard run in Docker.

```bash
git clone https://github.com/PhilipLykov/LogSentinelAI.git
cd LogSentinelAI/docker
cp .env.example .env
# Edit .env: set DB_HOST=<your-pg-server-ip> and DB_PASSWORD
docker compose up -d --build
```

#### Optional: Enable Log Collector (Syslog + OpenTelemetry)

Add `--profile collector` to receive logs directly via Syslog and OTel:

```bash
# Set INGEST_API_KEY in .env first (create in Settings > API Keys)
docker compose --profile db --profile collector up -d --build
```

This starts a Fluent Bit container listening on **port 5140** (Syslog UDP/TCP) and **port 4318** (OpenTelemetry OTLP/HTTP + gRPC).

#### First Login

```bash
docker compose logs backend | grep -A 5 "BOOTSTRAP"
# Open http://localhost:8070 in your browser
```

Log in with the displayed username and password. You will be prompted to change the password on first login. Then go to **Settings > AI Model** to configure your LLM API key.

> See **[INSTALL.md](./INSTALL.md)** for detailed setup, LAN/remote access, log shipper integration, syslog forwarder configuration, and troubleshooting.

---

## API Overview

All endpoints require authentication via `Authorization: Bearer <session_token>` header or `X-API-Key` header.

| Category | Endpoints | Description |
|----------|-----------|-------------|
| **Auth** | `POST /api/v1/auth/login`, `/logout`, `/me`, `/change-password` | Session-based authentication |
| **Users** | `GET/POST/PUT/DELETE /api/v1/users` | User CRUD with role assignment |
| **API Keys** | `GET/POST/PUT/DELETE /api/v1/api-keys` | Key management with scopes and IP allowlists |
| **Audit Log** | `GET /api/v1/audit-log`, `/export` | Immutable audit trail with CSV/JSON export |
| **Ingest** | `POST /api/v1/ingest` | Batch event ingestion (3 JSON formats) |
| **Systems** | `GET/POST/PUT/DELETE /api/v1/systems` | Monitored system CRUD |
| **Sources** | `GET/POST/PUT/DELETE /api/v1/sources` | Log source selector CRUD |
| **Events** | `GET /api/v1/events/search`, `/facets`, `/trace` | Search, filter, cross-system trace |
| **Dashboard** | `GET /api/v1/dashboard/systems` | Overview with scores |
| **Scores** | `GET /api/v1/scores/systems`, `/stream` | Effective scores, SSE stream |
| **Findings** | `GET /api/v1/systems/:id/findings` | AI findings with lifecycle |
| **RAG** | `POST /api/v1/ask` | Natural language event queries |
| **AI Config** | `GET/PUT /api/v1/ai-config`, `/ai-prompts` | Model and prompt configuration |
| **Alerting** | `GET/POST/PUT/DELETE /api/v1/notification-channels`, `/notification-rules`, `/silences` | Notification management |
| **Elasticsearch** | `GET/POST/PUT/DELETE /api/v1/elasticsearch/connections`, `/test`, `/:id/indices`, `/:id/mapping`, `/:id/preview` | ES connection CRUD, test, index browser |
| **Database Info** | `GET /api/v1/database/info` | PostgreSQL + Elasticsearch status overview |
| **Maintenance** | `GET/PUT /api/v1/maintenance-config`, `/backup/*` | DB maintenance and backup |
| **Privacy** | `GET/PUT /api/v1/privacy-config` | PII masking configuration |

---

## LLM Cost Optimization

One of the most common concerns when deploying AI-powered log analysis is LLM API cost. LogSentinel AI implements **16 independent optimization techniques** that work together to reduce token usage by up to 80-95% compared to naive per-event analysis — without sacrificing detection quality. All optimizations are **configurable through the web UI** and come with sensible defaults that work out of the box.

### How It Works

```
  Raw Events (thousands/min)
         │
         ▼
  ┌──────────────────────────┐
  │  1. Template Dedup       │── Groups identical message patterns (e.g., 500 identical
  │                          │   "link up/down" events become 1 template with count=500)
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │  2. Pre-Filters          │── Severity filter, normal-behavior filter, privacy filter
  │                          │   skip known-routine events without any LLM call
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │  3. Score Caching        │── Previously scored templates reuse cached results
  │     (TTL: 6 hours)       │   for up to 6 hours (configurable)
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │  4. Batched LLM Calls    │── Remaining templates sent in batches of 20
  │     (20 per call)        │   with truncated messages (512 chars max)
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │  5. Smart Meta-Analysis  │── Zero-score windows skip LLM entirely;
  │                          │   zero-score events filtered from prompt
  └──────────┬───────────────┘
             ▼
     AI Scores & Findings
```

### Optimization Techniques

| # | Technique | Description | Default | UI Configurable |
|---|-----------|-------------|---------|-----------------|
| 1 | **Template Deduplication** | Groups events by message pattern (template extraction). Instead of scoring 500 identical "link up" events, scores 1 template with count=500. This alone typically reduces LLM calls by 90%+ for repetitive log sources. | Always on | — |
| 2 | **Score Caching** | Caches LLM scores per template. If the same message pattern was scored within the TTL window, the cached result is reused. Eliminates redundant calls across pipeline runs. | On (6h TTL) | Yes |
| 3 | **Normal Behavior Filtering** | Events matching user-defined "Mark as Normal" templates are automatically scored at 0 without any LLM call. Operators teach the system what is routine, permanently removing noise from analysis. | On (when templates exist) | Yes |
| 4 | **Severity Pre-Filter** | Events at specified severity levels (e.g., debug) are automatically scored at 0 without LLM calls. Useful for noisy systems that produce thousands of low-value debug events. | Off | Yes |
| 5 | **Low-Score Auto-Skip** | Templates that have been consistently scored near-zero over multiple pipeline runs are automatically scored at 0. The LLM "teaches" the system what is noise, and the system stops asking. | Off | Yes |
| 6 | **Message Truncation** | Event messages are truncated to a configurable maximum length before LLM submission. The diagnostic value is almost always in the first few hundred characters; long stack traces waste tokens. | On (512 chars) | Yes |
| 7 | **Batch Sizing** | Multiple templates are grouped into a single LLM API call. The system prompt is sent once per batch rather than once per event, reducing overhead. | On (20/batch) | Yes |
| 8 | **Zero-Score Window Skip (O1)** | When every event in an analysis window scored 0 during per-event scoring, the meta-analysis LLM call is skipped entirely. A synthetic "no issues" result is written instead. Saves the most for quiet systems. | On | Yes |
| 9 | **Zero-Score Event Filter (O2)** | Events that scored 0 are excluded from the meta-analysis prompt, reducing input tokens. Only events with non-zero scores are sent for higher-level analysis. | On | Yes |
| 10 | **High-Score Prioritization** | Events are sorted by score (descending) before the meta-analysis event cap is applied. This ensures the most important events are always included, even when the cap is reached. | On | Yes |
| 11 | **Meta-Analysis Event Cap** | Hard limit on events sent to meta-analysis per window. Prevents token explosion on very active systems while ensuring analysis quality via high-score prioritization. | On (200 events) | Yes |
| 12 | **Per-Task Model Selection** | Use different models for different tasks: a cheaper model (e.g., `gpt-4o-mini`) for per-event scoring and a more capable model (e.g., `gpt-4o`) for meta-analysis summaries. Optimizes cost-to-quality ratio per task. | Off (uses global model) | Yes |
| 13 | **Configurable Pipeline Interval** | Adjust how frequently the analysis pipeline runs. Adaptive scheduling: resets to minimum on activity, backs off to maximum when idle. | On (15–120 min adaptive) | Yes |
| 14 | **Scoring Limit Per Run** | Caps the number of events scored per pipeline cycle. Prevents budget spikes during log storms while ensuring steady analysis throughput. | On (500/run) | Yes |
| 15 | **Privacy Filtering** | Strips or masks PII fields (IPs, emails, paths, credentials) before LLM submission. Beyond privacy compliance, this reduces token count by removing non-diagnostic data from prompts. | Off | Yes |
| 16 | **Configurable Context Window** | Controls how many previous analysis summaries are included as LLM context. Fewer summaries = fewer input tokens. Adjustable based on how much historical context your analysis needs. | On (5 windows) | Yes |

### Cost Tracking

LogSentinel AI tracks every LLM API call with:
- **Per-request metrics**: model used, input/output tokens, estimated cost (USD)
- **Per-system breakdown**: see which monitored systems consume the most tokens
- **Daily usage charts**: visualize spending trends over time
- **Task-level tracking**: separate tracking for scoring, meta-analysis, and RAG queries

All usage data is accessible through the **Settings > LLM Usage** dashboard in the web UI.

### Typical Cost Profile

With default settings and a moderate log volume (~10,000 events/day across 5 systems), users typically see:

| Model | Estimated Monthly Cost |
|-------|----------------------|
| `gpt-4o-mini` (recommended) | $2 – $10 |
| `gpt-4o` | $15 – $60 |
| Self-hosted (Ollama/vLLM) | $0 (hardware only) |

> These estimates assume template deduplication reduces unique messages to ~5-10% of raw volume, and score caching eliminates ~70% of repeat scoring calls. Actual costs vary based on log volume, message diversity, and optimization settings.

---

## Project Documentation

| Document | Contents |
|----------|----------|
| [CHANGELOG.md](./CHANGELOG.md) | Release history with detailed change notes |
| [INSTALL.md](./INSTALL.md) | Complete installation and deployment guide |
| [AI_ANALYSIS_SPEC.md](./AI_ANALYSIS_SPEC.md) | Scoring criteria, meta-analysis, dashboard spec |
| [FEATURES_AND_INTEGRATIONS.md](./FEATURES_AND_INTEGRATIONS.md) | Connectors, notifications, feature spec |
| [SECURITY_OWASP.md](./SECURITY_OWASP.md) | OWASP Top 10 compliance mapping |

## License

MIT
