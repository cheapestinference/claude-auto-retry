import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export function buildCaptureArgs(pane, lines = 200) {
  return ['capture-pane', '-t', pane, '-p', '-S', `-${lines}`];
}

// Submit delay: when sending a message to a TUI like Claude Code (Ink-based),
// the text and the submitting Enter must be sent as TWO separate tmux send-keys
// calls with a brief pause between them. Without the pause, Ink on Linux often:
//   - interprets the Enter as a newline within a bracketed-paste burst and just
//     inserts "\n" into the input box instead of submitting (most common case)
//   - or processes the Enter before React reconciliation has incorporated the
//     text into input state, dropping the submit
// 150ms is empirically reliable across Linux + macOS for Claude Code.
export const SUBMIT_DELAY_MS = 150;

// Single-call form. Kept for callers / tests that want the legacy shape; the
// production sendKeys() below uses the split form for reliability.
export function buildSendKeysArgs(pane, text) {
  return ['send-keys', '-t', pane, text, 'Enter'];
}

// Split form: text-only, sent literally (-l) so any tmux key names inside a
// custom retry message (e.g. "Enter", "C-c") are typed as text rather than
// interpreted as keypresses. No trailing Enter — that is a separate call.
export function buildSendTextArgs(pane, text) {
  return ['send-keys', '-t', pane, '-l', text];
}

// Split form: bare Enter to submit, sent outside the paste window.
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

export async function sendKeys(pane, text) {
  // Submit-to-TUI in two steps. See SUBMIT_DELAY_MS for why.
  await execFileAsync('tmux', buildSendTextArgs(pane, text));
  await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
  await execFileAsync('tmux', buildSendEnterArgs(pane));
}

export async function getPaneCommand(pane) {
  const { stdout } = await execFileAsync('tmux', buildDisplayArgs(pane, '#{pane_current_command}'));
  return stdout.trim();
}

export function buildSetWindowOptionArgs(target, option, value) {
  return ['set-window-option', '-t', target, option, value];
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
