# SyslogCollectorAI — AI-Powered Log Audit & Analysis

Enterprise-grade system that **collects** syslog events, **stores** them in PostgreSQL, and **analyzes** them with AI (OpenAI-compatible LLM) across 6 security and operational criteria. Features a real-time React dashboard with event exploration, AI-generated findings, alerting, privacy controls, and database maintenance — all configurable via GUI.

> **Secure by design** — follows [OWASP Top 10](./SECURITY_OWASP.md). All secrets stay in env; no plaintext keys in DB.

## Key Features

- **AI Scoring** — every event is scored across 6 criteria: IT Security, Performance Degradation, Failure Prediction, Anomaly Detection, Compliance/Audit, and Operational Risk
- **Meta-Analysis** — sliding-window analysis produces structured findings with lifecycle management (deduplication via TF-IDF/Jaccard similarity, severity decay, auto-resolution)
- **Event Explorer** — full-text and substring search, filter by system/severity/host/source IP/program, sort, paginate (100 per page), keyword highlighting, EU date format (DD-MM-YYYY)
- **Event Tracing** — cross-system correlation by trace ID, span ID, or message substring
- **Source IP Tracking** — events carry the originating IP address; filterable and sortable in the UI
- **Event Acknowledgment** — bulk ack/unack with configurable LLM behavior (skip or context-only mode)
- **RAG "Ask AI"** — natural language queries across all events with persistent chat history
- **LLM Token Optimization** — score caching by message template, severity pre-filtering, message truncation, configurable batch size, low-score auto-skip
- **Alerting** — rule-based notifications via Webhook, Pushover, NTfy, Gotify, Telegram; silences, throttling, recovery alerts
- **Privacy Controls** — PII masking (IP, email, phone, URL, MAC, credit card, password/secret, API key, username, custom regex), field stripping, bulk event deletion, RAG/LLM usage purge
- **Database Backup** — automated pg_dump backups with configurable schedule, retention, format (custom binary / plain SQL), download & delete from UI
- **Database Maintenance** — per-system data retention, scheduled VACUUM ANALYZE & REINDEX, manual trigger, run history
- **Table Partitioning** — events table auto-partitioned by month for faster queries and instant old-data cleanup via partition drops
- **Configurable Prompts** — system, meta-analysis, and RAG prompts editable via GUI
- **LLM Usage Tracking** — per-request token count and cost estimation with model-aware pricing

## Architecture

```
Syslog / Log Shippers (Fluent Bit, Vector, Logstash, rsyslog)
    |
    v
Ingest API ── Normalize ── Source Match ── Redact ── Persist (PostgreSQL)
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
    +-- Settings (AI config, prompts, notifications, DB maintenance, privacy)
    +-- LLM Usage & Cost Tracking
```

## Quick Start (Development)

### Prerequisites

- **Node.js** >= 20
- **PostgreSQL** >= 14

### 1. Clone & install

```bash
cd backend && npm install
cd ../dashboard && npm install
```

### 2. Configure

```bash
cd backend
cp .env.example .env
# Edit .env — set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, OPENAI_API_KEY
```

### 3. Create the database

```sql
CREATE DATABASE syslog_collector_ai;
CREATE USER syslog_ai WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE syslog_collector_ai TO syslog_ai;
\c syslog_collector_ai
GRANT CREATE ON SCHEMA public TO syslog_ai;
```

### 4. Run backend

```bash
cd backend
npm run dev
```

On first start, the server will:
1. Run all database migrations (17 migration files)
2. Seed the 6 analysis criteria
3. Generate an admin API key (printed to console — **save it**)

### 5. Run dashboard

```bash
cd dashboard
npm run dev
```

Open `http://localhost:5173` and enter your admin API key.

## Docker (Production)

**Prerequisites:** An external PostgreSQL instance (>= 14).

```bash
cd docker
# Edit .env with your DB credentials, OPENAI_API_KEY, etc.
docker compose build
docker compose up -d
```

Services:
- **backend** on port `3000` (API + AI pipeline)
- **dashboard** on port `8070` (React UI via nginx)

The backend container mounts `./backups` for database backup files. These persist across container restarts.

## Syslog Forwarder Setup

To forward local syslog to SyslogCollectorAI, configure rsyslog to write JSON and use the included Python forwarder:

**1. rsyslog template** (`/etc/rsyslog.d/60-syslogcollector.conf`):

