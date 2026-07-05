#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeStopFailureEvent, isRetryableError } from '../src/events.js';
import { sweepStaleStatus } from '../src/status-file.js';
import { reconcile, excludeSelf, parseRunningMonitors } from '../src/reconcile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..', 'src');
const LAUNCHER_PATH = join(SRC_DIR, 'launcher.js');
const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');

export const MARKER_START = '# >>> claude-auto-retry >>>';
export const MARKER_END = '# <<< claude-auto-retry <<<';

// --- Wrapper injection ---

export async function injectWrapper(rcFile, launcherPath) {
  let content = '';
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    // File doesn't exist, create it
  }

  const template = await readFile(WRAPPER_TEMPLATE, 'utf-8');
  const wrapper = template.replace(/__LAUNCHER_PATH__/g, launcherPath);

  // Remove existing wrapper if present
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const afterMarker = endIdx + MARKER_END.length;
    // Skip the newline after MARKER_END if present, but don't blindly +1
    const skipTo = content[afterMarker] === '\n' ? afterMarker + 1
                 : content.slice(afterMarker, afterMarker + 2) === '\r\n' ? afterMarker + 2
                 : afterMarker;
    content = content.slice(0, startIdx) + content.slice(skipTo);
  }

  content = content.trimEnd() + '\n\n' + wrapper + '\n';
  await writeFile(rcFile, content);
}

export async function removeWrapper(rcFile) {
  let content;
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    return;
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + MARKER_END.length).trimStart();
  content = before + (after ? '\n' + after : '\n');
  await writeFile(rcFile, content);
}

// --- tmux install ---

function detectOS() {
  if (process.platform === 'darwin') return 'macos';
  try {
    const release = execFileSync('cat', ['/etc/os-release'], { encoding: 'utf-8' });
    if (release.includes('ID=ubuntu') || release.includes('ID=debian') || release.includes('ID_LIKE=debian')) return 'debian';
    if (release.includes('ID=fedora') || release.includes('ID=rhel') || release.includes('ID=centos')
        || release.includes('ID=rocky') || release.includes('ID="amzn"')
        || release.includes('ID_LIKE="rhel') || release.includes('ID_LIKE=rhel')) return 'rhel';
    if (release.includes('ID=arch') || release.includes('ID_LIKE=arch')) return 'arch';
    if (release.includes('ID=alpine')) return 'alpine';
  } catch {}
  return 'unknown';
}

function installTmux() {
  const os = detectOS();
  const cmds = {
    debian: ['sudo', ['apt-get', 'install', '-y', 'tmux']],
    rhel: ['sudo', ['dnf', 'install', '-y', 'tmux']],
    arch: ['sudo', ['pacman', '-S', '--noconfirm', 'tmux']],
    alpine: ['sudo', ['apk', 'add', 'tmux']],
    macos: ['brew', ['install', 'tmux']],
  };

  const entry = cmds[os];
  if (!entry) {
    console.error('Could not detect OS. Please install tmux manually.');
    process.exit(1);
  }

  console.log(`Installing tmux...`);
  try {
    execFileSync(entry[0], entry[1], { stdio: 'inherit' });
  } catch {
    console.error('Failed to install tmux. Please install it manually.');
    process.exit(1);
  }
}

function checkTmux() {
  try {
    const version = execFileSync('tmux', ['-V'], { encoding: 'utf-8' }).trim();
    const match = version.match(/tmux\s+(\d+\.\d+)/);
    if (match && parseFloat(match[1]) >= 2.1) return true;
    console.error(`tmux version ${match?.[1] || 'unknown'} is too old. Requires >= 2.1.`);
    return false;
  } catch {
    return false;
  }
}

// --- CLI commands ---

