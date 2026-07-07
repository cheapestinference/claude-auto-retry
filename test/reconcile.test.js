import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import {
  parsePanes, parseProcesses, parseRunningMonitors, planReconcile, runningFromPgrep,
  pruneExcludeEntries, acquireLock, processStartToken,
} from '../src/reconcile.js';

describe('reconcile parsing', () => {
  it('parses tmux pane list', () => {
    const p = parsePanes('%1 460807\n%10 1642861\n\n');
    assert.deepEqual(p, [{ pane: '%1', panePid: 460807 }, { pane: '%10', panePid: 1642861 }]);
  });
  it('parses ps output with comm and args (args is the trailing field)', () => {
    const p = parseProcesses('1842917 460471 Sl+ claude claude -p "do a thing"\n460471 1 Ss bash -bash\n');
    assert.deepEqual(p[0], { pid: 1842917, ppid: 460471, stat: 'Sl+', comm: 'claude', args: 'claude -p "do a thing"' });
    assert.equal(p[1].comm, 'bash');
  });
  it('tolerates a missing args column (comm-only ps output)', () => {
    const p = parseProcesses('1842917 460471 Sl+ claude\n');
    assert.equal(p[0].comm, 'claude');
    assert.equal(p[0].args, '');
  });
  it('extracts covered pane/pid keys from pgrep output', () => {
    const c = parseRunningMonitors('1866839 node /x/src/monitor.js %1 2453159\n1866840 node /x/src/monitor.js %10 1842917\n');
    assert.equal(c.get('%1 2453159'), 1866839);
    assert.equal(c.get('%10 1842917'), 1866840);
    assert.equal(c.size, 2);
  });
  it('empty pgrep output → no covered', () => assert.equal(parseRunningMonitors('').size, 0));
});

// --- Finding 2: the impure gather() used an unconditional catch, so ANY pgrep failure
//     (ENOENT, busybox pgrep with no -a, macOS pgrep printing PIDs only) collapsed to
//     "zero monitors running" → the 5-min timer armed a duplicate monitor per pane every
//     run, unbounded. runningFromPgrep distinguishes the benign case (exit 1, no matches)
//     from real failures, and refuses to proceed when it can't verify coverage. ---
describe('runningFromPgrep (Finding 2)', () => {
  it('exit code 1 with no output → empty coverage (nothing running, the benign case)', () => {
    const err = Object.assign(new Error('Command failed'), { code: 1, stdout: '' });
    assert.equal(runningFromPgrep(err, '').size, 0);
  });
  it('parses monitor lines on success', () => {
    const out = '1866839 node /x/src/monitor.js %1 2453159\n';
    assert.equal(runningFromPgrep(null, out).get('%1 2453159'), 1866839);
  });
  it('throws on ENOENT (pgrep missing) rather than reporting zero', () => {
    const err = Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' });
    assert.throws(() => runningFromPgrep(err, ''), /pgrep/i);
  });
  it('throws on a non-1 exit code (e.g. busybox usage error)', () => {
    const err = Object.assign(new Error('unrecognized option -a'), { code: 2, stdout: '' });
    assert.throws(() => runningFromPgrep(err, ''), /reconcile/i);
  });
  it('throws when pgrep succeeds but prints no parseable monitor args (macOS PID-only)', () => {
    // pgrep matched processes (non-empty output) but -a gave no args → cannot verify.
    assert.throws(() => runningFromPgrep(null, '1866839\n1866840\n'), /pgrep/i);
  });
});

