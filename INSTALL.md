# Installation Guide

This guide walks you through installing SyslogCollectorAI from start to finish. Choose the deployment method that fits your environment.

---

## Table of Contents

1. [Quick Start (Docker)](#1-quick-start-docker)
2. [Accessing the Dashboard](#2-accessing-the-dashboard)
3. [Docker Deployment — Detailed](#3-docker-deployment--detailed)
4. [Standalone Deployment (Without Docker)](#4-standalone-deployment-without-docker)
5. [Configuring Your First Monitored System](#5-configuring-your-first-monitored-system)
6. [Connecting Log Sources](#6-connecting-log-sources)
7. [Syslog Forwarder Setup (rsyslog + Python)](#7-syslog-forwarder-setup-rsyslog--python)
8. [Log Shipper Integration](#8-log-shipper-integration)
9. [LLM Configuration](#9-llm-configuration)
10. [Alerting Setup](#10-alerting-setup)
11. [Backup & Maintenance](#11-backup--maintenance)
12. [Upgrading](#12-upgrading)
13. [Troubleshooting](#13-troubleshooting)
14. [Environment Variable Reference](#14-environment-variable-reference)

---

## 1. Quick Start (Docker)

Get up and running in under 5 minutes.

### Prerequisites

- **Docker** 20.10+ with **Docker Compose** v2
- An **OpenAI API key** (optional — configurable via UI after first login)
- **PostgreSQL 14+** (optional — a bundled PostgreSQL is available)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/PhilipLykov/SyslogCollectorAI.git
cd SyslogCollectorAI/docker

# 2. Create your configuration
cp .env.example .env

# 3. Edit .env — set these values:
#    DB_HOST=<your-postgresql-server>   (or "postgres" for bundled)
#    DB_PASSWORD=<pick-a-strong-database-password>
```

**Option A** — External PostgreSQL (you manage your own DB server):
```bash
# Set DB_HOST=your-pg-server-ip in .env, then:
docker compose up -d --build
```

**Option B** — Bundled PostgreSQL (all-in-one, no external DB needed):
```bash
# Set DB_HOST=postgres in .env, then:
docker compose --profile db up -d --build
```

```bash
# 4. Check the backend logs for your admin credentials
docker compose logs backend | grep -A 5 "BOOTSTRAP"
```

Open **http://localhost:8070** in your browser and log in with the credentials from step 4.

> **That's it!** The backend and dashboard are running. Continue reading for detailed configuration, LAN/remote access, or advanced topics.

---

## 2. Accessing the Dashboard

### First Login

1. Open the dashboard URL in your browser (default: `http://localhost:8070`).
2. Enter the admin credentials displayed in the backend startup logs.
3. If the password was auto-generated, you will be prompted to set a new password immediately.
   - Requirements: at least **12 characters**, with uppercase, lowercase, digit, and special character.
4. After login, you will see the main dashboard.

### Setting a Custom Admin Password

To avoid the auto-generated password, set these in your `.env` before the first start:

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YourSecurePassword123!
```

> **Important**: These only take effect on the very first startup (when no users exist in the database). If users already exist, changing these variables has no effect. To reset, see [Troubleshooting > Cannot log in](#cannot-log-in).

### Accessing from Another Machine (LAN/Remote)

If you want to access the dashboard from another computer on your network, edit `.env` before building:

```bash
# Replace with your server's IP address
VITE_API_URL=http://192.168.1.100:3000
CORS_ORIGIN=http://192.168.1.100:8070
```

Then rebuild the dashboard (the URL is baked in at build time):

```bash
docker compose up -d --build dashboard
```

---

## 3. Docker Deployment — Detailed

### What's Included

The `docker-compose.yml` runs two core services plus an optional bundled database:

| Service | Image | Port | Profile | Description |
|---------|-------|------|---------|-------------|
| **postgres** | `postgres:16-alpine` | 5432 (localhost only) | `db` (opt-in) | Bundled PostgreSQL — only starts with `--profile db` |
| **backend** | Custom (Node.js 22) | 3000 | *(always)* | API server + AI analysis pipeline |
| **dashboard** | Custom (nginx) | 8070 | *(always)* | React web interface |

> **If you already have a PostgreSQL server**, just run `docker compose up -d` (no `--profile`). The bundled postgres container will **not** start.
>
> **If you need a bundled database**, run `docker compose --profile db up -d`.

Data is stored in Docker named volumes:
- `pgdata` — PostgreSQL database files (only used with `--profile db`)
- `backups` — Database backup files

### All Configuration Options

Copy `.env.example` to `.env` and edit:

```bash
cd docker
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | **Yes** | `localhost` | PostgreSQL hostname (use `postgres` for bundled DB) |
| `DB_PASSWORD` | **Yes** | — | Database password (pick any strong password) |
| `DB_NAME` | No | `syslog_collector_ai` | Database name |
| `DB_USER` | No | `syslog_ai` | Database username |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `VITE_API_URL` | No | `http://localhost:3000` | Backend URL as seen by the browser |
| `DASHBOARD_PORT` | No | `8070` | Dashboard listen port |
| `CORS_ORIGIN` | No | `http://localhost:8070` | Allowed CORS origin |
| `PORT` | No | `3000` | Backend listen port |
| `ADMIN_USERNAME` | No | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | No | *(auto-generated)* | Initial admin password (min 12 chars) |
| `PIPELINE_INTERVAL_MS` | No | `300000` | AI pipeline interval (ms) |
| `REDACTION_ENABLED` | No | `false` | Strip secrets before storage |
| `TZ` | No | `Europe/Chisinau` | Application timezone |
| `DB_EXTERNAL_PORT` | No | `127.0.0.1:5432` | Expose PostgreSQL to host network |

### Managing the Stack

```bash
# Start all services
docker compose up -d

# View logs (all services)
docker compose logs -f

# View backend logs only
docker compose logs -f backend

# Stop all services
docker compose down

# Stop and remove ALL data (database, backups — destructive!)
docker compose down -v

# Rebuild after code changes
docker compose up -d --build
```

### Using an External PostgreSQL Database

By default (without `--profile db`), the bundled PostgreSQL does **not** start. Set your external database connection in `.env`:

```bash
DB_HOST=192.168.1.100
DB_PORT=5432
DB_NAME=syslog_collector_ai
DB_USER=syslog_ai
DB_PASSWORD=your_password
```

Then simply run:

```bash
docker compose up -d --build
```

Ensure the external database exists and the user has `CREATE` permission on the `public` schema:

```sql
CREATE DATABASE syslog_collector_ai;
CREATE USER syslog_ai WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE syslog_collector_ai TO syslog_ai;
\c syslog_collector_ai
GRANT CREATE ON SCHEMA public TO syslog_ai;
```

---

## 4. Standalone Deployment (Without Docker)

Use this method if you prefer to run Node.js directly on your server.

### Prerequisites

- **Node.js** 20+ (22 recommended)
- **npm** 9+
- **PostgreSQL** 14+

### Step 1: Clone and install dependencies

```bash
git clone https://github.com/PhilipLykov/SyslogCollectorAI.git
cd SyslogCollectorAI

cd backend && npm install
cd ../dashboard && npm install
cd ..
```

### Step 2: Create the PostgreSQL database

```sql
CREATE DATABASE syslog_collector_ai;
CREATE USER syslog_ai WITH PASSWORD 'your_strong_password_here';
GRANT ALL PRIVILEGES ON DATABASE syslog_collector_ai TO syslog_ai;
\c syslog_collector_ai
GRANT CREATE ON SCHEMA public TO syslog_ai;
```

### Step 3: Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env` with your database credentials and API key. See the [Environment Variable Reference](#14-environment-variable-reference) for all options.

### Step 4: Start the backend

```bash
cd backend
npm run build
npm start
```

On first start, the backend will:
1. Run all database migrations automatically
2. Seed the 6 analysis criteria
3. Create the admin user (credentials printed to console)

### Step 5: Build and serve the dashboard

```bash
cd dashboard
VITE_API_URL=http://localhost:3000 npm run build
```

Serve the `dashboard/dist/` folder with any web server. Example with nginx:

```nginx
server {
    listen 8070;
    root /path/to/SyslogCollectorAI/dashboard/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Or for quick testing:

```bash
npx serve -s dist -l 8070
```

---

## 5. Configuring Your First Monitored System

After logging in, go to **Settings > Systems & Sources**.

### Create a system

1. Click **+ Add** in the left panel.
2. Enter a name (e.g., `Production Server`) and optional description.
3. Optionally set a data retention period (e.g., 90 days). Leave empty for the global default.
4. Click **Save**.

### Add a log source

Log sources use regex-based selectors to match incoming events to your system.

1. Select your new system in the left panel.
2. Click **+ Add Source**.
3. Set a label (e.g., `All events from 192.168.1.x`).
4. Define the selector — a JSON object of field-matching rules:

| Selector | Matches |
|----------|---------|
| `{"source_ip": "^192\\.168\\.1\\."}` | Events from the 192.168.1.x subnet |
| `{"host": "^prod-server"}` | Hosts starting with "prod-server" |
| `{"program": "^nginx"}` | Events from nginx |
| `{"host": ".*"}` | Everything (catch-all) |

5. Set priority (lower number = evaluated first). Use low priorities for specific rules and higher (e.g., 100) for catch-all rules.
6. Click **Save**.

> **Tip**: Expand the "How selectors work" section on the settings page for more examples.

---

## 6. Connecting Log Sources

Before events appear in the dashboard, you need to send them to the ingest API.

### Create an API key for ingestion

1. Go to **Settings > API Keys**.
2. Click **+ Create API Key**.
3. Set a name (e.g., `syslog-forwarder`), scope to **ingest**, and click **Create**.
4. **Copy the displayed key immediately** — it will not be shown again.

### Test ingestion

```bash
curl -X POST http://localhost:3000/api/v1/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_INGEST_KEY" \
  -d '{"events": [{"message": "Test event from curl", "host": "test-host", "severity": "info"}]}'
```

If configured correctly, the event will appear in the Event Explorer within seconds.

---

## 7. Syslog Forwarder Setup (rsyslog + Python)

This section explains how to forward local syslog events from a Linux server.

### Step 1: Configure rsyslog to write JSON

Create `/etc/rsyslog.d/60-syslogcollector.conf`:

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

```bash
sudo systemctl restart rsyslog
```

### Step 2: Create the forwarder script

Create `/opt/syslog-forwarder/syslog-forwarder.py`:

```python
#!/usr/bin/env python3
"""Forward JSON syslog lines to SyslogCollectorAI ingest API."""

import json, time, os, sys, urllib.request, urllib.error
from datetime import datetime

JSONL_PATH = os.environ.get("JSONL_PATH", "/var/log/syslog-ai.jsonl")
API_URL    = os.environ.get("API_URL", "http://localhost:3000/api/v1/ingest")
API_KEY    = os.environ.get("API_KEY", "")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "500"))
POLL_SEC   = int(os.environ.get("POLL_SEC", "5"))

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def send_batch(events):
    data = json.dumps({"events": events}).encode()
    req = urllib.request.Request(API_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Key", API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            log(f"POST OK ({len(events)} events): {resp.status}")
    except urllib.error.HTTPError as e:
        log(f"POST failed ({len(events)} events): {e}")
    except Exception as e:
        log(f"POST error: {e}")

def main():
    if not API_KEY:
        log("ERROR: API_KEY not set"); sys.exit(1)
    log(f"Starting: file={JSONL_PATH} api={API_URL} batch={BATCH_SIZE}")

    try:
        pos = os.path.getsize(JSONL_PATH)
    except FileNotFoundError:
        pos = 0

    while True:
        try:
            with open(JSONL_PATH, "r") as f:
                f.seek(pos)
                batch = []
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        batch.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                    if len(batch) >= BATCH_SIZE:
                        send_batch(batch)
                        batch = []
                if batch:
                    send_batch(batch)
                pos = f.tell()
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f"Read error: {e}")
        time.sleep(POLL_SEC)

if __name__ == "__main__":
    main()
```

```bash
chmod +x /opt/syslog-forwarder/syslog-forwarder.py
```

### Step 3: Create a systemd service

Create `/etc/systemd/system/syslog-forwarder.service`:

```ini
[Unit]
Description=Syslog Forwarder to SyslogCollectorAI
After=network.target rsyslog.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/syslog-forwarder/syslog-forwarder.py
Environment=JSONL_PATH=/var/log/syslog-ai.jsonl
Environment=API_URL=http://your-server:3000/api/v1/ingest
Environment=API_KEY=YOUR_INGEST_API_KEY
Environment=BATCH_SIZE=500
Environment=POLL_SEC=5
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now syslog-forwarder
sudo systemctl status syslog-forwarder
```

---

## 8. Log Shipper Integration

The ingest API accepts three JSON formats:
- `{ "events": [...] }` — batch format (recommended)
- `[{...}, {...}]` — bare JSON array
- `{ "message": "...", ... }` — single event

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

### Accepted Event Fields

| Field | Required | Description |
|-------|----------|-------------|
| `message` / `msg` / `short_message` | **Yes** | Log message content |
| `timestamp` / `time` / `@timestamp` | No | ISO 8601 or Unix epoch |
| `severity` / `level` | No | Syslog severity name or number (0-7) |
| `host` / `hostname` / `source` | No | Originating hostname |
| `source_ip` / `fromhost_ip` / `ip` | No | Source IP address |
| `service` / `service_name` | No | Service/application name |
| `program` / `app_name` | No | Program name |
| `facility` | No | Syslog facility |
| `trace_id` / `traceId` | No | Distributed trace ID |
| `span_id` / `spanId` | No | Span ID |

Unknown fields are preserved in a `raw` JSON column.

---

## 9. LLM Configuration

Go to **Settings > AI Model** after login.

| Setting | Description | Recommended |
|---------|-------------|-------------|
| **Model** | LLM model name | `gpt-4o-mini` (cost), `gpt-4o` (quality) |
| **API Base URL** | For non-OpenAI (Ollama, LM Studio, Azure) | — |
| **Temperature** | Randomness (0.0-1.0) | 0.1-0.3 |
| **System Prompts** | Scoring, meta-analysis, RAG prompts | Edit to match your domain |
| **Per-Criterion Prompts** | Individual instructions for each of the 6 criteria | Fine-tune for your environment |
| **Token Optimization** | Caching, filtering, truncation, batch size | Enable all for cost savings |

The AI pipeline runs every 5 minutes by default (configurable via `PIPELINE_INTERVAL_MS`).

---

## 10. Alerting Setup

Go to **Settings > Notifications**.

### Step 1: Create a notification channel

| Channel | Required Config | Notes |
|---------|----------------|-------|
| **Webhook** | `url` | POST JSON to any URL |
| **Pushover** | `token_ref`, `user_key` | Use `env:PUSHOVER_TOKEN` format |
| **NTfy** | `base_url`, `topic` | Topic should be unguessable |
| **Gotify** | `base_url`, `token_ref` | Use `env:GOTIFY_APP_TOKEN` format |
| **Telegram** | `token_ref`, `chat_id` | Use `env:TELEGRAM_BOT_TOKEN` format |

All `*_ref` fields use `env:VAR_NAME` format to reference environment variables — secrets are never stored in the database.

Click **Test** to verify the channel works.

### Step 2: Create alert rules

- Select criteria to monitor and set score thresholds
- Choose notification channels
- Configure throttle interval and recovery alerts

### Step 3: Manage silences

Create silence windows to suppress notifications during maintenance.

---

## 11. Backup & Maintenance

### Database Backup

Go to **Settings > Database > Backup Configuration**:

- **Schedule**: How often backups run (e.g., daily)
- **Format**: Custom binary (smaller) or plain SQL (human-readable)
- **Retention**: How many backup files to keep
- **Actions**: Manual trigger, download, delete from UI

### Data Retention

- **Global**: Default retention for all systems
- **Per-system**: Override per system (e.g., 30 days for debug, 365 for security)
- **Maintenance**: Automatic VACUUM ANALYZE and REINDEX

---

## 12. Upgrading

### Docker

```bash
cd SyslogCollectorAI
git pull
cd docker
docker compose up -d --build
```

Database migrations run automatically — no manual steps needed.

### Standalone

```bash
cd SyslogCollectorAI
git pull

cd backend
npm install
npm run build
# Restart the backend process

cd ../dashboard
npm install
VITE_API_URL=http://your-server:3000 npm run build
# Restart the dashboard web server
```

---

## 13. Troubleshooting

### Events not appearing in the dashboard

1. **Check log source selectors**: Go to Settings > Systems & Sources. Ensure selectors match your events. For example, if events have `source_ip: "127.0.0.1"`, use `{"source_ip": "127.0.0.1"}` or `{"source_ip": ".*"}`.

2. **Check the forwarder**:
   ```bash
   journalctl -u syslog-forwarder --no-pager -n 20
   ```

3. **Test ingestion manually**:
   ```bash
   curl -X POST http://your-server:3000/api/v1/ingest \
     -H "Content-Type: application/json" \
     -H "X-API-Key: YOUR_KEY" \
     -d '[{"message": "test", "host": "test", "source_ip": "127.0.0.1"}]'
   ```

### Cannot log in

If you forgot the admin password, reset by deleting users from the database:

```bash
# If using bundled PostgreSQL (--profile db):
docker compose exec postgres psql -U syslog_ai -d syslog_collector_ai \
  -c "DELETE FROM sessions; DELETE FROM users;"

# If using external PostgreSQL:
psql -h your-pg-host -U syslog_ai -d syslog_collector_ai \
  -c "DELETE FROM sessions; DELETE FROM users;"

# Then restart backend and check logs for new credentials:
docker compose restart backend
docker compose logs backend | grep -A 5 "BOOTSTRAP"
```

### Backend fails to start

- Check logs: `docker compose logs backend`
- Verify PostgreSQL is healthy: `docker compose ps`
- Ensure `.env` has valid `DB_PASSWORD`

### Dashboard shows "Network Error"

- The `VITE_API_URL` in `.env` must be reachable from your browser (not from the container).
- For LAN access, use the server's IP address, not `localhost`.
- After changing `VITE_API_URL`, rebuild: `docker compose up -d --build dashboard`

### High LLM costs

- Settings > AI Model > Token Optimization: enable caching, severity filtering, batch sizing
- Switch to `gpt-4o-mini` if using a more expensive model

### Backup fails with "Permission denied"

Docker: the entrypoint script automatically fixes permissions. If issues persist:
```bash
docker compose exec backend sh -c "ls -la /app/data/backups/"
```

---

## 14. Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | **Yes** | `localhost` | PostgreSQL hostname (set to `postgres` for bundled DB) |
| `DB_PASSWORD` | **Yes** | — | PostgreSQL password |
| `DB_NAME` | No | `syslog_collector_ai` | Database name |
| `DB_USER` | No | `syslog_ai` | Database username |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `OPENAI_API_KEY` | No | — | LLM API key fallback (prefer Settings > AI Model in UI) |
| `PORT` | No | `3000` | Backend listen port |
| `HOST` | No | `0.0.0.0` | Backend bind address |
| `DASHBOARD_PORT` | No | `8070` | Dashboard listen port |
| `VITE_API_URL` | No | `http://localhost:3000` | Backend URL as seen by browser |
| `CORS_ORIGIN` | No | `http://localhost:8070` | Allowed CORS origin |
| `ADMIN_USERNAME` | No | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | No | *(generated)* | Initial admin password (min 12 chars) |
| `REDACTION_ENABLED` | No | `false` | Enable secret redaction |
| `PIPELINE_INTERVAL_MS` | No | `300000` | AI pipeline run interval (ms) |
| `TZ` | No | `Europe/Chisinau` | Timezone for application logs |
| `DB_EXTERNAL_PORT` | No | `127.0.0.1:5432` | Expose PostgreSQL to host |