async function cmdInstall() {
  console.log('claude-auto-retry: installing...\n');

  if (!checkTmux()) {
    console.log('tmux not found or too old. Attempting install...');
    installTmux();
    if (!checkTmux()) { console.error('tmux install failed.'); process.exit(1); }
  }
  console.log('tmux OK');

  const shell = process.env.SHELL || '/bin/bash';
  if (shell.includes('fish')) {
    console.error('\nFish shell detected. Automatic install not supported.');
    console.error(`Add manually to ~/.config/fish/config.fish:`);
    console.error(`  function claude; set -x CLAUDE_AUTO_RETRY_ACTIVE 1; node "${LAUNCHER_PATH}" $argv; set -e CLAUDE_AUTO_RETRY_ACTIVE; end`);
    process.exit(1);
  }

  const rcFiles = [];
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');

  if (existsSync(bashrc) || shell.includes('bash')) rcFiles.push(bashrc);
  if (existsSync(zshrc) || shell.includes('zsh')) rcFiles.push(zshrc);
  if (rcFiles.length === 0) rcFiles.push(bashrc);

  for (const rc of rcFiles) {
    await injectWrapper(rc, LAUNCHER_PATH);
    console.log(`Shell function added to ${rc}`);
  }

  console.log(`\nInstalled! Launcher path: ${LAUNCHER_PATH}`);
  console.log('\nRestart your shell or run:');
  for (const rc of rcFiles) { console.log(`  source ${rc}`); }
  console.log('\nNote: If you switch Node versions (nvm), re-run: claude-auto-retry install');
}

async function cmdUninstall() {
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  for (const rc of [bashrc, zshrc]) { await removeWrapper(rc); }
  // Best-effort GC of tmux-status snapshot files left behind by monitors that died
  // without cleaning up (SIGKILL, host sleep/crash) — see src/status-file.js. Failure
  // here must never block the uninstall itself.
  await sweepStaleStatus().catch(() => {});
  console.log('Shell function removed. Restart your shell to complete.');
}

async function cmdStatus() {
  const logDir = join(homedir(), '.claude-auto-retry', 'logs');
  const today = new Date().toISOString().split('T')[0];
  const logFile = join(logDir, `${today}.log`);
  try {
    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    console.log(`Log file: ${logFile}\n`);
    console.log('Last 10 entries:');
    console.log(lines.slice(-10).join('\n'));
  } catch {
    console.log('No activity today. Log directory:', logDir);
  }
}

async function cmdLogs() {
  const logDir = join(homedir(), '.claude-auto-retry', 'logs');
  const today = new Date().toISOString().split('T')[0];
  const logFile = join(logDir, `${today}.log`);
  if (!existsSync(logFile)) {
    console.log(`No log file for today: ${logFile}`);
    return;
  }
  const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
  tail.on('error', (err) => {
    console.error(`Failed to tail log: ${err.message}`);
  });
  await new Promise((resolve) => {
    tail.on('exit', resolve);
    tail.on('error', resolve);
  });
}

// --- StopFailure hook (event-driven overload trigger) ---

const HOOK_MARKER = '_stopfailure-hook';

function stopFailureHookEntry() {
  // Matcher filters on the StopFailure error type; only the transient-overload classes.
  // rate_limit is intentionally omitted — a session/usage limit is an hours-scale wait
  // owned by the scraper usage path, not a seconds-scale event retry (see src/events.js).
  return {
    matcher: 'overloaded|server_error',
    hooks: [{ type: 'command', command: `node ${__filename} ${HOOK_MARKER}`, timeout: 5 }],
  };
}

function resolveConfigDir(arg) {
  return arg || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Invoked BY Claude Code on a turn-ending API error. Reads the hook JSON on stdin and,
// for a retryable error, writes a pane-keyed marker the monitor consumes. Must never
// disrupt the session: StopFailure output/exit is ignored, and we swallow all errors.
async function cmdStopFailureHook() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const pane = process.env.CLAUDE_AUTO_RETRY_PANE;
    if (pane && isRetryableError(payload.error)) {
      await writeStopFailureEvent(pane, payload);
    }
  } catch { /* swallow — never break the host session */ }
  process.exit(0);
}

async function cmdInstallHook() {
  const settingsPath = join(resolveConfigDir(process.argv[3]), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf-8')); } catch { /* new file */ }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const existing = Array.isArray(settings.hooks.StopFailure) ? settings.hooks.StopFailure : [];
  // Idempotent: drop any prior entry pointing at our handler, then add the current one.
  const kept = existing.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
  kept.push(stopFailureHookEntry());
  settings.hooks.StopFailure = kept;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`StopFailure hook installed in ${settingsPath}`);
  console.log('New Claude sessions launched via the wrapper will use event-driven detection.');
}