// --- Finding 4: a manual reconcile overlapping a timer fire both sample coverage once
//     and both spawn the same arm set (nothing reaps the extras). A single-instance lock
//     makes the second run a no-op. ---
describe('acquireLock (Finding 4)', () => {
  const lockPath = join(tmpdir(), `car-lock-${process.pid}-${Date.now()}`);
  it('is exclusive: a second acquire fails while held, and succeeds after release', async () => {
    const a = await acquireLock(lockPath);
    assert.equal(a.ok, true);
    const b = await acquireLock(lockPath);
    assert.equal(b.ok, false);              // another run holds it
    await a.release();
    const c = await acquireLock(lockPath);
    assert.equal(c.ok, true);               // free again
    await c.release();
  });
  it('steals a stale lock whose holder pid is dead', async () => {
    await writeFile(lockPath, '2147483646');  // a pid that is not alive
    const a = await acquireLock(lockPath);
    assert.equal(a.ok, true);               // stole the stale lock
    await a.release();
  });

  // --- Review follow-up: a bare-PID lock can't survive PID reuse. A stale lock holding a
  //     PID the kernel later reuses for an UNRELATED live process would read as "alive"
  //     forever → acquireLock wedged at {ok:false} → self-healing silently off. The lock
  //     identity now includes the process START TOKEN, so a reused PID (different start)
  //     is correctly seen as stale and stolen. ---
  it('does not wedge on PID reuse: steals a lock whose PID is alive but start-token differs', async () => {
    // our own live PID, but a start token that can't match this process → must be stealable
    await writeFile(lockPath, `${process.pid}\tSTALE-START-TOKEN-0000`);
    const a = await acquireLock(lockPath);
    assert.equal(a.ok, true);               // recognized stale via start-token mismatch, stolen
    await a.release();
  });
  it('respects a genuine live holder whose start token matches (does not steal)', async () => {
    // our live PID WITH its real start token = a genuine live holder; must not be stolen.
    await writeFile(lockPath, `${process.pid}\t${await processStartToken(process.pid)}`);
    const a = await acquireLock(lockPath);
    assert.equal(a.ok, false);              // live holder, matching identity → back off
    await unlink(lockPath);
  });
  // --- Review follow-up: release() must not cross-delete. If we were stolen from (the lock
  //     now holds someone else's identity), releasing must leave their lock intact. ---
  it('release only removes the lock when we still own it (no cross-delete)', async () => {
    const a = await acquireLock(lockPath);
    assert.equal(a.ok, true);
    await writeFile(lockPath, '999999\tsomeone-else');  // a concurrent run replaced it
    await a.release();                                   // must NOT delete their lock
    const still = await readFile(lockPath, 'utf-8');
    assert.match(still, /someone-else/);
    await unlink(lockPath);
  });
  // --- Review follow-up: the unlink-based steal double-held (reviewer reproduced 1/120).
  //     link()-create + rename()-steal grant to exactly one racer. In-process contention
  //     exercises the interleaving. ---
  it('grants the lock to exactly one of many concurrent acquirers (no contention)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(lockPath)));
    assert.equal(results.filter(r => r.ok).length, 1);
    // whoever won leaves exactly one lock file; content is never empty
    const held = (await readFile(lockPath, 'utf-8'));
    assert.ok(held.trim().length > 0);
    await Promise.all(results.map(r => r.release()));
  });
  it('grants to exactly one when a stale lock is contended', async () => {
    await writeFile(lockPath, '2147483646');   // stale, dead pid
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(lockPath)));
    assert.equal(results.filter(r => r.ok).length, 1);
    await Promise.all(results.map(r => r.release()));
  });
});

