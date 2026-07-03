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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFile = promisify(execFileCb);
const MONITOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'monitor.js');

const CLAUDE_COMMANDS = ['claude', 'node'];  // pane_current_command / comm can be either

// --- Pure parsing ---

// tmux: "<pane_id> <pane_pid>" per line → [{ pane, panePid }]
export function parsePanes(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [pane, panePid] = l.split(/\s+/);
    return { pane, panePid: Number(panePid) };
  }).filter(p => p.pane && Number.isFinite(p.panePid));
}

// ps "-eo pid=,ppid=,stat=,comm=" → [{ pid, ppid, stat, comm }]
export function parseProcesses(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], comm: m[4].trim() };
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
export function planReconcile({ panes, processes, running, selfPane = null }) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const panePidToPane = new Map(panes.map(p => [p.panePid, p.pane]));

  // Every claude/node process that is claude (comm === 'claude'); map to its pane.
  const claudes = processes.filter(p => p.comm === 'claude');
  const byPane = new Map();  // pane -> [claudeProc]
  for (const c of claudes) {
    const pane = paneForPid(c.pid, byPid, panePidToPane);
    if (!pane) continue;
    if (!byPane.has(pane)) byPane.set(pane, []);
    byPane.get(pane).push(c);
  }

  const arm = [], skipped = [];
  for (const [pane, procs] of byPane) {
    if (selfPane && pane === selfPane) {
      skipped.push({ pane, pid: procs[0].pid, reason: 'self (excluded)' });
      continue;
    }
    // Pane-id reuse: pick the foreground claude ('+' in stat), else the highest pid
    // (most-recently-started) as a stable tiebreak.
    let target = procs.find(p => p.stat.includes('+'));
    if (!target) target = procs.slice().sort((a, b) => b.pid - a.pid)[0];

    if (running.has(`${pane} ${target.pid}`)) {
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
    execFile('ps', ['-eo', 'pid=,ppid=,stat=,comm=']),
  ]);
  let monOut = '';
  try { monOut = (await execFile('pgrep', ['-af', 'node .*src/monitor\\.js'])).stdout; } catch { /* none running → pgrep exits 1 */ }
  return {
    panes: parsePanes(panesOut),
    processes: parseProcesses(psOut),
    running: parseRunningMonitors(monOut),
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
  const { panes, processes, running } = await gather();
  const plan = planReconcile({ panes, processes, running, selfPane });
  const armed = [];
  if (!dryRun) {
    for (const { pane, pid } of plan.arm) {
      const monitorPid = armMonitor(pane, pid);
      armed.push({ pane, pid, monitorPid });
    }
  }
  return { armed: dryRun ? plan.arm : armed, skipped: plan.skipped, dryRun };
}
