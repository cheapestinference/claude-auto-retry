import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, utimesSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveLaunchCommand, buildTmuxInnerCmd, buildNewSessionArgs,
  writeEnvSnapshot, writeEnvSnapshotSafe, applyEnvSnapshot, consumeEnvSnapshot, sweepStaleEnvSnapshots,
  chooseLaunchMode, isTransientTmuxServerError, retryTransientServerError,
  extractSessionName, normalizeSessionName, defaultSessionName,
  buildAttachSessionArgs, buildFirstWindowTarget, isDuplicateSessionError,
  sessionNameIgnoredWarning, duplicateSessionMessage,
} from '../src/launcher.js';

describe('resolveLaunchCommand', () => {
  it('spawns claude directly when no wrapper is set', () => {
    assert.deepEqual(
      resolveLaunchCommand('/usr/bin/claude', ['--resume'], {}),
      { cmd: '/usr/bin/claude', cmdArgs: ['--resume'] },
    );
  });

  it('treats an empty/whitespace wrapper as unset', () => {
    assert.deepEqual(
      resolveLaunchCommand('claude', ['-c'], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: '   ' }),
      { cmd: 'claude', cmdArgs: ['-c'] },
    );
  });

  it('prepends a wrapper command (e.g. caffeinate -i) before claude and its args', () => {
    assert.deepEqual(
      resolveLaunchCommand('/usr/bin/claude', ['--resume'], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: 'caffeinate -i' }),
      { cmd: 'caffeinate', cmdArgs: ['-i', '/usr/bin/claude', '--resume'] },
    );
  });

  it('handles a bare single-token wrapper and extra whitespace', () => {
    assert.deepEqual(
      resolveLaunchCommand('claude', [], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: '  nice   ' }),
      { cmd: 'nice', cmdArgs: ['claude'] },
    );
  });
});

