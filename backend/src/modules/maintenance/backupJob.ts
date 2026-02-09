/**
 * Database Backup Job
 *
 * Performs automated PostgreSQL database backups using pg_dump.
 * Backups are stored as compressed .sql.gz files in /app/data/backups/.
 *
 * Features:
 *  - Manual trigger via API
 *  - Scheduled automatic backups (configurable interval)
 *  - Retention management (keep last N backups)
 *  - Download and delete individual backups
 *  - Backup metadata (filename, size, timestamp)
 */

import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Knex } from 'knex';
import { config, localTimestamp } from '../../config/index.js';

// ── Types ──────────────────────────────────────────────────────

export interface BackupConfig {
  /** Master switch for automated backups. */
  backup_enabled: boolean;
  /** How often to run backups, in hours. */
  backup_interval_hours: number;
  /** How many backups to keep (oldest are deleted). */
  backup_retention_count: number;
  /** Backup format: 'custom' (pg_dump -Fc, compact binary) or 'plain' (SQL text). */
  backup_format: 'custom' | 'plain';
}

export interface BackupFileInfo {
  filename: string;
  size_bytes: number;
  size_human: string;
  created_at: string;
}

export interface BackupRunResult {
  success: boolean;
  filename: string | null;
  size_bytes: number | null;
  duration_ms: number;
  error: string | null;
}

const BACKUP_CONFIG_DEFAULTS: BackupConfig = {
  backup_enabled: false,
  backup_interval_hours: 24,
  backup_retention_count: 7,
  backup_format: 'custom',
};

const BACKUP_DIR = join(process.cwd(), 'data', 'backups');

// ── Helpers ────────────────────────────────────────────────────

