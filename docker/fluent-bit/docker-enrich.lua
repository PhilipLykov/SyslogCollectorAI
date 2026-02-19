-- ─────────────────────────────────────────────────────────────────────
--  LogSentinel AI — Docker Container Log Enrichment (Fluent Bit Lua)
-- ─────────────────────────────────────────────────────────────────────
--
--  This script runs as a Fluent Bit Lua filter on records tagged
--  "docker.*" (from the tail input reading Docker json-file logs).
--
--  What it does:
--    1. Extracts the container ID from the log file path
--    2. Reads Docker's config.v2.json to resolve the container name
--    3. Caches the name (one file read per container, ever)
--    4. Sets "program" to the container name
--    5. Extracts severity from message content (bracketed, key=value,
--       JSON structured logs) — only falls back to stream=stderr if
--       no severity is detected in the message itself
--    6. Unpacks JSON structured logs (extracts msg/level fields)
--    7. Strips embedded timestamps, ANSI escape codes, trailing whitespace
--    8. Drops empty messages and Fluent Bit's own logs (prevents loop)
--    9. Sets facility=daemon for all Docker container logs
--   10. Cleans up internal fields (log_path, stream)
--
--  Requirements:
--    - /var/lib/docker/containers must be mounted into the Fluent Bit
--      container (read-only is fine)
--    - Path_Key must be set to "log_path" on the tail input
-- ─────────────────────────────────────────────────────────────────────

-- Cache: container_id → container_name (populated lazily, never evicted)
local name_cache = {}

-- Patterns in the container name that identify the log-collector itself.
-- Events from these containers are dropped to avoid a feedback loop.
local SELF_PATTERNS = {
    "%-backend",
    "%-dashboard",
    "%-log%-collector",
    "fluent%-bit",
    "fluent_bit",
    "fluentbit",
}

-- ── Severity alias → canonical syslog name ───────────────────────
-- Maps common severity/level strings (lowercased) to the canonical
-- syslog severity names that the backend expects.
local SEVERITY_MAP = {
    -- Canonical syslog names (identity mappings)
    ["emerg"]     = "emerg",
    ["alert"]     = "alert",
    ["crit"]      = "critical",
    ["critical"]  = "critical",
    ["err"]       = "error",
    ["error"]     = "error",
    ["warning"]   = "warning",
    ["warn"]      = "warning",
    ["notice"]    = "notice",
    ["info"]      = "info",
    ["informational"] = "info",
    ["debug"]     = "debug",
    ["trace"]     = "debug",
    -- Numeric syslog severity levels (as strings)
    ["0"]         = "emerg",
    ["1"]         = "alert",
    ["2"]         = "critical",
    ["3"]         = "error",
    ["4"]         = "warning",
    ["5"]         = "notice",
    ["6"]         = "info",
    ["7"]         = "debug",
    -- Common application aliases
    ["fatal"]     = "emerg",
    ["panic"]     = "emerg",
    ["severe"]    = "critical",
    ["information"] = "info",
}

-- ── A1: Extract severity from plain-text message content ─────────
-- Tries patterns in order: bracketed [notice], key=value level=info.
-- Returns the canonical syslog severity name or nil.
local function extract_severity(msg)
    if not msg or #msg == 0 then return nil end

    local lower = msg:lower()

    -- Pattern 1: Bracketed — [notice], [error], [warn], etc.
    -- Match earliest occurrence of [...] containing a known severity word.
    local bracketed = lower:match("%[(%a+)%]")
    if bracketed and SEVERITY_MAP[bracketed] then
        return SEVERITY_MAP[bracketed]
    end

    -- Pattern 2: Key=value — level=notice, lvl=warn, severity=error
    local kv_val = lower:match("level=(%a+)")
                or lower:match("lvl=(%a+)")
                or lower:match("severity=(%a+)")
    if kv_val and SEVERITY_MAP[kv_val] then
        return SEVERITY_MAP[kv_val]
    end

    return nil
end

-- ── A2: Try to unpack a JSON structured log message ──────────────
-- If the message is a JSON object, extract:
--   - severity from level/severity/loglevel/lvl fields
--   - actual message from msg/message/text fields
-- Returns: (severity_or_nil, cleaned_message_or_nil)
-- If the message is not JSON or extraction fails, returns (nil, nil).
local function try_json_unpack(msg)
    if not msg then return nil, nil end

    -- Quick check: must start with { and end with }
    local trimmed = msg:match("^%s*(%b{})")
    if not trimmed then return nil, nil end

    -- Extract severity: "level":"...", "severity":"...", "loglevel":"...", "lvl":"..."
    -- Also handles numeric levels like "level":30 (Pino/Bunyan style)
    local json_severity = nil

    -- Try string-valued level fields first
    local sev_str = trimmed:lower():match('"level"%s*:%s*"([^"]+)"')
                 or trimmed:lower():match('"severity"%s*:%s*"([^"]+)"')
                 or trimmed:lower():match('"loglevel"%s*:%s*"([^"]+)"')
                 or trimmed:lower():match('"lvl"%s*:%s*"([^"]+)"')
    if sev_str and SEVERITY_MAP[sev_str] then
        json_severity = SEVERITY_MAP[sev_str]
    end

    -- Try numeric level (Pino uses: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal)
    if not json_severity then
        local num_str = trimmed:match('"level"%s*:%s*(%d+)')
        if num_str then
            local num = tonumber(num_str)
            if num then
                if num >= 60 then json_severity = "emerg"
                elseif num >= 50 then json_severity = "error"
                elseif num >= 40 then json_severity = "warning"
                elseif num >= 30 then json_severity = "info"
                elseif num >= 20 then json_severity = "debug"
                else json_severity = "debug"
                end
            end
        end
    end

    -- Extract the actual message text: "msg":"...", "message":"...", "text":"..."
    -- Use the ORIGINAL (non-lowered) trimmed string to preserve case.
    local extracted_msg = trimmed:match('"msg"%s*:%s*"([^"]*)"')
                       or trimmed:match('"message"%s*:%s*"([^"]*)"')
                       or trimmed:match('"text"%s*:%s*"([^"]*)"')

    return json_severity, extracted_msg