// --- Env snapshot file (#68) ---
// Secrets must never ride the tmux argv: `new-session -e KEY=VALUE` pairs land in the
// tmux SERVER's /proc/<pid>/cmdline (world-readable, 0444) for the server's whole
// lifetime whenever that invocation is the one that starts the server — and the < 3.2
// inline-export branch had the same exposure. The environment now crosses into the pane
// via a 0600 JSON snapshot file whose PATH is the only thing on the argv; the inner
// launcher loads it into process.env (Node round-trips names a POSIX `source` can't,
// e.g. BASH_FUNC_name%%) and unlinks it.
describe('env snapshot file (#68)', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'car-env-'));

  it('writes a 0600 file in a 0700 dir and round-trips the env minus TMUX*', () => {
    const dir = join(scratch(), 'sub');   // exercise dir creation
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-1',
      'BASH_FUNC_module%%': '() { eval $LMOD; }',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',   // no argv → no need to drop it
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%5',
      GONE: undefined,
    };
    const path = writeEnvSnapshot(env, dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const snap = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(snap.ANTHROPIC_API_KEY, 'sk-ant-1');
    assert.equal(snap['BASH_FUNC_module%%'], '() { eval $LMOD; }');
    assert.equal(snap['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
    assert.ok(!('TMUX' in snap) && !('TMUX_PANE' in snap), 'TMUX* must not cross into the pane');
    assert.ok(!('GONE' in snap));
  });

  // PR #72 review finding: a failed snapshot write degraded SILENTLY — on a pre-existing
  // tmux server the pane then runs with the server's stale startup env (rotated API key,
  // fresh proxy var quietly never reach claude) and nothing points at the cause. The
  // degrade is right; the silence is not.
  it('writeEnvSnapshotSafe warns on an unwritable dir and returns null', () => {
    const blocked = join(scratch(), 'blocked');
    writeFileSync(blocked, 'a file, not a dir');
    const warnings = [];
    const path = writeEnvSnapshotSafe({ A: '1' }, join(blocked, 'sub'), (m) => warnings.push(m));
    assert.equal(path, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not write env snapshot/);
    assert.match(warnings[0], /stale/);
  });

  it('writeEnvSnapshotSafe returns the path and stays quiet on success', () => {
    const warnings = [];
    const path = writeEnvSnapshotSafe({ A: '1' }, scratch(), (m) => warnings.push(m));
    assert.ok(existsSync(path));
    assert.deepEqual(warnings, []);
  });

  it('applyEnvSnapshot overwrites stale pane values but never TMUX* or the pointer var', () => {
    const target = { PATH: '/stale/path', TMUX_PANE: '%7', CLAUDE_AUTO_RETRY_ENV_FILE: '/x' };
    applyEnvSnapshot(target, {
      PATH: '/usr/bin', NEW_VAR: '1',
      TMUX_PANE: '%5', TMUX: 'evil', CLAUDE_AUTO_RETRY_ENV_FILE: '/evil',
    });
    assert.equal(target.PATH, '/usr/bin');
    assert.equal(target.NEW_VAR, '1');
    assert.equal(target.TMUX_PANE, '%7', 'the pane identity belongs to the inner session');
    assert.ok(!('TMUX' in target));
    assert.equal(target.CLAUDE_AUTO_RETRY_ENV_FILE, '/x');
  });

  it('consumeEnvSnapshot applies, unlinks, and clears the pointer', () => {
    const dir = scratch();
    const path = writeEnvSnapshot({ SECRET: 's3cr3t' }, dir);
    const env = { CLAUDE_AUTO_RETRY_ENV_FILE: path, TMUX_PANE: '%2' };
    assert.equal(consumeEnvSnapshot(env), true);
    assert.equal(env.SECRET, 's3cr3t');
    assert.ok(!('CLAUDE_AUTO_RETRY_ENV_FILE' in env));
    assert.ok(!existsSync(path), 'snapshot must be unlinked after consumption');
  });

  it('consumeEnvSnapshot degrades on a missing or corrupt file (still clears pointer/unlinks)', () => {
    const env = { CLAUDE_AUTO_RETRY_ENV_FILE: '/nonexistent/env.json' };
    assert.equal(consumeEnvSnapshot(env), false);
    assert.ok(!('CLAUDE_AUTO_RETRY_ENV_FILE' in env));

    const dir = scratch();
    const bad = join(dir, 'env-bad.json');
    writeFileSync(bad, 'not json', { mode: 0o600 });
    const env2 = { CLAUDE_AUTO_RETRY_ENV_FILE: bad };
    assert.equal(consumeEnvSnapshot(env2), false);
    assert.ok(!existsSync(bad), 'even a corrupt snapshot must not linger on disk');
    assert.equal(consumeEnvSnapshot({}), false, 'no pointer → no-op');
  });

  it('sweepStaleEnvSnapshots removes old env-*.json, keeps fresh ones and other files', () => {
    const dir = scratch();
    const stale = writeEnvSnapshot({ A: '1' }, dir);
    const fresh = writeEnvSnapshot({ B: '2' }, dir);
    const other = join(dir, 'not-a-snapshot.txt');
    writeFileSync(other, 'x');
    const old = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    sweepStaleEnvSnapshots(dir, 24 * 3600_000);
    assert.ok(!existsSync(stale), 'stale snapshot must be swept');
    assert.ok(existsSync(fresh), 'fresh snapshot must survive');
    assert.ok(existsSync(other), 'non-snapshot files are not ours to delete');
  });
});

describe('buildNewSessionArgs (#68)', () => {
  it('never puts env names or values on the argv, on any tmux version', () => {
    const args = buildNewSessionArgs('s1', 'inner');
    assert.deepEqual(args, ['new-session', '-d', '-s', 's1', 'inner']);
    assert.ok(!args.includes('-e'));
    assert.ok(!args.some(a => a.includes('export ')));
  });
});

