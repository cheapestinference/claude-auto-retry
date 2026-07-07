// `claude-auto-retry reconcile` — re-arm a monitor for every live tmux pane running
// claude, skipping panes already covered. Closes the persistence gap: monitors are
// detached processes with no service supervising them, so a crash/kill (or a session
// launched outside the wrapper) leaves a live claude unmonitored. Reconcile restores
// full coverage from the authoritative tmux + process state — run after a crash, or on
// a timer.
//
// The pure core (parsing + planning) is separated from the impure runner (spawning
// tmux/ps and forking monitors) so the mapping logic — including the tricky pane-id
// reuse case — is unit-tested.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, link, rename, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const execFile = promisify(execFileCb);
const MONITOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'monitor.js');

// Sessions to never auto-monitor. Honored by BOTH interactive reconcile and the systemd
// timer (the timer has no $TMUX_PANE, so a durable file is the only self-exclusion path).
// One entry per line; two forms:
//   <pid>   e.g. "1842917" — the claude PID. PREFERRED: unique while alive and
//                            SELF-EXPIRING — dead PIDs are pruned on read (see
//                            pruneExcludeEntries), so once that claude exits the entry is
//                            dropped and can never mute a different future session. Immune
//                            to tmux pane-id reuse. Written by `exclude-self`.
//   %<pane> e.g. "%2"       — a tmux pane id. Convenient to hand-edit, but tmux REUSES
//                            pane ids, so a stale entry can silently mute a later,
//                            unrelated session in that pane (and pane ids are NOT pruned —
//                            we can't know if one is stale). Prefer the PID form.
// '#' comments and blank lines are ignored.
export const EXCLUDE_FILE = join(homedir(), '.claude-auto-retry', 'reconcile-exclude');

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }  // exists but not ours → still alive
}

// Single-instance lock (Finding 4). A manual reconcile overlapping a timer fire would
// otherwise both sample coverage once and both spawn the same arm set, with nothing
// reaping the extras. Uses an atomic O_CREAT|O_EXCL open; on contention it reads the
// holder pid and STEALS the lock only if that process is dead (crash-safe), so a stale
// lock never wedges the timer permanently. Returns { ok, release } — release() is a no-op
// when ok is false, so callers can always call it.
export const LOCK_FILE = join(homedir(), '.claude-auto-retry', 'reconcile.lock');