async function cmdUninstallHook() {
  const settingsPath = join(resolveConfigDir(process.argv[3]), 'settings.json');
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    if (Array.isArray(settings.hooks?.StopFailure)) {
      settings.hooks.StopFailure = settings.hooks.StopFailure.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
      if (settings.hooks.StopFailure.length === 0) delete settings.hooks.StopFailure;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    console.log(`StopFailure hook removed from ${settingsPath}`);
  } catch { console.log('No settings file to modify.'); }
}

// --- systemd --user timer (self-healing monitor coverage) ---

const SYSTEMD_DIR = join(SRC_DIR, '..', 'systemd');
const UNIT_SERVICE = 'claude-auto-retry-reconcile.service';
const UNIT_TIMER = 'claude-auto-retry-reconcile.timer';

function userUnitDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

// Substitute the node/CLI paths into a unit template. The template quotes the placeholders
// (see the .service), so a path with spaces produces a valid quoted ExecStart.
export function renderReconcileUnit(template, nodePath, cliPath) {
  return template.replace(/__NODE_PATH__/g, nodePath).replace(/__CLI_PATH__/g, cliPath);
}

// Install the reconcile service+timer into the systemd --user unit dir, substituting the
// node and CLI paths, then enable+start the timer. Makes monitor coverage self-healing:
// every 5 min a missing monitor is re-armed. Requires systemd --user (Linux).
async function cmdInstallTimer() {
  const dest = userUnitDir();
  await mkdir(dest, { recursive: true });
  const nodePath = process.execPath;
  const cliPath = __filename;

  let svcTemplate, timerTemplate;
  try {
    svcTemplate = await readFile(join(SYSTEMD_DIR, UNIT_SERVICE), 'utf-8');
    timerTemplate = await readFile(join(SYSTEMD_DIR, UNIT_TIMER), 'utf-8');
  } catch (err) {
    console.error(`Could not read the systemd unit templates from ${SYSTEMD_DIR} (${err.code || err.message}).`);
    console.error('If you installed from npm, upgrade to a version that ships the systemd/ directory,');
    console.error('or run install-timer from a git checkout of the repo.');
    process.exit(1);
  }
  await writeFile(join(dest, UNIT_SERVICE), renderReconcileUnit(svcTemplate, nodePath, cliPath));
  await writeFile(join(dest, UNIT_TIMER), timerTemplate);

  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', UNIT_TIMER], { stdio: 'inherit' });
  } catch {
    console.error(`\nUnits written to ${dest} but enabling failed. Enable manually:`);
    console.error(`  systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_TIMER}`);
    process.exit(1);
  }
  console.log(`\nTimer installed and started. Monitor coverage now self-heals every 5 min.`);
  console.log(`  status:  systemctl --user status ${UNIT_TIMER}`);
  console.log(`  next run: systemctl --user list-timers ${UNIT_TIMER}`);
  console.log(`  tip: for the timer to run while logged out, enable lingering once:`);
  console.log(`       loginctl enable-linger $USER`);
  console.log(`\nNote: the unit pins this Node path (${nodePath}). If you switch Node`);
  console.log(`versions (nvm), re-run: claude-auto-retry install-timer`);
}

async function cmdUninstallTimer() {
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', UNIT_TIMER], { stdio: 'inherit' });
  } catch { /* not enabled — fine */ }
  const dest = userUnitDir();
  for (const u of [UNIT_TIMER, UNIT_SERVICE]) {
    try { await (await import('node:fs/promises')).unlink(join(dest, u)); } catch { /* absent */ }
  }
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' }); } catch { /* ignore */ }
  console.log('Timer removed. (Already-running monitors are unaffected.)');
}

