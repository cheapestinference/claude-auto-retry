import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export function buildCaptureArgs(pane, lines = 200) {
  return ['capture-pane', '-t', pane, '-p', '-S', `-${lines}`];
}

// Text and Enter must be sent as two separate tmux calls with a delay in
// between. When they arrive in the same instant, Claude Code's TUI treats
// the burst as a paste and the Enter becomes a newline inside the input box
// instead of submitting it (issue #7).
export function buildSendTextArgs(pane, text) {
  // -l sends the text literally so tmux doesn't interpret words like
  // "Enter" or "Escape" inside the retry message as key names.
  return ['send-keys', '-t', pane, '-l', '--', text];
}

export function buildSendEnterArgs(pane) {
  return ['send-keys', '-t', pane, 'Enter'];
}

export function buildDisplayArgs(pane, format) {
  return ['display-message', '-t', pane, '-p', format];
}

export function parseTmuxVersion(versionString) {
  const match = versionString.match(/tmux\s+(\d+\.\d+)/);
  return match ? parseFloat(match[1]) : 0;
}

export function getTmuxVersion() {
  try {
    return parseTmuxVersion(execFileSync('tmux', ['-V'], { encoding: 'utf-8' }).trim());
  } catch { return 0; }
}

export async function capturePane(pane, lines = 200) {
  const { stdout } = await execFileAsync('tmux', buildCaptureArgs(pane, lines));
  return stdout;
}

export async function sendKeys(pane, text, enterDelayMs = 1000) {
  await execFileAsync('tmux', buildSendTextArgs(pane, text));
  await new Promise(r => setTimeout(r, enterDelayMs));
  await execFileAsync('tmux', buildSendEnterArgs(pane));
}

export async function getPaneCommand(pane) {
  const { stdout } = await execFileAsync('tmux', buildDisplayArgs(pane, '#{pane_current_command}'));
  return stdout.trim();
}

export async function getPaneTty(pane) {
  const { stdout } = await execFileAsync('tmux', buildDisplayArgs(pane, '#{pane_tty}'));
  return stdout.trim();
}

export async function getProcessTty(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'tty=', '-p', String(pid)]);
    return stdout.trim();
  } catch {
    return null;
  }
}

// True when the process is attached to the pane's tty, i.e. it is actually
// running inside that pane — regardless of what pane_current_command claims
// (on macOS it often reports the login shell, e.g. "zsh", issue #1).
export async function isProcessInPane(pane, pid) {
  const [paneTty, procTty] = await Promise.all([
    getPaneTty(pane).catch(() => null),
    getProcessTty(pid),
  ]);
  if (!paneTty || !procTty || procTty === '?' || procTty === '??') return false;
  return paneTty.replace(/^\/dev\//, '') === procTty.replace(/^\/dev\//, '');
}

export async function isProcessForeground(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]);
    return stdout.trim().includes('+');
  } catch {
    return null;
  }
}

export function isInsideTmux() { return !!process.env.TMUX; }
export function getCurrentPane() { return process.env.TMUX_PANE || null; }
