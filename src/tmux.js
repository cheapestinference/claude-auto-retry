import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export function buildCaptureArgs(pane, lines = 200) {
  return ['capture-pane', '-t', pane, '-p', '-S', `-${lines}`];
}

export function buildSendKeysArgs(pane, text) {
  return ['send-keys', '-t', pane, text, 'Enter'];
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

export async function sendKeys(pane, text) {
  await execFileAsync('tmux', buildSendKeysArgs(pane, text));
}

export async function getPaneCommand(pane) {
  const { stdout } = await execFileAsync('tmux', buildDisplayArgs(pane, '#{pane_current_command}'));
  return stdout.trim();
}

export function isInsideTmux() { return !!process.env.TMUX; }
export function getCurrentPane() { return process.env.TMUX_PANE || null; }