// Durably exclude the current session from auto-monitoring (by its claude PID, which
// is self-expiring and immune to tmux pane-id reuse). Run from inside the session.
async function cmdExcludeSelf() {
  const r = await excludeSelf();
  if (!r.ok) { console.error(`exclude-self: ${r.reason}`); process.exit(1); }
  console.log(r.already
    ? `Already excluded (claude PID ${r.pid}, pane ${r.pane}).`
    : `Excluded this session: claude PID ${r.pid} (pane ${r.pane}). reconcile/timer will skip it.`);
  console.log('The entry self-expires when this claude exits (no cleanup needed).');
  // Kill any monitor already covering this pane so exclusion takes effect immediately.
  // Reuse parseRunningMonitors (same parser reconcile uses) instead of a bespoke one.
  try {
    const out = execFileSync('pgrep', ['-af', 'node .*src/monitor\\.js'], { encoding: 'utf-8' });
    const mpid = parseRunningMonitors(out).get(`${r.pane} ${r.pid}`);
    if (mpid) { try { process.kill(mpid); console.log(`Stopped existing monitor ${mpid}.`); } catch {} }
  } catch { /* no monitor running for this pane — nothing to stop */ }
}

// Re-arm a monitor for every live tmux pane running claude that isn't already covered.
// Restores coverage after a crash/kill or for sessions started outside the wrapper.
async function cmdReconcile() {
  const dryRun = process.argv.includes('--dry-run');
  let result;
  try {
    result = await reconcile({ dryRun });
  } catch (err) {
    console.error(`reconcile failed: ${err.message}`);
    console.error('(needs a running tmux server; run from a machine with your claude sessions)');
    process.exit(1);
  }
  if (result.locked) {
    console.log('Another reconcile is already running (lock held). Nothing to do.');
    return;
  }
  const { armed, skipped } = result;
  if (armed.length === 0 && skipped.length === 0) {
    console.log('No tmux panes running claude found. Nothing to reconcile.');
    return;
  }
  if (armed.length) {
    console.log(dryRun ? `Would arm ${armed.length} monitor(s):` : `Armed ${armed.length} monitor(s):`);
    for (const a of armed) console.log(`  ${a.pane} → claude ${a.pid}${a.monitorPid ? ` (monitor ${a.monitorPid})` : ''}`);
  }
  for (const s of skipped) console.log(`  ${s.pane} → claude ${s.pid}: skipped (${s.reason})`);
  if (armed.length === 0) console.log('All live claude sessions already monitored.');
}

async function cmdVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

// --- Main ---
const command = process.argv[2];

switch (command) {
  case 'install': await cmdInstall(); break;
  case 'uninstall': await cmdUninstall(); break;
  case 'install-hook': await cmdInstallHook(); break;
  case 'uninstall-hook': await cmdUninstallHook(); break;
  case HOOK_MARKER: await cmdStopFailureHook(); break;
  case 'reconcile': await cmdReconcile(); break;
  case 'exclude-self': await cmdExcludeSelf(); break;
  case 'install-timer': await cmdInstallTimer(); break;
  case 'uninstall-timer': await cmdUninstallTimer(); break;
  case 'status': await cmdStatus(); break;
  case 'logs': await cmdLogs(); break;
  case 'version': case '--version': case '-v': await cmdVersion(); break;
  default:
    console.log('claude-auto-retry - Auto-retry Claude Code on subscription rate limits\n');
    console.log('Usage:');
    console.log('  claude-auto-retry install            Install shell wrapper + tmux');
    console.log('  claude-auto-retry uninstall          Remove shell wrapper');
    console.log('  claude-auto-retry install-hook [dir] Install the StopFailure hook (event-driven');
    console.log('                                       overload detection) into <dir>/settings.json');
    console.log('                                       (default: $CLAUDE_CONFIG_DIR or ~/.claude)');
    console.log('  claude-auto-retry uninstall-hook [dir]  Remove the StopFailure hook');
    console.log('  claude-auto-retry reconcile          Re-arm a monitor for every live tmux');
    console.log('                                       claude session not already covered');
    console.log('                                       (--dry-run to preview). Run after a crash.');
    console.log('  claude-auto-retry exclude-self       Keep THIS session unmonitored (durable,');
    console.log('                                       by claude PID; self-expires on exit)');
    console.log('  claude-auto-retry install-timer      Install a systemd --user timer that runs');
    console.log('                                       reconcile every 5 min (self-healing coverage)');
    console.log('  claude-auto-retry uninstall-timer    Remove the reconcile timer');
    console.log('  claude-auto-retry status             Show monitor status');
    console.log('  claude-auto-retry logs               Tail today\'s log');
    console.log('  claude-auto-retry version            Print version');
    break;
}
