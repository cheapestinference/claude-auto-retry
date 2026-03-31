import { spawn, fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isInsideTmux, getCurrentPane, getTmuxVersion } from './tmux.js';
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

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function launchInteractive(args) {
  const claudeBin = findClaudeBinary();
  const pane = getCurrentPane();

  const claude = spawn(claudeBin, args, {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
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

async function launchPrintMode(args) {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const chunks = [];
      const errChunks = [];
      const claude = spawn(claudeBin, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
      });

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

async function createTmuxSession(args) {
  const sessionName = `claude-retry-${process.pid}-${Date.now()}`;
  const launcherPath = __filename;

  // Build the command to run inside tmux
  const escapedLauncher = shellEscape(launcherPath);
  const escapedArgs = args.map(a => shellEscape(a)).join(' ');
  const innerCmd = `CLAUDE_AUTO_RETRY_ACTIVE=1 node ${escapedLauncher} ${escapedArgs}; exec bash`;

  // Build env propagation args
  // tmux -e flag requires tmux >= 3.0; for older versions, prefix env exports in the command
  const tmuxVer = getTmuxVersion();
  let newSessionArgs;

  if (tmuxVer >= 3.0) {
    const envArgs = [];
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('TMUX')) continue;
      if (v == null) continue;
      envArgs.push('-e', `${k}=${v}`);
    }
    newSessionArgs = ['new-session', '-d', '-s', sessionName, ...envArgs, innerCmd];
  } else {
    // For tmux < 3.0: export critical env vars inline in the command
    const criticalVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY',
      'NO_PROXY', 'NODE_OPTIONS', 'NVM_DIR', 'NODE_PATH'];
    const exports = criticalVars
      .filter(k => process.env[k])
      .map(k => `export ${k}=${shellEscape(process.env[k])}`)
      .join('; ');
    const fullCmd = exports ? `${exports}; ${innerCmd}` : innerCmd;
    newSessionArgs = ['new-session', '-d', '-s', sessionName, fullCmd];
  }

  try {
    execFileSync('tmux', newSessionArgs);

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

// Main
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
