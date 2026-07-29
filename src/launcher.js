import { spawn, fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isInsideTmux, getCurrentPane, getTmuxVersion, buildSetWindowOptionArgs } from './tmux.js';
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

// Env forwarded into the tmux session via `new-session -e`. Windows shells (Git Bash /
// MSYS2 / Cygwin) carry names some tmux builds reject as "invalid environment variable
// name" — `ProgramFiles(x86)`, the `=C:` drive pseudo-vars, `!ExitCode` — and one bad
// name kills session creation entirely (#58). POSIX names ([A-Za-z_][A-Za-z0-9_]*) get
// through, plus (by default) bash's exported-function form `BASH_FUNC_name%%` — verified
// accepted and reconstructed by tmux 3.2/3.4, and load-bearing for HPC Environment
// Modules users. `strict: true` drops the function form too; it is the launch-failure
// fallback for tmux builds that reject any exotic name. TMUX* stays excluded so the
// inner session doesn't inherit the outer server's identity.
export function buildTmuxEnvArgs(env = process.env, { strict = false } = {}) {
  const envArgs = [];
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TMUX')) continue;
    if (v == null) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
        && (strict || !/^BASH_FUNC_[A-Za-z_][A-Za-z0-9_]*%%$/.test(k))) continue;
    envArgs.push('-e', `${k}=${v}`);
  }
  return envArgs;
}

// After the tmux session's own claude-auto-retry process exits, the pane falls through
// to a plain shell so the user isn't dropped straight out of tmux. Use the user's actual
// login shell (env.SHELL) rather than a hardcoded `bash` — tmux's own `default-shell`
// config is bypassed here because this pane is started with an explicit command, not the
// session default. (#reported: bash-3.2 stub shown even when SHELL=/bin/zsh)
export function buildTmuxInnerCmd(launcherPath, args, env = process.env) {
  const escapedLauncher = shellEscape(launcherPath);
  const escapedArgs = args.map(a => shellEscape(a)).join(' ');
  const shell = env.SHELL || 'bash';
  return `CLAUDE_AUTO_RETRY_ACTIVE=1 node ${escapedLauncher} ${escapedArgs}; exec ${shellEscape(shell)}`;
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

// Env propagation into the new session. `new-session -e` exists only from tmux 3.2
// (3.0 added -e to new-window/split-window, NOT new-session — 3.0a/3.1c reject it with
// "unknown option" and the whole launch fails; Ubuntu 20.04 ships 3.0a, Debian 11 3.1c).
// Below 3.2, export critical env vars inline in the command instead.
export function buildNewSessionArgs(tmuxVer, sessionName, innerCmd, env = process.env, opts = {}) {
  if (tmuxVer >= 3.2) {
    return ['new-session', '-d', '-s', sessionName, ...buildTmuxEnvArgs(env, opts), innerCmd];
  }
  // No TERM here: tmux force-sets the pane's TERM from its default-terminal, and
  // re-exporting the OUTER terminal's TERM inside the pane would run the TUI with a
  // non-tmux terminfo (the >= 3.2 path correctly lets tmux own TERM).
  const criticalVars = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY',
    'NO_PROXY', 'NODE_OPTIONS', 'NVM_DIR', 'NODE_PATH'];
  const exports = criticalVars
    .filter(k => env[k])
    .map(k => `export ${k}=${shellEscape(env[k])}`)
    .join('; ');
  const fullCmd = exports ? `${exports}; ${innerCmd}` : innerCmd;
  return ['new-session', '-d', '-s', sessionName, fullCmd];
}

// The ordered arg-lists to try for session creation: the lenient env filter first, then
// (only when it actually differs) a strict-POSIX retry — some tmux builds reject names
// the mainstream ones accept, and a filtered launch beats no launch (#58).
export function newSessionAttempts(tmuxVer, sessionName, innerCmd, env = process.env) {
  const lenient = buildNewSessionArgs(tmuxVer, sessionName, innerCmd, env);
  const strict = buildNewSessionArgs(tmuxVer, sessionName, innerCmd, env, { strict: true });
  return JSON.stringify(lenient) === JSON.stringify(strict) ? [lenient] : [lenient, strict];
}

async function createTmuxSession(args) {
  const sessionName = `claude-retry-${process.pid}-${Date.now()}`;
  const launcherPath = __filename;

  // Build the command to run inside tmux
  const innerCmd = buildTmuxInnerCmd(launcherPath, args);
  const attempts = newSessionAttempts(getTmuxVersion(), sessionName, innerCmd);

  try {
    // Lenient env filter first; on rejection (a tmux build stricter about -e names than
    // the mainstream ones), retry with the strict-POSIX form before giving up.
    for (let i = 0; i < attempts.length; i++) {
      try { execFileSync('tmux', attempts[i]); break; }
      catch (err) { if (i === attempts.length - 1) throw err; }
    }

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
    process.stderr.write(`[claude-auto-retry] Failed to create tmux session: ${err.message}\n`);
    return 1;
  }
}

// Main — only when executed directly (`node launcher.js …`), never when imported for its
// exported helpers (e.g. resolveLaunchCommand under test).
const isDirectRun = process.argv[1]?.endsWith('launcher.js');
if (isDirectRun) {
  const args = process.argv.slice(2);

  let exitCode;
  if (isPrintMode(args)) {
    exitCode = await launchPrintMode(args);
  } else if (isInsideTmux()) {
    exitCode = await launchInteractive(args);
  } else {
    exitCode = await createTmuxSession(args);
  }

  process.exit(exitCode);
}
