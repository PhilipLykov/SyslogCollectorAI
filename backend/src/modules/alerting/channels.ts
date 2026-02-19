import { logger } from '../../config/logger.js';
import { localTimestamp } from '../../config/index.js';
import { resolveEnvRef } from '../connectors/envRef.js';
import { validateUrl } from '../connectors/urlValidation.js';

/**
 * Channel adapter interface and implementations.
 * Each adapter sends a notification via its provider's API.
 *
 * OWASP A10: All URLs validated via shared SSRF-preventing validateUrl().
 */

export interface AlertPayload {
  title: string;
  body: string;
  severity: string;
  variant: 'firing' | 'resolved';
  link?: string;
  system_name?: string;
  criterion?: string;
}

export interface ChannelConfig {
  type: string;
  [key: string]: unknown;
}

// ── Webhook ──────────────────────────────────────────────────

async function sendWebhook(config: ChannelConfig, payload: AlertPayload): Promise<void> {
  const url = config.url as string;
  if (!url) throw new Error('Webhook URL not configured');

  validateUrl(url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error', // SSRF: prevent redirects to internal IPs
  });

  if (!res.ok) {
    throw new Error(`Webhook ${res.status}: ${await res.text()}`);
  }
}

// ── Pushover ─────────────────────────────────────────────────

async function sendPushover(config: ChannelConfig, payload: AlertPayload): Promise<void> {
  const token = resolveEnvRef(config.token_ref as string);
  const userKey = resolveEnvRef(config.user_key as string);

  if (!token || !userKey) throw new Error('Pushover token or user_key not configured');

  const priority = payload.variant === 'firing'
    ? (payload.severity === 'critical' ? 2 : 1)
    : -1;

  const body: Record<string, any> = {
    token,
    user: userKey,
    title: payload.title,
    message: payload.body,
    priority,
    url: payload.link,
  };

  // Priority 2 requires retry and expire
  if (priority === 2) {
    body.retry = 300;
    body.expire = 3600;
  }

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error', // Prevent redirects
  });

  if (!res.ok) {
    throw new Error(`Pushover ${res.status}: ${await res.text()}`);
  }
}

// ── NTfy ─────────────────────────────────────────────────────