```
template(name="SyslogAiJson" type="list") {
    constant(value="{\"timestamp\":\"")
    property(name="timereported" dateFormat="rfc3339")
    constant(value="\",\"message\":\"")
    property(name="msg" format="jsonr" droplastlf="on")
    constant(value="\",\"host\":\"")
    property(name="hostname" format="jsonr")
    constant(value="\",\"source_ip\":\"")
    property(name="fromhost-ip")
    constant(value="\",\"severity\":\"")
    property(name="syslogseverity-text")
    constant(value="\",\"facility\":\"")
    property(name="syslogfacility-text")
    constant(value="\",\"program\":\"")
    property(name="programname" format="jsonr")
    constant(value="\"}\n")
}

if $programname != 'syslog-forwarder.py' then {
    action(type="omfile" file="/var/log/syslog-ai.jsonl" template="SyslogAiJson")
}
```

**2.** Set up the Python forwarder script and systemd service as described in the deployment guide.

## Connecting Log Shippers

The ingest API accepts three JSON formats:
- `{ "events": [...] }` — canonical batch format
- `[{...}, {...}]` — bare JSON array (rsyslog omhttp, Fluent Bit batch)
- `{ "message": "...", ... }` — single event object

### Fluent Bit

```ini
[OUTPUT]
    Name        http
    Match       *
    Host        your-server
    Port        3000
    URI         /api/v1/ingest
    Format      json
    Header      X-API-Key YOUR_INGEST_KEY
    json_date_key timestamp
    json_date_format iso8601
```

### Vector

```toml
[sinks.syslog_ai]
  type = "http"
  inputs = ["your_source"]
  uri = "http://your-server:3000/api/v1/ingest"
  encoding.codec = "json"
  headers.X-API-Key = "YOUR_INGEST_KEY"
```

### Logstash

```ruby
output {
  http {
    url => "http://your-server:3000/api/v1/ingest"
    http_method => "post"
    format => "json"
    headers => { "X-API-Key" => "YOUR_INGEST_KEY" }
  }
}
```

## Accepted Event Fields

| Field | Required | Description |
|-------|----------|-------------|
| `message` / `msg` / `short_message` | **Yes** | Log message content |
| `timestamp` / `time` / `@timestamp` | No | ISO 8601 or Unix epoch (auto-detected) |
| `severity` / `level` | No | Syslog severity name or number |
| `host` / `hostname` / `source` | No | Originating hostname |
| `source_ip` / `fromhost_ip` / `ip` | No | Source IP address |
| `service` / `service_name` | No | Service/application name |
| `program` / `app_name` | No | Program name |
| `facility` | No | Syslog facility |
| `trace_id` / `traceId` | No | Distributed trace ID |
| `span_id` / `spanId` | No | Span ID |
| `external_id` | No | External reference ID |
| `connector_id` | No | Connector identifier |

Unknown fields are preserved in the `raw` JSON column.

## API Endpoints

All endpoints require `X-API-Key` header with appropriate scope.

### Ingest

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/api/v1/ingest` | ingest, admin | Ingest batch of log events |

### Systems & Sources

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/systems` | admin, read, dashboard | List monitored systems |
| `GET` | `/api/v1/systems/:id` | admin, read, dashboard | Get system by ID |
| `POST` | `/api/v1/systems` | admin | Create system (with optional `retention_days`) |
| `PUT` | `/api/v1/systems/:id` | admin | Update system |
| `DELETE` | `/api/v1/systems/:id` | admin | Delete system and all its data |
| `GET` | `/api/v1/sources` | admin, read, dashboard | List log sources |
| `GET` | `/api/v1/sources/:id` | admin, read, dashboard | Get log source by ID |
| `POST` | `/api/v1/sources` | admin | Create log source |
| `PUT` | `/api/v1/sources/:id` | admin | Update log source |
| `DELETE` | `/api/v1/sources/:id` | admin | Delete log source |

