# SyslogCollectorAI v0.7.2-beta — Security Hardening & Consistency

**Comprehensive security hardening, audit coverage, CSS/UI consistency, and Docker reliability improvements.**

Upgrade from v0.7.0 or v0.7.1 is strongly recommended.

---

## What's New in v0.7.2

### Security Hardening

- **ILIKE Wildcard Injection Fix** — User input in event search, trace search, and audit log actor filter is now escaped for `%` and `_` wildcards before ILIKE queries, preventing pattern injection (OWASP A03).
- **Multi-Permission Auth** — `requireAuth()` now accepts an array of permissions (OR logic), enabling finer-grained access control on shared endpoints.
- **Systems Audit Logging** — Create, update, and delete operations on monitored systems now produce immutable audit log entries. Previously the only CRUD module without audit coverage.
- **Date Validation Order** — Event acknowledge/unacknowledge endpoints now validate date inputs *before* parsing, preventing uncaught exceptions on malformed dates.

### Bug Fixes — Backend (v0.7.1 + v0.7.2)

- **Transactional Role Operations** — Role creation and permission updates wrapped in DB transactions.
- **Invalid Role Rejection** — Creating a user with a non-existent role returns HTTP 400 instead of silently defaulting.
- **Unknown Permission Rejection** — Invalid permission names return HTTP 400 instead of being silently dropped.
- **Administrator Protection** — Cannot strip all permissions from the `administrator` role via API.
- **Cache TTL Fix** — Synchronous permission cache respects the 30-second TTL.
- **Roles Read Access** — GET `/api/v1/roles` now accepts either `users:manage` or `roles:manage` permission, so custom roles with only `roles:manage` can use the roles editor.
- **Logging Consistency** — `localTimestamp()` added to all remaining log statements (redact.ts, API key errors).

### Bug Fixes — Frontend (v0.7.1 + v0.7.2)

- **Missing CSS Variables** — Added `--danger`, `--muted`, and `--surface` to `:root`. Inline styles referencing these now render correctly.
- **Missing CSS Classes** — Added `btn-success-outline`, `btn-primary`, and `badge-ok`. Buttons and badges previously had no visual styling.
- **CSS Selector Fix** — `.tok-opt-row input` selector updated to match `NumericInput` rendered type (`text` instead of `number`).
- **Input Type Consistency** — Replaced all remaining `type="number"` inputs in SystemForm and SourceForm with `type="text" inputMode="numeric"` to prevent snapping.
- **Audit Log Export Dates** — Export now converts EU dates to ISO format before sending to server.
- **Role Editor** — Dirty state no longer polluted by Create modal; edit form re-syncs after save.
- **User Management Fallback** — Role dropdown shows defaults when API is unavailable.
- **NumericInput NaN Guard** — Displays `0`/`min` instead of literal "NaN" text.
- **Date Format** — All dates across the entire dashboard consistently use `DD-MM-YYYY` format.
- **Number Inputs** — All numeric inputs allow free clearing before typing a new value.

### Docker & Infrastructure

- **Health-Aware Startup** — Backend now waits for PostgreSQL health check when using `--profile db`. Dashboard waits for backend.
- **Version Alignment** — Backend and dashboard `package.json` versions synchronized to `0.7.2`.

### Documentation

- **INSTALL.md** — OpenAI API key correctly marked as optional; troubleshooting section updated.
- **RELEASE_NOTES.md** — Comprehensive changelog for all changes since v0.7.0.

---

## Deployment Options

### Option A — All-in-One (PostgreSQL included)

Everything runs inside Docker — no external database needed.

```bash
git clone https://github.com/PhilipLykov/SyslogCollectorAI.git
cd SyslogCollectorAI/docker
cp .env.example .env
# Edit .env: set DB_PASSWORD (pick any strong password)
# Set DB_HOST=postgres

docker compose --profile db up -d --build
docker compose logs backend | grep -A 5 "BOOTSTRAP"
# Open http://localhost:8070
```

### Option B — External PostgreSQL (bring your own database)

Backend and dashboard run in Docker; you point them at your existing PostgreSQL server.

```bash
git clone https://github.com/PhilipLykov/SyslogCollectorAI.git
cd SyslogCollectorAI/docker
cp .env.example .env
# Edit .env: set DB_HOST=<your-pg-server> and DB_PASSWORD

docker compose up -d --build
docker compose logs backend | grep -A 5 "BOOTSTRAP"
# Open http://localhost:8070
```

> AI model and API key are configured after login via **Settings > AI Model** in the web UI.

See [INSTALL.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/INSTALL.md) for the complete deployment guide.

## Upgrading from v0.7.0 or v0.7.1

```bash
cd SyslogCollectorAI
git pull
cd docker
docker compose up -d --build
# Migrations run automatically on startup
```

---

**Full documentation**: [README.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/README.md) | [INSTALL.md](https://github.com/PhilipLykov/SyslogCollectorAI/blob/master/INSTALL.md)