end

-- ── A3: Clean up message text ────────────────────────────────────
-- Strips leading embedded timestamps, ANSI escape codes, and
-- trailing whitespace/newlines from the message.
local function cleanup_message(msg)
    if not msg then return msg end

    -- Strip leading embedded timestamps:
    --   YYYY/MM/DD HH:MM:SS   (nginx style)
    --   YYYY-MM-DDTHH:MM:SS   (ISO 8601)
    --   YYYY-MM-DD HH:MM:SS   (common log format)
    -- Allow optional fractional seconds and timezone suffix
    msg = msg:gsub("^%d%d%d%d[/%-]%d%d[/%-]%d%d[T ]%d%d:%d%d:%d%d[%.%d]*[%+%-Z]?[%d:]*%s*", "")

    -- Strip ANSI escape codes: ESC[...m (SGR sequences)
    -- Lua doesn't have \x1b, so we use the byte value 27 directly
    msg = msg:gsub(string.char(27) .. "%[%d*;?%d*;?%d*m", "")
    -- Also strip ESC[Nm for simple single-number codes
    msg = msg:gsub(string.char(27) .. "%[%d+m", "")

    -- Strip trailing whitespace and newlines
    msg = msg:gsub("%s+$", "")

    -- Strip leading whitespace that may remain after timestamp removal
    msg = msg:gsub("^%s+", "")

    return msg
end

-- ── Main enrichment function ─────────────────────────────────────
function enrich_docker(tag, timestamp, record)
    local log_path = record["log_path"]
    if not log_path then
        return 0, timestamp, record  -- no path → pass through unchanged
    end

    -- Extract 64-hex-char container ID from the Docker log path:
    -- /var/lib/docker/containers/<id>/<id>-json.log
    local container_id = log_path:match("/containers/(%x+)/")
    if not container_id then
        -- Not a Docker log path — clean up and pass through
        record["log_path"] = nil
        return 1, timestamp, record
    end

    -- ── A5: Resolve container name (with cache) ─────────────────
    if not name_cache[container_id] then
        local resolved = container_id:sub(1, 12)  -- fallback: short ID

        local config_path = "/var/lib/docker/containers/"
                          .. container_id .. "/config.v2.json"
        local f = io.open(config_path, "r")
        if f then
            local content = f:read("*a")
            f:close()
            -- Docker stores the container name as: "Name":"/compose-service-1"
            -- at the top level. Match specifically the "Name":"/" pattern to
            -- avoid matching nested Name fields in network/mount configs.
            -- The leading "/" is stripped by the capture group.
            local name = content:match('"Name":"/?([^"]+)"')
            if name then
                -- Extra safety: only accept names that look like container
                -- names (alphanumeric, hyphens, underscores, dots, slashes).
                -- Docker container names are always short and simple.
                local safe_name = name:match("^[%w%.%-_/]+$")
                if safe_name and #safe_name > 0 and #safe_name < 200 then
                    resolved = safe_name
                end
            end
        end

        name_cache[container_id] = resolved
    end

    local container_name = name_cache[container_id]

    -- ── Drop self-logs (Fluent Bit / log-collector) ─────────────
    local lower_name = container_name:lower()
    for _, pat in ipairs(SELF_PATTERNS) do
        if lower_name:match(pat) then
            return -1, timestamp, record  -- drop record
        end
    end

    -- ── Enrich fields ───────────────────────────────────────────
    record["program"] = container_name

    -- ── A6: Set default facility for all Docker container logs ──
    record["facility"] = "daemon"

    -- ── A7: Severity logic (JSON > text > stderr fallback) ──────
    local msg = record["log"] or record["message"] or ""
    local stream = record["stream"]
    local final_severity = nil
    local final_message = msg

    -- Step 1: Try JSON unpack
    local json_severity, json_msg = try_json_unpack(msg)
    if json_severity then
        final_severity = json_severity
    end
    if json_msg then
        final_message = json_msg
    end

    -- Step 2: If not JSON (or JSON had no severity), try text extraction
    if not final_severity then
        local text_severity = extract_severity(msg)
        if text_severity then
            final_severity = text_severity
        end
    end

    -- Step 3: Fallback to stream-based severity
    if not final_severity and stream == "stderr" then
        final_severity = "error"
    end

    -- Apply detected severity
    if final_severity then
        record["severity"] = final_severity
    end

    -- ── A3: Clean up the message ────────────────────────────────
    final_message = cleanup_message(final_message)

    -- ── A4: Drop empty messages after cleanup ───────────────────
    if not final_message or final_message:match("^%s*$") then
        return -1, timestamp, record  -- drop record
    end

    -- Update the message field with the cleaned/unpacked version
    record["message"] = final_message
    -- Remove the "log" field if it exists (Fluent Bit tail uses "log")
    if record["log"] then
        record["log"] = nil
    end

    -- Clean up internal fields — not needed in the backend
    record["log_path"] = nil
    record["stream"] = nil

    return 1, timestamp, record
end