// Process START TOKEN — an identity that survives PID reuse (a bare PID cannot: the kernel
// reuses PIDs, so a stale lock's PID may later belong to an unrelated live process and read
// as "alive" forever, wedging acquireLock at {ok:false} and silently disabling self-heal).
// Linux: /proc/<pid>/stat field 22 (starttime; the "(comm)" field may contain spaces/parens,
// so slice past the last ')'). Fallback (macOS/BSD, no /proc): `ps -o lstart=`. null if gone.
// NOTE: `ps -o lstart=` is locale-dependent (LC_TIME), so on non-Linux a checker running
// under a different locale than the writer (e.g. cron vs shell) could misjudge a live holder
// as stale. Linux always takes the /proc path on both sides, and this tool targets
// Linux/systemd, so it's unaffected in practice.
export async function processStartToken(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (after[19]) return after[19];   // field 22 overall = index 19 after "state"
  } catch { /* not Linux, or process gone */ }
  try {
    const { stdout } = await execFile('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch { return null; }
}

// Is the recorded lock holder still the SAME live process (not just a reused PID)? Identity
// is "<pid>\t<startToken>". A dead PID → stale. A live PID whose start token no longer
// matches → the PID was reused → stale. A legacy bare-PID lock (no token) → respect it if
// the PID is alive (can't disambiguate; don't risk stealing a real holder's lock).
async function holderIsLive(holderId) {
  const tab = holderId.indexOf('\t');
  const pid = Number(tab === -1 ? holderId : holderId.slice(0, tab));
  if (!pid || !isProcessAlive(pid)) return false;
  const recordedStart = tab === -1 ? '' : holderId.slice(tab + 1);
  if (!recordedStart) return true;
  return (await processStartToken(pid)) === recordedStart;
}

// Only remove the lock if it still holds OUR identity — never cross-delete a lock a
// concurrent run has since taken over. Compare trimmed (a null-token id is a bare "<pid>",
// so this also matches its own file content without a trailing-tab mismatch).
async function releaseLock(lockPath, myId) {
  try {
    if ((await readFile(lockPath, 'utf-8')).trim() === myId) await unlink(lockPath);
  } catch { /* already gone or unreadable */ }
}

// Single-instance lock with an unforgeable holder identity ("<pid>\t<startToken>", or a bare
// "<pid>" when no token is available). Two atomicity properties close the double-hold windows
// a plain open('wx')+write left open:
//   • CREATE atomically with content — write the id to a private temp file, then link() it
//     into place. link() fails EEXIST if a lock exists, and a racer never sees an empty or
//     half-written lock (the gap between open and write).
//   • STEAL a stale lock via rename() to a graveyard name — rename of a given path succeeds
//     for exactly ONE racer; the loser ENOENTs and retries. No unconditional unlink that
//     could delete a lock another run just legitimately created.
export async function acquireLock(lockPath = LOCK_FILE) {
  const dir = dirname(lockPath);
  await mkdir(dir, { recursive: true });
  const token = await processStartToken(process.pid);
  const myId = token ? `${process.pid}\t${token}` : String(process.pid);
  const uniq = `${process.pid}.${Date.now()}`;
  const noop = { ok: false, release: async () => {} };

  for (let attempt = 0; attempt < 4; attempt++) {
    const tmp = join(dir, `.lock.${uniq}.${attempt}.tmp`);
    try {
      await writeFile(tmp, myId);
      await link(tmp, lockPath);              // atomic create-or-EEXIST, content already present
      await unlink(tmp).catch(() => {});
      return { ok: true, release: () => releaseLock(lockPath, myId) };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      if (err.code !== 'EEXIST') throw err;
    }

    // A lock exists. Genuine live holder → back off; otherwise steal it atomically.
    let holderId = '';
    try { holderId = (await readFile(lockPath, 'utf-8')).trim(); }
    catch { continue; }                       // vanished between link-fail and read → retry create
    if (holderId && await holderIsLive(holderId)) return noop;

    const grave = join(dir, `.lock.${uniq}.${attempt}.grave`);
    try { await rename(lockPath, grave); }
    catch (err) {
      if (err.code === 'ENOENT') continue;    // lost the steal race → retry create
      throw err;
    }
    // Won the rename. Confirm we took the SAME stale lock we evaluated; if a racer replaced
    // it with a LIVE one in the gap, restore it rather than steal a live holder.
    let stolen = '';
    try { stolen = (await readFile(grave, 'utf-8')).trim(); } catch { /* empty/gone */ }
    if (stolen && stolen !== holderId && await holderIsLive(stolen)) {
      await rename(grave, lockPath).catch(() => {});
      return noop;
    }
    await unlink(grave).catch(() => {});      // stale confirmed → drop it, loop to create
  }
  return noop;
}

// Prune numeric PID entries whose process is gone: a dead PID can never legitimately match
// again, and keeping it risks muting a future claude that the kernel hands the reused PID
// (Finding 5). Pane ids (%N) and any non-numeric token are hand-managed and kept as-is.
export function pruneExcludeEntries(entries, isAlive = isProcessAlive) {
  return entries.filter(e => !/^\d+$/.test(e) || isAlive(Number(e)));
}

async function readExcludeFile(path = EXCLUDE_FILE) {
  let raw;
  try { raw = await readFile(path, 'utf-8'); } catch { return []; }
  const entries = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split(/[\s#]/)[0]);  // take the first token; allow "1234  # note"
  return pruneExcludeEntries(entries);
}

// Reconcile matches a session by `comm === 'claude'`, which works because Claude Code
// sets its process.title to "claude". A session launched via a `#!/usr/bin/env node`
// shebang that does NOT set process.title shows comm "node" and is invisible to reconcile
// — install the shell wrapper for those. (Matching bare "node" here would arm a monitor on
// every unrelated node process, so it is deliberately not attempted.)
const CLAUDE_COMM = 'claude';
// Print mode: `claude -p` / `claude --print` produces piped/scripted output, never an
// interactive TUI. The wrapper never arms a monitor there; reconcile must skip it too, or
// retry text would be injected into that output (Finding 8). Anchored so a prompt word
// like "-pretty" doesn't false-match.
const PRINT_MODE = /(?:^|\s)(?:-p|--print)(?:[\s=]|$)/;

// --- Pure parsing ---

// tmux: "<pane_id> <pane_pid>" per line → [{ pane, panePid }]
export function parsePanes(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [pane, panePid] = l.split(/\s+/);
    return { pane, panePid: Number(panePid) };
  }).filter(p => p.pane && Number.isFinite(p.panePid));
}

// ps "-eo pid=,ppid=,stat=,comm=,args=" → [{ pid, ppid, stat, comm, args }]. args is the
// trailing field (may contain spaces); absent → '' (tolerates comm-only ps output).
export function parseProcesses(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], comm: m[4], args: (m[5] || '').trim() };
  }).filter(Boolean);
}

