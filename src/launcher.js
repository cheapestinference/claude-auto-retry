import { spawn, fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getCurrentPane, buildSetWindowOptionArgs } from './tmux.js';
import { isRateLimited } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MONITOR_PATH = join(__dirname, 'monitor.js');

function findClaudeBinary() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'claude';
  }
}

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

// Optional launch wrapper. Set CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER to a prefix command
// (e.g. "caffeinate -i" on macOS to keep the machine awake, or "nice", "chrt …") and it is
// prepended to the claude invocation: `<wrapper> <claudeBin> <args…>`. Generic — not tied to
// any one OS; unset/blank spawns claude directly (unchanged default). (#47)
export function resolveLaunchCommand(claudeBin, args, env = process.env) {
  const wrapper = (env.CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER || '').trim();
  if (!wrapper) return { cmd: claudeBin, cmdArgs: args };
  const toks = wrapper.split(/\s+/);
  return { cmd: toks[0], cmdArgs: [...toks.slice(1), claudeBin, ...args] };
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Env snapshot file (#68) ---
// The environment must cross into the tmux pane WITHOUT riding any argv. The previous
// `new-session -e KEY=VALUE` forwarding put every exported secret into the argv of the
// invocation that (often) STARTS the tmux server — and the server keeps that argv in
// /proc/<pid>/cmdline, world-readable (0444), for its entire multi-day lifetime. The
// < 3.2 inline-`export` branch had the same exposure through the pane command string.
// Instead: serialize the env to a 0600 JSON file in a 0700 dir, put only the PATH of
// that file on the command line, and have the inner launcher load it into process.env
// (Node round-trips names a POSIX `source` can't — BASH_FUNC_name%% exported functions,
// Windows `ProgramFiles(x86)` — which also removes the #58 class entirely: no env name
// ever reaches tmux's argv parser again) and unlink it. TMUX* never crosses: the inner
// pane's own server identity/pane id must win.
const ENV_SNAPSHOT_DIR = join(homedir(), '.claude-auto-retry', 'tmp');

export function writeEnvSnapshot(env = process.env, dir = ENV_SNAPSHOT_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);   // pre-existing dir may have been created looser
  const snap = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (k.startsWith('TMUX')) continue;
    if (k === 'CLAUDE_AUTO_RETRY_ENV_FILE') continue;
    snap[k] = v;
  }
  const path = join(dir, `env-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify(snap), { mode: 0o600 });
  return path;
}

export function applyEnvSnapshot(target, snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (k.startsWith('TMUX')) continue;              // pane identity belongs to the inner session
    if (k === 'CLAUDE_AUTO_RETRY_ENV_FILE') continue;
    target[k] = v;
  }
}

// Inner-launcher side: load the snapshot the outer launcher wrote, then remove it from
// disk and from the env unconditionally — a corrupt snapshot must degrade to the pane's
// own (server) environment, never linger on disk or leak the pointer to claude's children.
export function consumeEnvSnapshot(env = process.env) {
  const path = env.CLAUDE_AUTO_RETRY_ENV_FILE;
  if (!path) return false;
  delete env.CLAUDE_AUTO_RETRY_ENV_FILE;
  let applied = false;
  try {
    applyEnvSnapshot(env, JSON.parse(readFileSync(path, 'utf-8')));
    applied = true;
  } catch { /* missing/corrupt snapshot → run with the pane env */ }
  try { unlinkSync(path); } catch { /* already gone */ }
  return applied;
}

// Crash resilience: a snapshot is normally unlinked within seconds by the inner launcher;
// one that survives means the session never started (or died pre-consume). Sweep those on
// the next launch so failed launches can't strand secrets files.
export function sweepStaleEnvSnapshots(dir = ENV_SNAPSHOT_DIR, maxAgeMs = 24 * 3600_000) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(dir)) {
      if (!/^env-.*\.json$/.test(f)) continue;
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* dir absent */ }
}

// After the tmux session's own claude-auto-retry process exits, keep the pane ONLY when
// something went wrong: a non-zero launcher exit falls through to the user's login shell
// so the crash scrollback survives, while a clean exit lets the pane command end — tmux
// then reaps the session itself. The old unconditional `; exec $SHELL` tail meant NOTHING
// ever destroyed a session (nothing in the package calls kill-session), leaking every
// session for the host's uptime (#69: 66 sessions / 16.4 GB in 3 days).
// CLAUDE_AUTO_RETRY_KEEP_SHELL=1 restores the old always-keep tail. The user's actual
// login shell (env.SHELL) is used rather than hardcoded bash — tmux's default-shell is
// bypassed for panes started with an explicit command.
// `node` is spelled as the launching process.execPath: with no env forwarded via tmux, a
// pre-existing server's stale PATH must not decide whether the launcher can start.
export function buildTmuxInnerCmd(launcherPath, args, env = process.env, envFilePath = null) {
  const escapedLauncher = shellEscape(launcherPath);
  const escapedArgs = args.map(a => shellEscape(a)).join(' ');
  const shell = env.SHELL || 'bash';
  const envPtr = envFilePath ? `CLAUDE_AUTO_RETRY_ENV_FILE=${shellEscape(envFilePath)} ` : '';
  const launch = `${envPtr}CLAUDE_AUTO_RETRY_ACTIVE=1 ${shellEscape(process.execPath)} ${escapedLauncher} ${escapedArgs}`;
  if (env.CLAUDE_AUTO_RETRY_KEEP_SHELL) {
    return `${launch}; exec ${shellEscape(shell)}`;
  }
  return `${launch}; rc=$?; [ "$rc" -ne 0 ] && exec ${shellEscape(shell)}; exit "$rc"`;
}

async function launchInteractive(args) {
  const claudeBin = findClaudeBinary();
  const pane = getCurrentPane();

  // CLAUDE_AUTO_RETRY_PANE is inherited by claude's child processes — notably the
  // StopFailure hook, which writes a pane-keyed event marker the monitor consumes.
  const { cmd, cmdArgs } = resolveLaunchCommand(claudeBin, args);
  const claude = spawn(cmd, cmdArgs, {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1', ...(pane ? { CLAUDE_AUTO_RETRY_PANE: pane } : {}) },
  });

  // Check spawn succeeded before using PID
  if (claude.pid == null) {
    claude.on('error', (err) => {
      process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
    });
    return new Promise((resolve) => {
      claude.on('exit', (code) => resolve(code ?? 1));
      claude.on('error', () => resolve(1));
    });
  }

  // Forward SIGWINCH for terminal resize
  process.on('SIGWINCH', () => {
    try { claude.kill('SIGWINCH'); } catch {}
  });

  // Start monitor as detached background process
  if (pane) {
    const monitor = fork(MONITOR_PATH, [pane, String(claude.pid)], {
      detached: true,
      stdio: 'ignore',
    });
    monitor.unref();
  }

  // Forward signals to Claude
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { claude.kill(sig); } catch {}
    });
  }

  return new Promise((resolve) => {
    claude.on('exit', (code) => resolve(code ?? 1));
  });
}

// Read stdin to EOF, but resolve with an empty buffer if NO data has arrived within
// graceMs (claude's own "no stdin data received in 3s, proceeding without it"). Once the
// first byte arrives the grace no longer applies — a real piped prompt delivers promptly
// and then EOFs.
export function readStdinWithGrace(stream, graceMs) {
  return new Promise((resolve) => {
    const parts = [];
    let received = false;
    const finish = () => { clearTimeout(timer); resolve(Buffer.concat(parts)); };
    const timer = setTimeout(() => {
      if (!received) {
        stream.pause();
        process.stderr.write('[claude-auto-retry] no stdin data received in 3s, proceeding without it\n');
        resolve(Buffer.alloc(0));
      }
    }, graceMs);
    stream.on('data', (c) => { received = true; parts.push(c); });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

async function launchPrintMode(args) {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  let retries = 0;

  // A piped prompt (`cat doc.md | claude -p`) is read to EOF by the FIRST attempt when
  // stdin is inherited — a retry would then run claude with an empty prompt and silently
  // produce a wrong answer. Buffer piped stdin once and re-feed it to every attempt.
  // A TTY stdin stays inherited (nothing to replay; claude reads the terminal directly).
  // Mirroring claude's own behavior, give up after a short no-data grace instead of
  // reading to EOF unconditionally: `ssh host claude -p '…'` and CI harnesses hold stdin
  // open without ever writing, and an unconditional read hangs forever ahead of claude
  // (which would have proceeded after ITS 3s grace).
  let stdinBuf = null;
  if (!process.stdin.isTTY) {
    stdinBuf = await readStdinWithGrace(process.stdin, 3000);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const chunks = [];
      const errChunks = [];
      const claude = spawn(claudeBin, args, {
        stdio: [stdinBuf ? 'pipe' : 'inherit', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
      });
      if (stdinBuf) {
        claude.stdin.on('error', () => {});   // EPIPE if claude exits without reading
        claude.stdin.end(stdinBuf);
      }

      claude.stdout.on('data', (d) => chunks.push(d));
      claude.stderr.on('data', (d) => errChunks.push(d));
      claude.on('error', (err) => {
        resolve({ code: 1, stdout: '', stderr: err.message });
      });
      claude.on('exit', (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errChunks).toString(),
        });
      });
    });

    const combined = result.stdout + result.stderr;

    if (!isRateLimited(combined, config.customPatterns)) {
      // Clean exit — write buffered output
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.code;
    }

    // Rate limited — discard buffer, wait and retry
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      return 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    process.stderr.write(`[claude-auto-retry] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${retries}/${config.maxRetries}...\n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Session creation carries NO environment: the env crosses via the snapshot file (#68),
// which also makes the tmux version irrelevant here — `-e` (3.2+) and the inline-export
// fallback (< 3.2) are both gone, and with them the whole class of "tmux rejects this
// env NAME" launch failures (#58). A server started fresh by this invocation still
// inherits the full launching env the normal Unix way (execFileSync passes process.env),
// so the pane's fallback shell keeps working; a pre-existing server's stale env only
// ever reaches that fallback shell, never claude itself.
export function buildNewSessionArgs(sessionName, innerCmd) {
  return ['new-session', '-d', '-s', sessionName, innerCmd];
}

async function createTmuxSession(args) {
  const sessionName = `claude-retry-${process.pid}-${Date.now()}`;
  const launcherPath = __filename;

  sweepStaleEnvSnapshots();
  let envFile = null;
  try { envFile = writeEnvSnapshot(process.env); }
  catch { /* unwritable HOME → degrade: pane runs with the server env */ }

  const innerCmd = buildTmuxInnerCmd(launcherPath, args, process.env, envFile);

  try {
    execFileSync('tmux', buildNewSessionArgs(sessionName, innerCmd));

    // Best-effort: enable mouse mode (scroll, copy-mode, pane/window click) and
    // vi-style copy-mode keys on the session's first window. Requires tmux >= 2.1;
    // wrapped so an older tmux that rejects these options doesn't fail the whole
    // session creation.
    try {
      execFileSync('tmux', buildSetWindowOptionArgs(`${sessionName}:0`, 'mouse', 'on'));
      execFileSync('tmux', buildSetWindowOptionArgs(`${sessionName}:0`, 'mode-keys', 'vi'));
    } catch { /* old tmux without these options — skip silently */ }

    // Attach to the session
    const attachResult = spawn('tmux', ['attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });

    return new Promise((resolve) => {
      attachResult.on('exit', (code) => resolve(code ?? 0));
      attachResult.on('error', () => resolve(1));
    });
  } catch (err) {
    // The inner launcher never ran, so nothing will consume the snapshot — remove it now
    // rather than leaving a secrets file for the 24h sweep.
    if (envFile) { try { unlinkSync(envFile); } catch { /* already gone */ } }
    process.stderr.write(`[claude-auto-retry] Failed to create tmux session: ${err.message}\n`);
    return 1;
  }
}

// CLAUDE_AUTO_RETRY_NO_TMUX=1 skips tmux session creation for users already inside a
// non-tmux multiplexer (Zellij, screen): without it every launch minted a fresh nested
// tmux session (#69). Explicit opt-out rather than auto-detection — the nested session
// is what the monitor drives, so skipping it trades auto-retry away, and that trade is
// the user's to make.
export function chooseLaunchMode(args, env = process.env) {
  if (isPrintMode(args)) return 'print';
  if (env.TMUX || env.CLAUDE_AUTO_RETRY_NO_TMUX) return 'interactive';
  return 'tmux-session';
}

// Main — only when executed directly (`node launcher.js …`), never when imported for its
// exported helpers (e.g. resolveLaunchCommand under test).
const isDirectRun = process.argv[1]?.endsWith('launcher.js');
if (isDirectRun) {
  const args = process.argv.slice(2);

  // Inside the pane: adopt the launching shell's environment before anything reads it
  // (config load, claude spawn, monitor fork all inherit from here).
  consumeEnvSnapshot(process.env);

  const mode = chooseLaunchMode(args);
  let exitCode;
  if (mode === 'print') {
    exitCode = await launchPrintMode(args);
  } else if (mode === 'interactive') {
    exitCode = await launchInteractive(args);
  } else {
    exitCode = await createTmuxSession(args);
  }

  process.exit(exitCode);
}
