# SyslogCollectorAI v0.7.0-beta — First Public Release

**Intelligent Log Monitoring Platform with AI-Powered Analysis**

SyslogCollectorAI transforms raw syslog streams into actionable security and operational intelligence. It collects, normalizes, and stores log events, then applies multi-dimensional AI analysis to surface threats, predict failures, and detect anomalies — all through an intuitive real-time dashboard.

---

## Highlights

### AI-Powered Analysis
- **6-Criteria Event Scoring** — Every event evaluated by LLM across IT Security, Performance, Failure Prediction, Anomaly Detection, Compliance, and Operational Risk
- **Meta-Analysis with Findings** — Sliding-window pipeline with deduplication (TF-IDF + Jaccard), severity decay, and auto-resolution
- **Content-Based Severity Enrichment** — Automatically upgrades syslog severity based on message content patterns
- **RAG "Ask AI"** — Natural language queries across your entire event history with persistent chat
- **Token Optimization** — Score caching, deduplication, severity filtering — up to 80% LLM cost reduction
- **Per-Criterion Prompts** — Each scoring criterion has an independently tunable system prompt

### Security & Privacy
- **Role-Based Access Control (RBAC)** — Administrator, Auditor, Monitoring Agent roles with 20 granular permissions
- **User Management** — bcrypt password hashing, account lockout, mandatory password complexity, forced change on first login
- **Session & API Key Security** — SHA-256 hashed tokens, IP allowlists, expiration, scope-based permissions
- **Immutable Audit Log** — PostgreSQL trigger prevents modification/deletion; CSV/JSON export
- **Privacy Controls** — PII masking (11 categories + custom regex), field stripping, bulk deletion with confirmation
- **OWASP Top 10 Compliance** — Parameterized queries, Helmet headers, rate limiting, non-root Docker

### UX & UI
- **Real-Time Dashboard** — Live SSE-based score updates across all systems and criteria
- **Event Explorer** — Full-text search, filtering, sorting, pagination, keyword highlighting, cross-system tracing
- **AI Findings Panel** — Tabbed (Open/Acknowledged/Resolved) with one-click actions and bulk operations
- **Fully GUI-Configurable** — All settings adjustable via web UI: AI model, prompts, notifications, DB maintenance, privacy, users, API keys

### Scalability & Enterprise
- **Self-Contained Docker Compose** — PostgreSQL + Backend + Dashboard in one command
- **Time-Based Table Partitioning** — Monthly auto-partitioned events table for fast queries and instant cleanup
- **Per-System Data Retention** — Different retention policies per system
- **Automated Database Backup** — Scheduled pg_dump with configurable format, retention, and UI download
- **5 Notification Channels** — Webhook, Pushover, NTfy, Gotify, Telegram with silence windows and recovery alerts
- **LLM Provider Flexibility** — Works with OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM
- **Multi-System Monitoring** — Regex-based log source selectors with priority ordering

---

## Quick Start

```bash
git clone https://github.com/PhilipLykov/SyslogCollectorAI.git
cd SyslogCollectorAI/docker
cp .env.example .env
# Edit .env: set DB_PASSWORD and OPENAI_API_KEY
docker compose up -d --build
docker compose logs backend | grep -A 5 "BOOTSTRAP"
# Open http://localhost:8070
```

See [INSTALL.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/INSTALL.md) for the complete deployment guide.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 22, Fastify, TypeScript |
| Database | PostgreSQL 16 (partitioned), Knex.js |
| Frontend | React 19, Vite, TypeScript |
| AI | OpenAI-compatible API |
| Auth | bcrypt, SHA-256 sessions, RBAC |
| Deployment | Docker Compose, nginx |

## Known Limitations (Beta)

- No multi-tenancy (single-organization deployment)
- No SSO/SAML/OIDC integration yet
- Dashboard is English-only
- No built-in TLS termination (use a reverse proxy like nginx/Traefik)

---

**Full documentation**: [README.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/README.md) | [INSTALL.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/INSTALL.md)