// pgrep -af output for running monitors → Set of "pane pid" keys already covered, plus
// the raw records so a caller can report/kill. Line: "<mpid> ... monitor.js <pane> <pid>"
export function parseRunningMonitors(out) {
  const covered = new Map();  // "pane pid" -> monitorPid
  for (const line of out.split('\n')) {
    const m = line.match(/monitor\.js\s+(%\d+)\s+(\d+)\b/);
    if (m) covered.set(`${m[1]} ${m[2]}`, Number(line.trim().split(/\s+/)[0]));
  }
  return covered;
}

// Interpret a pgrep invocation for the running-monitor probe. The ONLY benign failure is
// exit code 1 with no output ("no processes matched") → zero monitors running. Every other
// failure — ENOENT (pgrep absent), a non-1 exit (busybox usage error / no `-a` support), or
// a success that yields no parseable monitor args (macOS/BSD `pgrep -af` prints PIDs only)
// — means we CANNOT verify current coverage. Reporting "zero" there would arm a duplicate
// monitor per pane on every timer fire (Finding 2), so we throw and let reconcile abort
// loudly instead. `err` is the rejected-execFile error (with .code) or null on success.
export function runningFromPgrep(err, stdout) {
  const out = stdout || '';
  if (err) {
    if (err.code === 1 && !out.trim()) return new Map();  // no matches — nothing running
    throw new Error(`pgrep probe failed (code ${err.code}): ${err.message}. Refusing to reconcile — reporting "zero monitors" here would arm duplicate monitors.`);
  }
  const covered = parseRunningMonitors(out);
  if (out.trim() && covered.size === 0) {
    throw new Error('pgrep matched processes but printed no monitor args (needs `pgrep -a`; busybox/macOS print PIDs only). Refusing to reconcile — cannot verify coverage without risking duplicate monitors.');
  }
  return covered;
}

// Walk pid → ppid chain until we hit a process that is a tmux pane_pid; return that pane.
function paneForPid(pid, byPid, panePidToPane) {
  let cur = pid, hops = 0;
  while (cur && cur > 1 && hops < 40) {
    if (panePidToPane.has(cur)) return panePidToPane.get(cur);
    const proc = byPid.get(cur);
    if (!proc) return null;
    cur = proc.ppid; hops++;
  }
  return null;
}

// --- Pure planning ---
// Given tmux panes, ps processes, and already-running monitors, decide which
// (pane, claudePid) pairs need a monitor armed. Handles pane-id reuse: when >1 claude
// resolves to the same pane, prefer the foreground one (stat contains '+').
//
// Returns { arm: [{pane, pid, cwdHint?}], skipped: [{pane, pid, reason}] }.
export function planReconcile({ panes, processes, running, selfPane = null, exclude = [] }) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const panePidToPane = new Map(panes.map(p => [p.panePid, p.pane]));
  const excluded = new Set(exclude);
  if (selfPane) excluded.add(selfPane);
  // Coverage is keyed PER PANE, not per (pane,pid) (Finding 3): a stopped claude keeps its
  // monitor alive, so if we keyed on pid we'd arm a SECOND monitor for the new foreground
  // claude in that pane and both would send keys. One monitor per pane suffices — a
  // monitor whose target pid has exited already shuts itself down (isAlive check).
  const coveredPanes = new Set([...running.keys()].map(k => k.split(' ')[0]));

  // Every interactive claude (comm === 'claude'), excluding print-mode sessions; map to
  // its pane.
  const claudes = processes.filter(p => p.comm === CLAUDE_COMM && !(p.args && PRINT_MODE.test(p.args)));
  const byPane = new Map();  // pane -> [claudeProc]
  for (const c of claudes) {
    const pane = paneForPid(c.pid, byPid, panePidToPane);
    if (!pane) continue;
    if (!byPane.has(pane)) byPane.set(pane, []);
    byPane.get(pane).push(c);
  }

  const arm = [], skipped = [];
  for (const [pane, procs] of byPane) {
    // Pane-id reuse: pick the foreground claude ('+' in stat), else the highest pid
    // (most-recently-started) as a stable tiebreak.
    let target = procs.find(p => p.stat.includes('+'));
    if (!target) target = procs.slice().sort((a, b) => b.pid - a.pid)[0];

    // Exclusion matches either the claude PID (preferred — self-expiring, reuse-proof)
    // or the pane id. PID is checked against the resolved target so it survives pane
    // reuse; pane match is the convenience form.
    if (excluded.has(String(target.pid)) || excluded.has(pane)) {
      const reason = pane === selfPane ? 'self (excluded)'
        : excluded.has(String(target.pid)) ? 'excluded (pid)' : 'excluded (pane)';
      skipped.push({ pane, pid: target.pid, reason });
      continue;
    }

    if (coveredPanes.has(pane)) {
      skipped.push({ pane, pid: target.pid, reason: 'already monitored' });
    } else {
      arm.push({ pane, pid: target.pid });
    }
  }
  return { arm, skipped };
}

