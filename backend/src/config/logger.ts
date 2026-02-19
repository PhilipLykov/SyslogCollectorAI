/**
 * Shared logger for pipeline modules and other code that doesn't have
 * access to the Fastify app instance.
 *
 * Respects the LOG_LEVEL environment variable:
 *   debug < info < warn < error
 *
 * Default: 'info' (matches Pino default).
 * Set LOG_LEVEL=warn in production to suppress routine info/debug output
 * and prevent self-ingestion of backend logs via Fluent Bit.
 */

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const isProd = process.env.NODE_ENV === 'production';
const configuredLevel = (process.env.LOG_LEVEL || (isProd ? 'warn' : 'info')).toLowerCase();
const minLevel = LEVELS[configuredLevel] ?? 1;

export const logger = {
  debug: (...args: unknown[]) => { if (minLevel <= 0) console.log(...args); },
  info:  (...args: unknown[]) => { if (minLevel <= 1) console.log(...args); },
  warn:  (...args: unknown[]) => { if (minLevel <= 2) console.warn(...args); },
  error: (...args: unknown[]) => { if (minLevel <= 3) console.error(...args); },
};
