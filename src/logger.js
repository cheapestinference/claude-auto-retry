import { appendFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_LOG_DIR = join(homedir(), '.claude-auto-retry', 'logs');
const MAX_AGE_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3600_000;
let lastCleanup = 0;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function todayFile(dir) {
  return join(dir, `${new Date().toISOString().split('T')[0]}.log`);
}

async function cleanup(dir) {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = Date.now();
  try {
    const files = await readdir(dir);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const s = await stat(join(dir, file));
      if (s.mtimeMs < cutoff) await unlink(join(dir, file));
    }
  } catch { /* ignore */ }
}

export function createLogger(dir = DEFAULT_LOG_DIR) {
  let dirCreated = false;
  async function ensureDir() {
    if (!dirCreated) { await mkdir(dir, { recursive: true }); dirCreated = true; }
  }
  async function log(level, message) {
    await ensureDir();
    await appendFile(todayFile(dir), `[${timestamp()}] [${level}] ${message}\n`);
    cleanup(dir);
  }
  return {
    info: (msg) => log('INFO', msg),
    warn: (msg) => log('WARN', msg),
    error: (msg) => log('ERROR', msg),
  };
}