// --- Dead-server race on session creation (#69 follow-up) ---
// Session reaping means the tmux server now EXITS when the last claude session ends
// (exit-empty is on by default). A `new-session` that lands while the server is tearing
// down — socket still on disk, server draining — connects, sees EOF mid-handshake, and
// fails with "server exited unexpectedly". Empirically reproduced on tmux 3.4 (~3/40
// timed attempts); a short-delay retry always recovered because the second client finds
// the socket gone (or stale) and cold-starts its own server. Unreachable before reaping:
// the server never exited, so the window never existed.
describe('new-session dead-server retry (#69 follow-up)', () => {
  it('classifies mid-shutdown server errors as transient, from message or stderr', () => {
    assert.ok(isTransientTmuxServerError(new Error('Command failed: tmux\nserver exited unexpectedly')));
    const withStderr = new Error('Command failed: tmux new-session ...');
    withStderr.stderr = Buffer.from('server exited unexpectedly\n');
    assert.ok(isTransientTmuxServerError(withStderr));
    const lost = new Error('x'); lost.stderr = Buffer.from('lost server\n');
    assert.ok(isTransientTmuxServerError(lost));
  });

  it('does not classify real launch failures as transient', () => {
    assert.ok(!isTransientTmuxServerError(new Error('duplicate session: s1')));
    const err = new Error('Command failed: tmux');
    err.stderr = Buffer.from('unknown option -- e\n');
    assert.ok(!isTransientTmuxServerError(err));
    assert.ok(!isTransientTmuxServerError(new Error('spawn tmux ENOENT')));
  });

  it('retries a transient failure after a delay and returns the eventual result', async () => {
    const delays = [];
    let calls = 0;
    const result = await retryTransientServerError(() => {
      calls++;
      if (calls === 1) {
        const err = new Error('Command failed: tmux');
        err.stderr = Buffer.from('server exited unexpectedly\n');
        throw err;
      }
      return 'created';
    }, { sleep: async (ms) => delays.push(ms) });
    assert.equal(result, 'created');
    assert.equal(calls, 2);
    assert.deepEqual(delays, [250]);
  });

  it('rethrows a non-transient failure immediately without sleeping', async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
      retryTransientServerError(() => { calls++; throw new Error('duplicate session: s1'); },
        { sleep: async (ms) => delays.push(ms) }),
      /duplicate session/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });

  it('gives up after the attempt budget and rethrows the transient error', async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
      retryTransientServerError(() => {
        calls++;
        // Shape of a real execFileSync failure: stderr folded into message AND on .stderr
        const err = new Error('Command failed: tmux\nserver exited unexpectedly\n');
        err.stderr = Buffer.from('server exited unexpectedly\n');
        throw err;
      }, { attempts: 3, sleep: async (ms) => delays.push(ms) }),
      /server exited unexpectedly/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 250]);
  });
});

describe('buildTmuxInnerCmd', () => {
  it('carries only the snapshot PATH on the command line, plus node via execPath', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', ['--resume'],
      { SHELL: '/bin/zsh', ANTHROPIC_API_KEY: 'sk-ant-1' }, '/run/user/1000/env-1.json');
    assert.ok(cmd.includes("CLAUDE_AUTO_RETRY_ENV_FILE='/run/user/1000/env-1.json'"));
    assert.ok(!cmd.includes('sk-ant-1'), 'no env VALUES on the argv');
    assert.ok(cmd.includes(`'${process.execPath}'`),
      'bare `node` resolves against a possibly-stale server PATH; use the launching node');
    assert.ok(cmd.includes("'/path/launcher.js' '--resume'"));
  });

  it('omits the pointer when no snapshot could be written', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', [], { SHELL: '/bin/zsh' }, null);
    assert.ok(!cmd.includes('CLAUDE_AUTO_RETRY_ENV_FILE'));
  });

  // --- Session reap (#69) ---
  // `; exec $SHELL` unconditionally kept every pane alive forever: nothing in the package
  // ever calls kill-session, so a clean /exit left an idle login shell pinning the session
  // (and its whole Claude/MCP process tree) until reboot — measured at 66 sessions/16.4 GB
  // in 3 days. The tail is now conditional: keep the shell only when the launcher exited
  // non-zero (crash — scrollback genuinely helps), otherwise let the pane command end so
  // tmux reaps the session itself. CLAUDE_AUTO_RETRY_KEEP_SHELL=1 restores the old tail.
  function runInnerTail(exitCode, env) {
    const dir = mkdtempSync(join(tmpdir(), 'car-tail-'));
    const stubLauncher = join(dir, 'launcher.js');
    writeFileSync(stubLauncher, `process.exit(${exitCode});`);
    const marker = join(dir, 'shell-ran');
    const stubShell = join(dir, 'shell.sh');
    writeFileSync(stubShell, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(stubShell, 0o755);
    const cmd = buildTmuxInnerCmd(stubLauncher, [], { ...env, SHELL: stubShell }, null);
    let rc = 0;
    try { execFileSync('/bin/sh', ['-c', cmd], { stdio: 'ignore' }); }
    catch (e) { rc = e.status ?? 1; }
    const shellRan = existsSync(marker);
    rmSync(dir, { recursive: true, force: true });
    return { rc, shellRan };
  }

  it('clean launcher exit ends the pane command (session reaped), preserving exit 0', () => {
    const { rc, shellRan } = runInnerTail(0, {});
    assert.equal(shellRan, false, 'no fallback shell after a clean exit');
    assert.equal(rc, 0);
  });

  it('crashed launcher (non-zero) still falls through to the user shell', () => {
    const { shellRan } = runInnerTail(3, {});
    assert.equal(shellRan, true, 'crash must keep the pane for its scrollback');
  });

  it('CLAUDE_AUTO_RETRY_KEEP_SHELL=1 restores the always-keep-shell tail', () => {
    const { shellRan } = runInnerTail(0, { CLAUDE_AUTO_RETRY_KEEP_SHELL: '1' });
    assert.equal(shellRan, true);
  });

  it('falls back to bash when $SHELL is unset', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', [], {});
    assert.ok(cmd.includes("exec 'bash'"), cmd);
  });
});

