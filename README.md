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

### UX & UI

- **Real-Time Dashboard** — Live score bars per system across all 6 criteria with automatic SSE-based refresh. Click any score bar to drill into the contributing events with a transparent breakdown showing how much comes from AI meta-analysis vs. individual event scoring.
- **Event Explorer** — Full-text search with instant filtering by system, severity, host, source IP, or program. Paginated results with keyword highlighting, sortable columns, and cross-system event tracing by trace ID or message correlation.
- **AI Findings Panel** — Tabbed interface (Open / Acknowledged / Resolved) with one-click acknowledgment, bulk operations, and automatic lifecycle transitions. The meta-analysis summary is prominently displayed with visual distinction.
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
- **Automated Database Backup** — Scheduled pg_dump backups with configurable format (custom binary or plain SQL), retention limits, and direct download from the UI.

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
Syslog / Log Shippers (Fluent Bit, Vector, Logstash, rsyslog)
    |
    v
Ingest API ── Normalize ── Severity Enrich ── Source Match ── Redact ── Persist (PostgreSQL)
    |
    v
Dedup & Template Extraction ── Per-Event LLM Scoring (6 criteria)
    |
    v
Windowing ── Meta-Analysis (LLM) ── Finding Dedup (TF-IDF + Jaccard)
    |                                       |
    v                                       v
Effective Score Blend            Finding Lifecycle Management
    |                            (severity decay, auto-resolve)
    v
Dashboard (React)  <-->  Alerting (Webhook, Pushover, NTfy, Gotify, Telegram)
    |
    +-- Event Explorer (search, filter, trace, ack)
    +-- AI Findings (open, acknowledged, resolved)
    +-- RAG "Ask AI" (natural language queries)
    +-- Settings (AI config, prompts, notifications, DB, privacy)
    +-- User Management (RBAC, API keys, audit log)
    +-- LLM Usage & Cost Tracking
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 22, Fastify, TypeScript |
| Database | PostgreSQL 14+ (partitioned), Knex.js migrations |
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
| **Maintenance** | `GET/PUT /api/v1/maintenance-config`, `/backup/*` | DB maintenance and backup |
| **Privacy** | `GET/PUT /api/v1/privacy-config` | PII masking configuration |

---

## Project Documentation

| Document | Contents |
|----------|----------|
| [INSTALL.md](./INSTALL.md) | Complete installation and deployment guide |
| [AI_ANALYSIS_SPEC.md](./AI_ANALYSIS_SPEC.md) | Scoring criteria, meta-analysis, dashboard spec |
| [FEATURES_AND_INTEGRATIONS.md](./FEATURES_AND_INTEGRATIONS.md) | Connectors, notifications, feature spec |
| [SECURITY_OWASP.md](./SECURITY_OWASP.md) | OWASP Top 10 compliance mapping |

## License

MIT
