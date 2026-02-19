import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';

/**
 * Resolve an environment variable reference.
 *
 * If ref starts with "env:", strips the prefix and looks up the env var.
 * Returns the raw value otherwise. Returns '' for null/undefined/missing refs.
 *
 * Logs a warning when an env: reference points to a missing variable,
 * making misconfiguration easier to diagnose.
 */
export function resolveEnvRef(ref: string | undefined | null): string {
  if (!ref) return '';
  if (ref.startsWith('env:')) {
    const varName = ref.slice(4);
    const value = process.env[varName];
    if (value === undefined) {
      logger.warn(`[${localTimestamp()}] resolveEnvRef: environment variable "${varName}" is not set (ref="${ref}")`);
      return '';
    }
    return value;
  }
  return ref;
}
