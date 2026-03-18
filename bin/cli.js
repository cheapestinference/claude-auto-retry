#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  case 'status': await cmdStatus(); break;
  case 'logs': await cmdLogs(); break;
  case 'version': case '--version': case '-v': await cmdVersion(); break;
  default:
    console.log('claude-auto-retry - Auto-retry Claude Code on subscription rate limits\n');
    console.log('Usage:');
    console.log('  claude-auto-retry install     Install shell wrapper + tmux');
    console.log('  claude-auto-retry uninstall   Remove shell wrapper');
    console.log('  claude-auto-retry status      Show monitor status');
    console.log('  claude-auto-retry logs        Tail today\'s log');
    console.log('  claude-auto-retry version     Print version');
    break;
}
