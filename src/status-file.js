// Per-pane status channel for external consumers (tmux status bar, etc).
//
// The monitor's state lives in-memory inside a detached, unref'd process — nothing
// outside it can see whether a given pane is being watched, waiting on a rate-limit
// reset, backing off from overload, or has given up. This writes a small JSON snapshot
// per pane on every tick so a cheap shell script (see bin/tmux-status.sh) can render an
// indicator without talking to the monitor process directly.
//
// Timestamps are epoch SECONDS, not ms — bash readers on macOS can't do `date +%s%3N`
// (BSD date has no %N), so seconds keeps the reader script portable and dependency-free.
//
// Mirrors the pane-keyed write/read/clear shape of events.js (StopFailure markers), and
// shares its filename sanitizer (see pane-key.js).

import { mkdir, writeFile, readFile, unlink, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey, socketIdFromEnv } from './pane-key.js';

export const STATUS_DIR = join(homedir(), '.claude-auto-retry', 'status');

// tmux pane ids (e.g. "%2") are only unique *within one tmux server* — `tmux -L work`
// and `tmux -L personal` (or two independent default servers on a shared host) can each
// have a "%2", and without disambiguation both would collide on the same status file.
//
// tmux sets TMUX="<socket_path>,<server_pid>,<session_id>" for every process running
// inside a session; its first field is exactly the value tmux's own `#{socket_path}`
// format variable resolves to for that server. The monitor is forked from a process
// running inside the pane it's watching, so it reliably inherits this. The reader script
// can't rely on its own $TMUX (a status-bar `#()` command runs in the tmux *server's*
// environment, not a client's — see the README PATH caveat), so it instead receives
// `#{socket_path}` as an explicit argument, which resolves to the same value.
// socketIdFromEnv (shared, pane-key.js): CLAUDE_AUTO_RETRY_SOCKET is set by reconcile
// when it arms a monitor — timer runs have no $TMUX (systemd/launchd jobs run outside
// any client), and without it every self-healed monitor wrote under 'default', a key
// the #{socket_path}-driven reader never looks up (permanently blank status segment).
function fileFor(paneKey, dir, socketId = socketIdFromEnv()) {
  const key = `${sanitizeKey(socketId)}_${sanitizeKey(paneKey)}`;
  return join(dir, `${key}.json`);
}

// Hoisted: mkdir(recursive) is idempotent but still a syscall on every call. A monitor
// ticks every pollIntervalSeconds (5s by default) for its entire lifetime, so memoize
// the directory-creation promise per directory instead of re-running it every tick.
let ensuredDir = null;
function ensureDir(dir) {
  if (!ensuredDir || ensuredDir.dir !== dir) {
    ensuredDir = { dir, promise: mkdir(dir, { recursive: true }) };
  }
  return ensuredDir.promise;
}

// Atomic (tmp + rename) so a reader never sees a half-written file. updatedAt is always
// stamped here (not caller-supplied) so staleness checks reflect the actual write time.
export async function writeStatus(paneKey, data, dir = STATUS_DIR) {
  if (!paneKey) return null;
  await ensureDir(dir);
  const file = fileFor(paneKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...data, updatedAt: Math.floor(Date.now() / 1000) });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

export async function readStatus(paneKey, dir = STATUS_DIR, socketId = undefined) {
  if (!paneKey) return null;
  try {
    return JSON.parse(await readFile(fileFor(paneKey, dir, socketId), 'utf-8'));
  } catch {
    return null;
  }
}

export async function clearStatus(paneKey, dir = STATUS_DIR) {
  try { await unlink(fileFor(paneKey, dir)); } catch { /* already gone */ }
}

// Best-effort GC for status files left behind by monitors that died without a chance to
// run their own cleanup (SIGKILL, host sleep/crash, `tmux kill-server`). Independent of
// bin/tmux-status.sh's own staleness check (which only *hides* a stale segment) — this
// actually deletes the file, so the status dir doesn't grow forever over a machine's
// lifetime (tmux pane ids increment monotonically per server and are never reused).
//
// maxAgeSeconds is intentionally generous (default 5 minutes) — comfortably above any
// sane pollIntervalSeconds so a live monitor's own file is never swept out from under it.
// Called best-effort on monitor startup and from `claude-auto-retry uninstall`.
export async function sweepStaleStatus(dir = STATUS_DIR, maxAgeSeconds = 300) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // directory doesn't exist yet — nothing to sweep
  }
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;
  for (const name of entries) {
    const file = join(dir, name);
    if (name.endsWith('.json')) {
      try {
        const data = JSON.parse(await readFile(file, 'utf-8'));
        if (typeof data.updatedAt !== 'number' || now - data.updatedAt > maxAgeSeconds) {
          await unlink(file);
          removed++;
        }
      } catch {
        // Unparseable/corrupt snapshot — it can never become valid on its own; remove it.
        try { await unlink(file); removed++; } catch { /* already gone */ }
      }
    } else if (name.endsWith('.tmp')) {
      // Orphaned atomic-write temp (`<pane>.json.<pid>.tmp`) left when writeStatus died
      // between writeFile and rename. Its body may be half-written, so age it by mtime
      // rather than a parsed updatedAt — and only sweep ones older than maxAgeSeconds so a
      // live writeStatus mid-rename (tmp exists for microseconds) is never yanked out.
      try {
        const { mtimeMs } = await stat(file);
        if (now - Math.floor(mtimeMs / 1000) > maxAgeSeconds) {
          await unlink(file);
          removed++;
        }
      } catch { /* already gone */ }
    }
  }
  return removed;
}