describe('chooseLaunchMode (#69 escape hatch)', () => {
  it('print mode wins regardless of environment', () => {
    assert.equal(chooseLaunchMode(['-p', 'hi'], { TMUX: 'x' }), 'print');
    assert.equal(chooseLaunchMode(['--print'], {}), 'print');
  });
  it('inside tmux runs interactive (monitored) mode', () => {
    assert.equal(chooseLaunchMode([], { TMUX: '/tmp/tmux-1000/default,1,0' }), 'interactive');
  });
  it('outside tmux creates a session by default', () => {
    assert.equal(chooseLaunchMode([], {}), 'tmux-session');
  });
  it('CLAUDE_AUTO_RETRY_NO_TMUX=1 skips session creation (Zellij/screen users opting out)', () => {
    assert.equal(chooseLaunchMode([], { CLAUDE_AUTO_RETRY_NO_TMUX: '1' }), 'interactive');
  });
});

// --- Naming the auto-created session (--tmux-session) ---
// The session name was hardcoded to `claude-retry-<pid>-<ms>`, which is unique but
// unfindable: `tmux ls` gives you a wall of timestamps and nothing says which checkout
// each one is. A name can now be given per launch (`--tmux-session api`) or per shell
// (CLAUDE_AUTO_RETRY_SESSION_NAME), and the flag is consumed by the launcher — it must
// never reach `claude`, which would reject it as an unknown option.
describe('session naming: extractSessionName', () => {
  it('leaves argv untouched and yields no name when neither flag nor env is set', () => {
    assert.deepEqual(extractSessionName(['-c', 'hello'], {}),
      { name: null, changed: false, fromFlag: false, rest: ['-c', 'hello'] });
  });

  it('takes the space-separated form and strips both tokens from the claude argv', () => {
    assert.deepEqual(extractSessionName(['--model', 'opus', '--tmux-session', 'api', '-c'], {}),
      { name: 'api', changed: false, fromFlag: true, rest: ['--model', 'opus', '-c'] });
  });

  it('takes the --tmux-session=name form', () => {
    assert.deepEqual(extractSessionName(['--tmux-session=api', '-c'], {}),
      { name: 'api', changed: false, fromFlag: true, rest: ['-c'] });
  });

  it('falls back to CLAUDE_AUTO_RETRY_SESSION_NAME', () => {
    assert.deepEqual(extractSessionName([], { CLAUDE_AUTO_RETRY_SESSION_NAME: 'api' }),
      { name: 'api', changed: false, fromFlag: false, rest: [] });
  });

  it('lets the flag override the env var', () => {
    const r = extractSessionName(['--tmux-session', 'flag'], { CLAUDE_AUTO_RETRY_SESSION_NAME: 'env' });
    assert.equal(r.name, 'flag');
    assert.equal(r.fromFlag, true);
  });

  it('treats a blank env var as unset', () => {
    assert.equal(extractSessionName([], { CLAUDE_AUTO_RETRY_SESSION_NAME: '   ' }).name, null);
  });

  it('lets the last flag win when given twice', () => {
    assert.deepEqual(extractSessionName(['--tmux-session', 'a', '--tmux-session=b'], {}),
      { name: 'b', changed: false, fromFlag: true, rest: [] });
  });

  it('rejects a trailing flag with no value instead of eating the next claude arg', () => {
    assert.throws(() => extractSessionName(['-c', '--tmux-session'], {}), /requires a value/);
  });

  it('rejects an empty value', () => {
    assert.throws(() => extractSessionName(['--tmux-session='], {}), /empty/i);
    assert.throws(() => extractSessionName(['--tmux-session', '  '], {}), /empty/i);
  });

  // tmux rewrites '.' and ':' — its target separators — to '_' when creating a session
  // (verified on 3.5a). Normalizing up front keeps the name we hold equal to the name
  // tmux actually made, so the later `-t` targets resolve.
  it('normalizes the target separators tmux would rewrite, and says so', () => {
    assert.deepEqual(extractSessionName(['--tmux-session', 'work.api:2'], {}),
      { name: 'work_api_2', changed: true, fromFlag: true, rest: [] });
  });
});