// A small fixture: pane %1 (pane_pid 100) has a claude (200) as a child; pane %2 (300)
// has a claude (400). Process tree links claude→shell(pane_pid).
function fixture() {
  const panes = [{ pane: '%1', panePid: 100 }, { pane: '%2', panePid: 300 }];
  const processes = [
    { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
    { pid: 200, ppid: 100, stat: 'Sl+', comm: 'claude' },
    { pid: 300, ppid: 1, stat: 'Ss', comm: 'bash' },
    { pid: 400, ppid: 300, stat: 'Sl+', comm: 'claude' },
  ];
  return { panes, processes };
}

// --- Finding 5: exclude entries claimed to be self-expiring but a dead PID was never
//     pruned and matched by bare string compare, so kernel PID reuse could mute a future
//     claude forever. pruneExcludeEntries drops numeric entries whose process is gone,
//     while keeping pane ids (%N, hand-managed) and live PIDs. ---
describe('pruneExcludeEntries (Finding 5)', () => {
  const alive = (pid) => new Set([200, 400]).has(pid);
  it('drops a dead PID entry', () => {
    assert.deepEqual(pruneExcludeEntries(['200', '999'], alive), ['200']);
  });
  it('keeps pane-id entries untouched (user-managed)', () => {
    assert.deepEqual(pruneExcludeEntries(['%2', '999'], alive), ['%2']);
  });
  it('keeps live PIDs and drops only the dead ones', () => {
    assert.deepEqual(pruneExcludeEntries(['200', '400', '999', '%3'], alive), ['200', '400', '%3']);
  });
  it('is a no-op on an empty list', () => {
    assert.deepEqual(pruneExcludeEntries([], alive), []);
  });
});

describe('planReconcile', () => {
  it('arms a monitor for each live claude pane', () => {
    const { panes, processes } = fixture();
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm.sort((a, b) => a.pane < b.pane ? -1 : 1),
      [{ pane: '%1', pid: 200 }, { pane: '%2', pid: 400 }]);
  });

  it('skips a pane that already has a monitor', () => {
    const { panes, processes } = fixture();
    const running = parseRunningMonitors('9 node src/monitor.js %1 200\n');
    const { arm, skipped } = planReconcile({ panes, processes, running });
    assert.deepEqual(arm, [{ pane: '%2', pid: 400 }]);
    assert.equal(skipped.find(s => s.pane === '%1').reason, 'already monitored');
  });

  it('never arms the self pane', () => {
    const { panes, processes } = fixture();
    const { arm, skipped } = planReconcile({ panes, processes, running: new Map(), selfPane: '%2' });
    assert.deepEqual(arm, [{ pane: '%1', pid: 200 }]);
    assert.equal(skipped.find(s => s.pane === '%2').reason, 'self (excluded)');
  });

  it('honors a pane-id exclude entry', () => {
    const { panes, processes } = fixture();
    const { arm, skipped } = planReconcile({ panes, processes, running: new Map(), exclude: ['%1'] });
    assert.deepEqual(arm, [{ pane: '%2', pid: 400 }]);
    assert.equal(skipped.find(s => s.pane === '%1').reason, 'excluded (pane)');
  });

  it('honors a claude-PID exclude entry (reuse-proof form)', () => {
    const { panes, processes } = fixture();
    // Exclude by the claude PID (400 = the %2 session), not the pane.
    const { arm, skipped } = planReconcile({ panes, processes, running: new Map(), exclude: ['400'] });
    assert.deepEqual(arm, [{ pane: '%1', pid: 200 }]);
    assert.equal(skipped.find(s => s.pane === '%2').reason, 'excluded (pid)');
  });

  it('a PID exclude matches the FOREGROUND claude after pane-id reuse', () => {
    // Pane %1 reused: background claude 200 (old, excluded) + foreground 201 (current).
    // Excluding pane %1 would wrongly mute the new session; excluding PID 200 does not.
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Ssl', comm: 'claude' },
      { pid: 201, ppid: 100, stat: 'Sl+', comm: 'claude' },
    ];
    // target resolves to foreground 201; excluding old PID 200 must NOT skip it.
    const { arm } = planReconcile({ panes, processes, running: new Map(), exclude: ['200'] });
    assert.deepEqual(arm, [{ pane: '%1', pid: 201 }]);
  });

  // --- Finding 3: coverage is keyed PER PANE, not per (pane,pid). A SIGSTOP'd claude
  //     keeps its monitor alive (kill(pid,0) succeeds on stopped procs); without per-pane
  //     keying, reconcile arms a SECOND monitor for the new foreground claude in the same
  //     pane and both send retry keys on a banner. One monitor per pane, whatever the pid. ---
  it('does not arm a second monitor for a pane that already has one (stopped + new foreground)', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'T', comm: 'claude' },    // SIGSTOP'd — its monitor is still alive
      { pid: 201, ppid: 100, stat: 'Sl+', comm: 'claude' },  // new foreground claude
    ];
    const running = parseRunningMonitors('9 node src/monitor.js %1 200\n');  // monitor covers the pane (for pid 200)
    const { arm, skipped } = planReconcile({ panes, processes, running });
    assert.deepEqual(arm, []);   // pane already covered — do NOT arm a second
    assert.equal(skipped.find(s => s.pane === '%1').reason, 'already monitored');
  });

  it('pane-id reuse: prefers the FOREGROUND claude when two share a pane', () => {
    // Two claudes resolve to pane %1 (pane-id was reused); only 201 is foreground ('+').
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Ssl', comm: 'claude' },   // background
      { pid: 201, ppid: 100, stat: 'Sl+', comm: 'claude' },   // foreground
    ];
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm, [{ pane: '%1', pid: 201 }]);
  });

  it('pane-id reuse with no foreground marker: falls back to the highest pid', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Ssl', comm: 'claude' },
      { pid: 250, ppid: 100, stat: 'Ssl', comm: 'claude' },
    ];
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm, [{ pane: '%1', pid: 250 }]);
  });

  it('ignores non-claude panes and panes with no claude', () => {
    const panes = [{ pane: '%1', panePid: 100 }, { pane: '%9', panePid: 900 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Sl+', comm: 'claude' },
      { pid: 900, ppid: 1, stat: 'Ss+', comm: 'vim' },       // %9 runs vim, no claude
    ];
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm, [{ pane: '%1', pid: 200 }]);
  });

  // --- Finding 8: a `claude -p` (print mode) pane must NOT get a send-keys monitor — the
  //     wrapper never arms one there, and retry text injected into piped/scripted output
  //     would corrupt it. Filter processes whose argv carries -p/--print. ---
  it('does not arm a monitor for a claude running in print mode (-p)', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Rl+', comm: 'claude', args: 'claude -p "summarize the diff"' },
    ];
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm, []);
  });
  it('does not arm for the --print long form either', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Rl+', comm: 'claude', args: 'claude --print "hi"' },
    ];
    assert.deepEqual(planReconcile({ panes, processes, running: new Map() }).arm, []);
  });
  it('still arms an interactive claude (args present, no -p)', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Sl+', comm: 'claude', args: 'claude --resume' },
    ];
    assert.deepEqual(planReconcile({ panes, processes, running: new Map() }).arm, [{ pane: '%1', pid: 200 }]);
  });
  it('does not mistake a prompt word for the -p flag', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 200, ppid: 100, stat: 'Sl+', comm: 'claude', args: 'claude add a -pretty flag' },
    ];
    assert.deepEqual(planReconcile({ panes, processes, running: new Map() }).arm, [{ pane: '%1', pid: 200 }]);
  });

  it('resolves a claude nested several levels below the pane shell', () => {
    const panes = [{ pane: '%1', panePid: 100 }];
    const processes = [
      { pid: 100, ppid: 1, stat: 'Ss', comm: 'bash' },
      { pid: 150, ppid: 100, stat: 'Sl', comm: 'node' },     // wrapper/launcher
      { pid: 200, ppid: 150, stat: 'Sl+', comm: 'claude' },  // actual claude
    ];
    const { arm } = planReconcile({ panes, processes, running: new Map() });
    assert.deepEqual(arm, [{ pane: '%1', pid: 200 }]);
  });
});