### Events & Search

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/events/search` | admin, read, dashboard | Search events (full-text or substring, filter by system/severity/host/source_ip/program, date range, sort, paginate) |
| `GET` | `/api/v1/events/facets` | admin, read, dashboard | Distinct filter values (severities, hosts, source IPs, programs, systems) |
| `GET` | `/api/v1/events/trace` | admin, read, dashboard | Cross-system event correlation by trace_id, span_id, or message |
| `POST` | `/api/v1/events/acknowledge` | admin | Bulk-acknowledge events in a time range |
| `POST` | `/api/v1/events/unacknowledge` | admin | Bulk-unacknowledge events |
| `GET` | `/api/v1/events/ack-config` | admin | Get acknowledgment mode and prompt |
| `PUT` | `/api/v1/events/ack-config` | admin | Update acknowledgment mode (`skip` or `context_only`) and prompt |
| `POST` | `/api/v1/events/bulk-delete` | admin | Delete events in date range (requires `confirmation: "YES"`) |

### Dashboard & Scores

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/dashboard/systems` | admin, read, dashboard | Dashboard overview (all systems with scores) |
| `GET` | `/api/v1/systems/:id/events` | admin, read, dashboard | System events (drill-down) |
| `GET` | `/api/v1/systems/:id/meta` | admin, read, dashboard | Meta-analysis result |
| `GET` | `/api/v1/systems/:id/findings` | admin, read, dashboard | AI findings for a system |
| `PUT` | `/api/v1/findings/:id/acknowledge` | admin | Acknowledge a finding |
| `PUT` | `/api/v1/findings/:id/reopen` | admin | Reopen a finding |
| `GET` | `/api/v1/scores/systems` | admin, read, dashboard | Effective scores per system |
| `GET` | `/api/v1/scores/stream` | admin, read, dashboard | SSE stream of score updates |
| `GET` | `/api/v1/systems/:id/event-scores` | admin, read, dashboard | Scored events for a criterion |
| `GET` | `/api/v1/events/:id/scores` | admin, read, dashboard | All scores for a single event |
| `GET` | `/api/v1/windows` | admin, read, dashboard | List analysis windows |
| `GET` | `/api/v1/windows/:id/meta` | admin, read, dashboard | Meta result for a window |

### RAG (Ask AI)

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/api/v1/ask` | admin, read, dashboard | Ask a natural language question about events |
| `GET` | `/api/v1/ask/history` | admin, read, dashboard | List past Q&A entries |
| `DELETE` | `/api/v1/ask/history` | admin | Clear RAG chat history |

### AI Configuration

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/ai-config` | admin | Get AI model configuration |
| `PUT` | `/api/v1/ai-config` | admin | Update AI model, API key reference, parameters |
| `GET` | `/api/v1/ai-prompts` | admin | Get current system prompts (scoring, meta, RAG) |
| `PUT` | `/api/v1/ai-prompts` | admin | Update system prompts |
| `GET` | `/api/v1/token-optimization` | admin | Get token optimization config |
| `PUT` | `/api/v1/token-optimization` | admin | Update token optimization parameters |
| `POST` | `/api/v1/token-optimization/invalidate-cache` | admin | Clear all template score caches |
| `GET` | `/api/v1/meta-analysis-config` | admin | Get meta-analysis & finding dedup config |
| `PUT` | `/api/v1/meta-analysis-config` | admin | Update meta-analysis parameters |

### Alerting & Notifications

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET/POST/PUT/DELETE` | `/api/v1/notification-channels` | admin | CRUD notification channels |
| `POST` | `/api/v1/notification-channels/:id/test` | admin | Test a notification channel |
| `GET/POST/PUT/DELETE` | `/api/v1/notification-rules` | admin | CRUD alert rules |
| `GET/POST/DELETE` | `/api/v1/silences` | admin | CRUD silences |
| `GET` | `/api/v1/alerts` | admin, read, dashboard | Alert history |

### Database Maintenance

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/maintenance-config` | admin | Get maintenance config, per-system retention, DB stats |
| `PUT` | `/api/v1/maintenance-config` | admin | Update global retention days and maintenance interval |
| `POST` | `/api/v1/maintenance/run` | admin | Trigger a manual maintenance run |
| `GET` | `/api/v1/maintenance/history` | admin | List past maintenance run logs |
| `GET` | `/api/v1/maintenance/backup/config` | admin | Get backup configuration |
| `PUT` | `/api/v1/maintenance/backup/config` | admin | Update backup settings (schedule, retention, format) |
| `POST` | `/api/v1/maintenance/backup/trigger` | admin | Trigger a manual database backup |
| `GET` | `/api/v1/maintenance/backup/list` | admin | List available backup files with sizes |
| `GET` | `/api/v1/maintenance/backup/download/:filename` | admin | Download a backup file |
| `DELETE` | `/api/v1/maintenance/backup/:filename` | admin | Delete a specific backup file |