describe('session naming: normalizeSessionName', () => {
  it('passes an ordinary name through unchanged', () => {
    assert.deepEqual(normalizeSessionName('api-worker'), { name: 'api-worker', changed: false });
  });

  it('trims surrounding whitespace without flagging a change', () => {
    assert.deepEqual(normalizeSessionName('  api  '), { name: 'api', changed: false });
  });

  it('replaces every "." and ":" with "_"', () => {
    assert.deepEqual(normalizeSessionName('a.b:c'), { name: 'a_b_c', changed: true });
  });

  it('rejects a whitespace-only name', () => {
    assert.throws(() => normalizeSessionName('\t '), /empty/i);
  });

  it('rejects control characters, which produce an unattachable session', () => {
    assert.throws(() => normalizeSessionName('a\nb'), /control character/i);
  });
});

describe('session naming: defaults and tmux targeting', () => {
  it('keeps the unique pid+timestamp name when the user names nothing', () => {
    assert.equal(defaultSessionName(4321, 1700000000000), 'claude-retry-4321-1700000000000');
  });

  // A user-chosen name can be a prefix of another session's ("api" vs "api-worker"), and
  // tmux's default target matching is by prefix — it would attach to the wrong session.
  // '=' forces an exact-name match.
  it('attaches by exact name, not tmux prefix matching', () => {
    assert.deepEqual(buildAttachSessionArgs('api'), ['attach-session', '-t', '=api']);
  });

  it('targets the first window by exact session name', () => {
    assert.deepEqual(buildFirstWindowTarget('api'), '=api:0');
  });
});

describe('session naming: duplicate-name failure', () => {
  it('recognizes tmux\'s duplicate-session refusal', () => {
    assert.ok(isDuplicateSessionError({ stderr: 'duplicate session: api\n' }));
    assert.ok(isDuplicateSessionError(new Error('Command failed: tmux new-session\nduplicate session: api\n')));
  });

  it('does not mistake other failures for a duplicate name', () => {
    assert.ok(!isDuplicateSessionError({ stderr: 'server exited unexpectedly' }));
    assert.ok(!isDuplicateSessionError(new Error('spawnSync tmux ENOENT')));
  });

  // A name collision is permanent — retrying it three times just delays the same error.
  it('is not treated as a transient server error', () => {
    assert.ok(!isTransientTmuxServerError({ stderr: 'duplicate session: api' }));
  });
});

describe('session naming: when no session is created', () => {
  it('warns that an explicit --tmux-session is doing nothing', () => {
    assert.match(sessionNameIgnoredWarning('interactive', true), /--tmux-session/);
    assert.match(sessionNameIgnoredWarning('print', true), /--tmux-session/);
  });

  it('stays silent when a session is actually being created', () => {
    assert.equal(sessionNameIgnoredWarning('tmux-session', true), null);
  });

  // The env var is set once per shell and rides along on every launch, including the
  // ones inside an existing session — warning there would be noise on every prompt.
  it('stays silent for the env var, which is ambient rather than per-launch', () => {
    assert.equal(sessionNameIgnoredWarning('interactive', false), null);
  });
});

describe('session naming: the flag never reaches claude', () => {
  // The pane re-invokes this launcher with the surviving argv, which then execs claude.
  // If --tmux-session leaked through, claude would abort on an unknown option — so the
  // stripping and the inner command have to hold together, not just individually.
  it('is absent from the command the tmux pane runs', () => {
    const { rest } = extractSessionName(['--tmux-session', 'api', '--model', 'opus'], {});
    const cmd = buildTmuxInnerCmd('/path/launcher.js', rest, {});
    assert.ok(!cmd.includes('--tmux-session'), cmd);
    assert.ok(!cmd.includes('api'), cmd);
    assert.ok(cmd.includes("'--model' 'opus'"), cmd);
  });
});

describe('session naming: duplicate-name message', () => {
  it('names the collision and gives a runnable way out of it', () => {
    const msg = duplicateSessionMessage('api');
    assert.match(msg, /already exists/);
    assert.match(msg, /tmux attach -t '=api'/);          // exact-match target, copy-pasteable
    assert.match(msg, /--tmux-session api-2/);           // and how to launch a second one
  });
});