function ensureBackupDir(): void {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Sanitize a filename to prevent path traversal.
 * Only allows alphanumeric, dashes, underscores, dots.
 */
export function sanitizeFilename(name: string): string | null {
  const base = basename(name);
  if (/^[a-zA-Z0-9._-]+$/.test(base) && !base.includes('..')) {
    return base;
  }
  return null;
}

// ── Config Loader ──────────────────────────────────────────────

let _cachedBackupConfig: BackupConfig | null = null;
let _backupCacheTime = 0;
const BACKUP_CACHE_TTL_MS = 60_000;

export function invalidateBackupConfigCache(): void {
  _cachedBackupConfig = null;
  _backupCacheTime = 0;
}

export async function loadBackupConfig(db: Knex): Promise<BackupConfig> {
  if (_cachedBackupConfig && Date.now() - _backupCacheTime < BACKUP_CACHE_TTL_MS) {
    return _cachedBackupConfig;
  }

  try {
    const row = await db('app_config').where({ key: 'backup_config' }).first('value');
    let parsed: Record<string, unknown> = {};
    if (row) {
      const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    }
    _cachedBackupConfig = { ...BACKUP_CONFIG_DEFAULTS, ...parsed } as BackupConfig;

    // Validate format field
    if (!['custom', 'plain'].includes(_cachedBackupConfig.backup_format)) {
      _cachedBackupConfig.backup_format = 'custom';
    }

    _backupCacheTime = Date.now();
    return _cachedBackupConfig;
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to load backup config:`, err);
    return { ...BACKUP_CONFIG_DEFAULTS };
  }
}

// ── Core Backup Function ───────────────────────────────────────

/**
 * Run pg_dump to create a database backup.
 *
 * Uses the same DB connection settings the backend uses (from config).
 * For 'custom' format: produces a .dump file (pg_dump -Fc)
 * For 'plain' format: produces a .sql.gz file (SQL piped through gzip)
 */
export async function runBackup(db: Knex): Promise<BackupRunResult> {
  const startTime = Date.now();
  ensureBackupDir();

  const cfg = await loadBackupConfig(db);
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

  const isCustom = cfg.backup_format === 'custom';
  const ext = isCustom ? '.dump' : '.sql.gz';
  const filename = `backup_${ts}${ext}`;
  const filepath = join(BACKUP_DIR, filename);

  // Build pg_dump arguments
  const args: string[] = [
    '-h', config.db.host,
    '-p', String(config.db.port),
    '-U', config.db.user,
    '-d', config.db.database,
    '--no-password', // use PGPASSWORD env var
  ];

  if (isCustom) {
    args.push('-Fc'); // custom format (compressed binary)
    args.push('-f', filepath);
  } else {
    // plain format — we'll pipe stdout through gzip
    args.push('-Fp');
  }

  console.log(`[${localTimestamp()}] Backup: starting pg_dump (format=${cfg.backup_format}) → ${filename}`);

  return new Promise<BackupRunResult>((resolve) => {
    const env = {
      ...process.env,
      PGPASSWORD: config.db.password,
    };

    if (isCustom) {
      // Custom format: pg_dump writes directly to file
      execFile('pg_dump', args, { env, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
        const duration_ms = Date.now() - startTime;

        if (error) {
          const errMsg = stderr?.trim() || error.message;
          console.error(`[${localTimestamp()}] Backup: pg_dump failed: ${errMsg}`);
          // Clean up partial file
          try { if (existsSync(filepath)) unlinkSync(filepath); } catch { /* ignore */ }
          resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: errMsg });
          return;
        }

        try {
          const stat = statSync(filepath);
          console.log(`[${localTimestamp()}] Backup: completed ${filename} (${humanSize(stat.size)}) in ${duration_ms}ms`);
          resolve({ success: true, filename, size_bytes: stat.size, duration_ms, error: null });
        } catch (statErr: any) {
          resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: statErr.message });
        }
      });
    } else {
      // Plain format: pipe pg_dump stdout through gzip to file
      const child = execFile('pg_dump', args, { env, maxBuffer: 50 * 1024 * 1024 });
      const gzip = createGzip({ level: 6 });
      const fileStream = createWriteStream(filepath);

      if (child.stdout) {
        pipeline(child.stdout, gzip, fileStream)
          .then(() => {
            const duration_ms = Date.now() - startTime;
            try {
              const stat = statSync(filepath);
              console.log(`[${localTimestamp()}] Backup: completed ${filename} (${humanSize(stat.size)}) in ${duration_ms}ms`);
              resolve({ success: true, filename, size_bytes: stat.size, duration_ms, error: null });
            } catch (statErr: any) {
              resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: statErr.message });
            }
          })
          .catch((pipeErr) => {
            const duration_ms = Date.now() - startTime;
            console.error(`[${localTimestamp()}] Backup: stream error: ${pipeErr.message}`);
            try { if (existsSync(filepath)) unlinkSync(filepath); } catch { /* ignore */ }
            resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: pipeErr.message });
          });
      } else {
        const duration_ms = Date.now() - startTime;
        resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: 'pg_dump stdout not available' });
      }

      // Capture stderr for error reporting
      let stderrData = '';
      child.stderr?.on('data', (chunk) => { stderrData += chunk; });
      child.on('error', (err) => {
        const duration_ms = Date.now() - startTime;
        console.error(`[${localTimestamp()}] Backup: pg_dump spawn error: ${err.message}`);
        try { if (existsSync(filepath)) unlinkSync(filepath); } catch { /* ignore */ }
        resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: err.message });
      });
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          const duration_ms = Date.now() - startTime;
          const errMsg = stderrData.trim() || `pg_dump exited with code ${code}`;
          console.error(`[${localTimestamp()}] Backup: pg_dump failed: ${errMsg}`);
          try { if (existsSync(filepath)) unlinkSync(filepath); } catch { /* ignore */ }
          resolve({ success: false, filename: null, size_bytes: null, duration_ms, error: errMsg });
        }
      });
    }
  });
}

// ── Backup Cleanup ─────────────────────────────────────────────

/**
 * Remove old backups, keeping only the most recent `retentionCount`.
 */
export function cleanupOldBackups(retentionCount: number): number {
  ensureBackupDir();

  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup_') && (f.endsWith('.dump') || f.endsWith('.sql.gz')))
    .map((f) => ({
      name: f,
      time: statSync(join(BACKUP_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time); // newest first

  if (files.length <= retentionCount) return 0;

  const toDelete = files.slice(retentionCount);
  let deleted = 0;
  for (const f of toDelete) {
    try {
      unlinkSync(join(BACKUP_DIR, f.name));
      deleted++;
      console.log(`[${localTimestamp()}] Backup: cleaned up old backup ${f.name}`);
    } catch (err: any) {
      console.error(`[${localTimestamp()}] Backup: failed to delete ${f.name}: ${err.message}`);
    }
  }

  return deleted;
}

// ── List Backups ───────────────────────────────────────────────

/**
 * List all backup files with metadata.
 */
export function listBackups(): BackupFileInfo[] {
  ensureBackupDir();

  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup_') && (f.endsWith('.dump') || f.endsWith('.sql.gz')))
    .map((f) => {
      const stat = statSync(join(BACKUP_DIR, f));
      return {
        filename: f,
        size_bytes: stat.size,
        size_human: humanSize(stat.size),
        created_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/**
 * Get the full path of a backup file (with validation).
 * Returns null if the file doesn't exist or the name is invalid.
 */
export function getBackupPath(filename: string): string | null {
  const safe = sanitizeFilename(filename);
  if (!safe) return null;

  const filepath = join(BACKUP_DIR, safe);
  if (!existsSync(filepath)) return null;

  return filepath;
}

/**
 * Delete a specific backup file.
 */
export function deleteBackupFile(filename: string): boolean {
  const filepath = getBackupPath(filename);
  if (!filepath) return false;

  try {
    unlinkSync(filepath);
    console.log(`[${localTimestamp()}] Backup: deleted ${filename}`);
    return true;
  } catch (err: any) {
    console.error(`[${localTimestamp()}] Backup: failed to delete ${filename}: ${err.message}`);
    return false;
  }
}

// ── Export defaults for API routes ─────────────────────────────

export { BACKUP_CONFIG_DEFAULTS, BACKUP_DIR };