### Privacy

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/v1/privacy-config` | admin | Get privacy filter settings |
| `PUT` | `/api/v1/privacy-config` | admin | Update PII masking, field stripping, retention settings |
| `POST` | `/api/v1/privacy/test-filter` | admin | Test privacy filter against a sample message |
| `POST` | `/api/v1/privacy/purge-rag-history` | admin | Delete all RAG chat history (requires `confirmation: "YES"`) |
| `POST` | `/api/v1/privacy/purge-llm-usage` | admin | Delete all LLM usage logs (requires `confirmation: "YES"`) |

### Other

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET/PUT` | `/api/v1/config` | admin | General app configuration |
| `GET` | `/api/v1/costs` | admin | LLM cost summary |
| `GET` | `/api/v1/llm-usage` | admin | Detailed LLM usage records with per-request cost |
| `POST` | `/api/v1/export/compliance` | admin | Compliance export (CSV/JSON) |
| `GET/POST/PUT/DELETE` | `/api/v1/connectors` | admin | CRUD pull connectors |
| `GET` | `/api/v1/connectors/types` | admin | Available connector types |

## Redaction

Set `REDACTION_ENABLED=true` to strip secrets/passwords from log content **before** storage and AI analysis. Built-in patterns cover:
- Passwords (`password=`, `passwd=`)
- API keys (`api_key=`, `token=`)
- Bearer tokens (`Authorization: Bearer ...`)
- Connection strings with embedded credentials

Add custom patterns via `REDACTION_PATTERNS` (comma-separated regexes).

## Privacy (LLM Data Filter)

Configurable via the Settings > Privacy tab in the dashboard:
- **PII Masking** — IPv4/IPv6 addresses, email, phone numbers, URLs, user paths, MAC addresses, credit card numbers
- **Custom Patterns** — add your own regex patterns with named replacements
- **Field Stripping** — optionally remove `host` and/or `program` fields before sending to LLM
- **LLM Request Logging** — toggle whether LLM requests are logged to usage history
- **Bulk Deletion** — delete events for a specified date range, protected by YES confirmation
- **Purge AI Data** — clear all RAG chat history and/or LLM usage logs

## Alerting Channels

| Channel | Config keys | Notes |
|---------|------------|-------|
| **Webhook** | `url` | POST JSON payload to URL |
| **Pushover** | `token_ref`, `user_key` | Priority mapped from severity |
| **NTfy** | `base_url`, `topic`, `auth_header_ref?` | Topic should be unguessable |
| **Gotify** | `base_url`, `token_ref` | App token from Gotify server |
| **Telegram** | `token_ref`, `chat_id` | Bot API with MarkdownV2 formatting |

All `*_ref` fields use `env:VAR_NAME` format to reference environment variables (secrets never stored in DB).

## Security (OWASP Top 10)

| Control | Implementation |
|---------|---------------|
| A01 Broken Access Control | API key auth on all endpoints; scope-based access (admin, read, ingest, dashboard) |
| A02 Cryptographic Failures | Keys stored as SHA-256 hashes; secrets from env only |
| A03 Injection | Parameterized queries via Knex; prompt sanitization |
| A04 Insecure Design | Defense-in-depth; rate limiting; audit log |
| A05 Security Misconfiguration | Secure headers (Helmet); non-root Docker; no default passwords |
| A07 Auth Failures | Generic error messages; rate-limited; no key enumeration |
| A09 Security Logging | Structured logs (Europe/Chisinau TZ); no secrets in logs |
| A10 SSRF | URL validation on webhooks, connectors, notification channels |

See [SECURITY_OWASP.md](./SECURITY_OWASP.md) for full details.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 22, Fastify, TypeScript |
| Database | PostgreSQL 14+, Knex.js migrations |
| Frontend | React 19, Vite, TypeScript |
| AI | OpenAI-compatible API (GPT-4o, etc.) |
| Deployment | Docker, docker-compose |
| Security | Helmet, CORS, rate limiting, SHA-256 key hashing |

## Project Documentation

| Document | Contents |
|----------|----------|
| [PROJECT_INSTRUCTIONS.md](./PROJECT_INSTRUCTIONS.md) | User requirements |
| [AI_ANALYSIS_SPEC.md](./AI_ANALYSIS_SPEC.md) | Scoring criteria, meta-analysis, dashboard spec |
| [FEATURES_AND_INTEGRATIONS.md](./FEATURES_AND_INTEGRATIONS.md) | Connectors, notifications, feature spec |
| [SECURITY_OWASP.md](./SECURITY_OWASP.md) | OWASP Top 10 mapping |

## License

MIT