// --- Impure runner ---

async function gather() {
  const [{ stdout: panesOut }, { stdout: psOut }] = await Promise.all([
    execFile('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']),
    execFile('ps', ['-eo', 'pid=,ppid=,stat=,comm=,args=']),
  ]);
  let pgrepErr = null, monOut = '';
  try { monOut = (await execFile('pgrep', ['-af', 'node .*src/monitor\\.js'])).stdout; }
  catch (err) { pgrepErr = err; monOut = err.stdout || ''; }
  return {
    panes: parsePanes(panesOut),
    processes: parseProcesses(psOut),
    running: runningFromPgrep(pgrepErr, monOut),  // throws on unverifiable coverage (Finding 2)
  };
}

function armMonitor(pane, pid) {
  // spawn (not fork): fork() opens an IPC channel that keeps this CLI's event loop
  // alive even after unref(), so the command would hang. spawn detached + unref lets
  // the monitor outlive us while `reconcile` exits cleanly.
  const child = spawn(process.execPath, [MONITOR_PATH, pane, String(pid)], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

// Returns { armed: [...], skipped: [...] }. `selfPane` (default $TMUX_PANE) is never armed,
// so reconciling from inside a session doesn't monitor its own pane.
export async function reconcile({ selfPane = process.env.TMUX_PANE || null, dryRun = false } = {}) {
  // dry-run only reads state, so it needs no lock. A real run takes the single-instance
  // lock so an overlapping manual+timer invocation can't both spawn the same monitors.
  let lock = null;
  if (!dryRun) {
    lock = await acquireLock();
    if (!lock.ok) return { armed: [], skipped: [], dryRun, locked: true };
  }
  try {
    const { panes, processes, running } = await gather();
    const exclude = await readExcludeFile();
    const plan = planReconcile({ panes, processes, running, selfPane, exclude });
    const armed = [];
    if (!dryRun) {
      for (const { pane, pid } of plan.arm) {
        const monitorPid = armMonitor(pane, pid);
        armed.push({ pane, pid, monitorPid });
      }
    }
    return { armed: dryRun ? plan.arm : armed, skipped: plan.skipped, dryRun };
  } finally {
    if (lock) await lock.release();
  }
}

// Resolve the claude PID for a given pane from live process state (same mapping
// reconcile uses). Returns the foreground claude's pid, or null.
export async function claudePidForPane(pane) {
  if (!pane) return null;
  const { panes, processes } = await gather();
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const panePidToPane = new Map(panes.map(p => [p.panePid, p.pane]));
  const here = processes.filter(p => p.comm === CLAUDE_COMM
    && !(p.args && PRINT_MODE.test(p.args))
    && paneForPid(p.pid, byPid, panePidToPane) === pane);
  if (here.length === 0) return null;
  return (here.find(p => p.stat.includes('+')) ?? here.sort((a, b) => b.pid - a.pid)[0]).pid;
}

// Durably exclude the CURRENT session from auto-monitoring by appending its claude PID
// (self-expiring, reuse-proof) to the exclude file. Run from inside the session.
export async function excludeSelf(pane = process.env.TMUX_PANE || null, path = EXCLUDE_FILE) {
  if (!pane) return { ok: false, reason: 'not inside tmux ($TMUX_PANE unset)' };
  const pid = await claudePidForPane(pane);
  if (!pid) return { ok: false, reason: `no claude process found for pane ${pane}` };
  const existing = await readExcludeFile(path);
  if (existing.includes(String(pid))) return { ok: true, pane, pid, already: true };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${pid}\t# pane ${pane}, excluded by exclude-self\n`);
  return { ok: true, pane, pid };
}