async function sendNtfy(config: ChannelConfig, payload: AlertPayload): Promise<void> {
  const configuredUrl = config.base_url as string | undefined;
  const resolvedUrl = configuredUrl ? resolveEnvRef(configuredUrl) : '';
  // Only fall back to public ntfy.sh if NO base_url was configured at all.
  // If one was configured but resolved empty, throw — don't silently send to public server.
  let baseUrl: string;
  if (resolvedUrl) {
    baseUrl = resolvedUrl;
  } else if (configuredUrl) {
    throw new Error('NTfy base_url is configured but resolved to empty. Check your env var.');
  } else {
    baseUrl = 'https://ntfy.sh';
  }
  const topic = config.topic as string;

  if (!topic) throw new Error('NTfy topic not configured');
  validateUrl(baseUrl);

  // Validate topic doesn't contain path traversal
  if (topic.includes('/') || topic.includes('..') || topic.includes('\\')) {
    throw new Error('NTfy topic contains invalid characters');
  }

  const priority = payload.variant === 'firing'
    ? (payload.severity === 'critical' ? '5' : '4')
    : '2';

  const headers: Record<string, string> = {
    // Strip newlines to prevent HTTP header injection (system names come from DB)
    Title: payload.title.replace(/[\r\n]/g, ' '),
    Priority: priority,
  };

  if (payload.variant === 'resolved') {
    headers.Tags = 'white_check_mark';
  } else if (payload.severity === 'critical') {
    headers.Tags = 'rotating_light';
  } else {
    headers.Tags = 'warning';
  }

  // Optional auth
  const authRef = config.auth_header_ref as string | undefined;
  if (authRef) {
    const authValue = resolveEnvRef(authRef);
    if (authValue) headers.Authorization = authValue;
  }

  const res = await fetch(`${baseUrl}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: payload.body,
    redirect: 'error', // SSRF: prevent redirects to internal IPs
  });

  if (!res.ok) {
    throw new Error(`NTfy ${res.status}: ${await res.text()}`);
  }
}

// ── Gotify ───────────────────────────────────────────────────

async function sendGotify(config: ChannelConfig, payload: AlertPayload): Promise<void> {
  const baseUrl = resolveEnvRef(config.base_url as string);
  const token = resolveEnvRef(config.token_ref as string);

  if (!baseUrl || !token) throw new Error('Gotify base_url or token not configured');
  validateUrl(baseUrl);

  const priority = payload.variant === 'firing'
    ? (payload.severity === 'critical' ? 10 : 7)
    : 2;

  // Use X-Gotify-Key header instead of query parameter (avoids token in logs)
  const res = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gotify-Key': token,
    },
    body: JSON.stringify({
      title: payload.title,
      message: payload.body,
      priority,
    }),
    redirect: 'error', // SSRF: prevent redirects to internal IPs
  });

  if (!res.ok) {
    throw new Error(`Gotify ${res.status}: ${await res.text()}`);
  }
}

// ── Telegram ─────────────────────────────────────────────────

async function sendTelegram(config: ChannelConfig, payload: AlertPayload): Promise<void> {
  const token = resolveEnvRef(config.token_ref as string);
  const chatId = resolveEnvRef(config.chat_id as string);

  if (!token || !chatId) throw new Error('Telegram token or chat_id not configured');

  // Validate Telegram token format: digits:alphanumeric (no path traversal)
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid Telegram bot token format');
  }

  const text = formatTelegramMessage(payload);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    redirect: 'error', // Prevent redirects
  });

  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  }
}

/**
 * Build a rich Telegram message with emojis, structured layout, and separators.
 * Uses MarkdownV2 formatting — all special chars must be escaped.
 */
function formatTelegramMessage(payload: AlertPayload): string {
  const esc = escapeMarkdown;
  const lines: string[] = [];

  if (payload.variant === 'resolved') {
    // ── Resolved alert ──
    lines.push(`\u2705 *RESOLVED*`);
    lines.push(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (payload.system_name) {
      lines.push(`\uD83D\uDDA5 *System:* ${esc(payload.system_name)}`);
    }
    if (payload.criterion) {
      lines.push(`\uD83D\uDCCA *Criterion:* ${esc(payload.criterion)}`);
    }
    lines.push('');
    lines.push(esc(payload.body));
    lines.push('');
    lines.push(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    lines.push(`\u23F0 ${esc(localTimestamp())}`);
  } else {
    // ── Firing alert ──
    const severityIcon = SEVERITY_ICONS[payload.severity] ?? '\u26A0\uFE0F';
    const severityLabel = payload.severity.toUpperCase();

    lines.push(`${severityIcon} *${esc(severityLabel)} ALERT*`);
    lines.push(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);

    if (payload.system_name) {
      lines.push(`\uD83D\uDDA5 *System:* ${esc(payload.system_name)}`);
    }
    if (payload.criterion) {
      lines.push(`\uD83D\uDCCA *Criterion:* ${esc(payload.criterion)}`);
    }
    lines.push(`\uD83D\uDEA8 *Severity:* ${esc(severityLabel)}`);

    lines.push('');
    lines.push(`\uD83D\uDCDD ${esc(payload.body)}`);

    lines.push('');
    lines.push(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    lines.push(`\u23F0 ${esc(localTimestamp())}  \\|  _LogSentinel AI_`);
  }

  return lines.join('\n');
}

const SEVERITY_ICONS: Record<string, string> = {
  critical: '\uD83D\uDD34',  // red circle
  high:     '\uD83D\uDFE0',  // orange circle
  medium:   '\uD83D\uDFE1',  // yellow circle
  low:      '\uD83D\uDFE2',  // green circle
  info:     '\uD83D\uDD35',  // blue circle
};

// ── Dispatcher ───────────────────────────────────────────────

const ADAPTERS: Record<string, (config: ChannelConfig, payload: AlertPayload) => Promise<void>> = {
  webhook: sendWebhook,
  pushover: sendPushover,
  ntfy: sendNtfy,
  gotify: sendGotify,
  telegram: sendTelegram,
};

export async function sendNotification(
  channelType: string,
  config: ChannelConfig,
  payload: AlertPayload,
): Promise<void> {
  const adapter = ADAPTERS[channelType];
  if (!adapter) throw new Error(`Unknown channel type: ${channelType}`);

  try {
    await adapter(config, payload);
    logger.debug(`[${localTimestamp()}] Notification sent via ${channelType}: "${payload.title}" (${payload.variant})`);
  } catch (err) {
    logger.error(`[${localTimestamp()}] Notification failed via ${channelType}:`, err);
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
