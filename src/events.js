// StopFailure event channel: the authoritative, scrape-free overload trigger.
//
// Claude Code's `StopFailure` hook fires only when a turn ends in an API error, with a
// typed `error` (matcher-filtered to overloaded/server_error). The hook runs
// as a CHILD of claude, so it inherits the env the launcher stamped onto claude —
// including CLAUDE_AUTO_RETRY_PANE. It writes a marker keyed by that pane; the daemon,
// which already knows its pane, reads it directly. No session-id plumbing needed (the
// main claude PID's environ does not even carry CLAUDE_CODE_SESSION_ID).
//
// Markers are short-lived (consumed on action, ignored past eventMaxAge) so a recycled
// tmux pane id can't replay a stale failure.

import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey } from './pane-key.js';

export const EVENTS_DIR = join(homedir(), '.claude-auto-retry', 'events');

// Error types the event path treats as a *transient overload* (seconds-scale backoff).
// NOTE: `rate_limit` is deliberately EXCLUDED. For a subscription it is the session/usage
// limit — an HOURS-scale wait until a printed reset time, not a seconds-scale retry.
// Routing it here made the monitor fire futile "Continue" retries into a session-limited
// pane and fight the (correct) scraper usage-wait path. Session/usage limits are owned by
// the scraper usage path (it reliably reads the persistent "…resets <time>" banner and
// waits); a genuinely transient API 429 is caught by the overload scraper's "temporarily
// limiting requests" pattern, which stays active alongside the event path (it is no longer
// disabled when the hook is live), so those 429s are retried even in event mode.
// Permanent errors (auth/billing/invalid) never retry.
const RETRYABLE = new Set(['overloaded', 'server_error']);

export function isRetryableError(errorType) {
  return typeof errorType === 'string' && RETRYABLE.has(errorType.toLowerCase());
}

// tmux pane ids look like "%2"; keep the marker filename to a safe charset.
function fileFor(paneKey, dir) {
  return join(dir, `${sanitizeKey(paneKey)}.json`);
}

// Hook side: write a marker for the pane. Atomic (tmp + rename) so the daemon never
// reads a half-written file.
export async function writeStopFailureEvent(paneKey, payload, dir = EVENTS_DIR) {
  if (!paneKey) return null;
  const error = typeof payload?.error === 'string' ? payload.error : 'unknown';
  await mkdir(dir, { recursive: true });
  const file = fileFor(paneKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ pane: String(paneKey), error, session_id: payload?.session_id ?? null, ts: Date.now() });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

// Daemon side: return a fresh marker for the pane, or null (absent / unparseable / stale).
export async function readStopFailureEvent(paneKey, maxAgeMs, dir = EVENTS_DIR) {
  if (!paneKey) return null;
  try {
    const ev = JSON.parse(await readFile(fileFor(paneKey, dir), 'utf-8'));
    if (typeof ev.ts !== 'number' || Date.now() - ev.ts > maxAgeMs) return null;
    return ev;
  } catch { return null; }
}

export async function clearStopFailureEvent(paneKey, dir = EVENTS_DIR) {
  try { await unlink(fileFor(paneKey, dir)); } catch { /* already gone */ }
}
