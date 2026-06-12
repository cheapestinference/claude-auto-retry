import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    _entered: 0,
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendEnter: async () => { t._entered++; },
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}

describe('processOneTick', () => {
  it('returns monitoring when no rate limit', async () => {
    const t = mockTmux('Normal output');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('enters waiting on rate limit', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('exits when PID dead', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => false), 'exit');
  });
  it('sends retry when wait expired and rate limit visible', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
    assert.equal(s.retrySentForCurrentLimit, true);
    // Should stay in 'waiting' with a cooldown to let Claude process
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('does not resend retry while stale rate-limit text remains visible', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000;
    s.status = 'waiting';
    s.retrySentForCurrentLimit = true;
    s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'post-retry-waiting');
    assert.equal(t._sent.length, 0);
    assert.equal(s.attempts, 1);
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('ignores stale rate-limit text while Claude is visibly thinking', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Herding… (3m · thinking with xhigh effort)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('ignores stale rate-limit text while Claude is showing active token status', async () => {
    const text = [
      '⎿  You\'ve hit your session limit · resets 2am (Europe/Dublin)',
      '✽ Booping… (1m 43s · ↓ 5.6k tokens)',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ↓ to manage',
      '  ◯ general-purpose  Retry demo-weekend engine prep  24s · ↓ 22.7k tokens',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('clears waiting state when Claude is visibly thinking after retry', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Herding… (3m · thinking with xhigh effort)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000;
    s.status = 'waiting';
    s.retrySentForCurrentLimit = true;
    s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
    assert.equal(s.retrySentForCurrentLimit, false);
  });
  it('clears waiting state when active token status appears after retry', async () => {
    const text = [
      '⎿  You\'ve hit your session limit · resets 2am (Europe/Dublin)',
      '✽ Booping… (1m 43s · ↓ 5.6k tokens)',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ↓ to manage',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000;
    s.status = 'waiting';
    s.retrySentForCurrentLimit = true;
    s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
    assert.equal(s.retrySentForCurrentLimit, false);
  });
  it('detects multi-line TUI rate limit', async () => {
    const t = mockTmux('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('auto-confirms Claude Code rate-limit options menu', async () => {
    const text = [
      '⎿  You\'ve hit your session limit · resets 12:10am (Europe/Dublin)',
      '',
      '❯ /rate-limit-options',
      '',
      'What do you want to do?',
      '',
      '❯ 1. Stop and wait for limit to reset',
      '  2. Upgrade your plan',
      '  3. Upgrade to Team plan',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'confirmed-rate-limit-options');
    assert.equal(t._entered, 1);
    assert.equal(t._sent.length, 0);
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('auto-confirms rate-limit options menu even after entering waiting mode', async () => {
    const text = [
      '⎿  You\'ve hit your session limit · resets 5:10am (Europe/Dublin)',
      '',
      '❯ /rate-limit-options',
      '',
      'What do you want to do?',
      '',
      '❯ 1. Stop and wait for limit to reset',
      '  2. Upgrade your plan',
      '  3. Upgrade to Team plan',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const t = mockTmux(text);
    const s = createMonitorState();
    s.status = 'waiting';
    s.waitUntil = Date.now() + 10_000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'confirmed-rate-limit-options');
    assert.equal(t._entered, 1);
    assert.equal(s.status, 'waiting');
    assert.equal(s.rateLimitOptionsConfirmed, true);
  });
  it('retries when Claude process is in foreground (fixes macOS zsh issue)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'zsh', true);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('falls back to pane_current_command when process state is false', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', false);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('falls back to pane_current_command when process state is null', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('accepts custom foregroundCommands in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'my-claude-wrapper', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    const config = { ...DEFAULT_CONFIG, foregroundCommands: ['my-claude-wrapper'] };
    assert.equal(await processOneTick(s, t, '%0', config, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('matches npx in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'npx', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
  });
  it('resets counter when rate limit disappears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 2;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('stops retrying after max attempts and stays in waiting', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 5;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
    // Should stay in 'waiting' to avoid re-detection loop
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('resets from max-retries when rate limit clears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 10;
    // Rate limit cleared → should detect user-continued before max-retries check
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
});
