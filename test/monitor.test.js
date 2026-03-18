import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockTmux(paneContent = '', paneCommand = 'node') {
  const t = {
    _sent: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
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
  });
  it('skips when foreground is not claude', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
  });
  it('resets counter when rate limit disappears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 2;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('stops retrying after max attempts', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 5;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
  });
});
