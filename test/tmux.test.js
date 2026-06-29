import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureArgs, buildSendKeysArgs, buildSendTextArgs, buildSendEnterArgs, buildDisplayArgs, parseTmuxVersion, SUBMIT_DELAY_MS, buildSetWindowOptionArgs } from '../src/tmux.js';

describe('buildCaptureArgs', () => {
  it('builds correct args', () => {
    assert.deepEqual(buildCaptureArgs('%3', 200),
      ['capture-pane', '-t', '%3', '-p', '-S', '-200']);
  });
});
describe('buildSendKeysArgs', () => {
  it('builds correct args with Enter (legacy single-call form)', () => {
    assert.deepEqual(buildSendKeysArgs('%3', 'hello world'),
      ['send-keys', '-t', '%3', 'hello world', 'Enter']);
  });
});
describe('buildSendTextArgs', () => {
  it('builds literal text-only send-keys args (no Enter)', () => {
    assert.deepEqual(buildSendTextArgs('%3', 'hello world'),
      ['send-keys', '-t', '%3', '-l', 'hello world']);
  });
  it('sends key-like words as literal text, not keypresses', () => {
    assert.deepEqual(buildSendTextArgs('%3', 'press Enter to continue'),
      ['send-keys', '-t', '%3', '-l', 'press Enter to continue']);
  });
});
describe('buildSendEnterArgs', () => {
  it('builds bare-Enter send-keys args', () => {
    assert.deepEqual(buildSendEnterArgs('%3'),
      ['send-keys', '-t', '%3', 'Enter']);
  });
});
describe('SUBMIT_DELAY_MS', () => {
  it('is a positive number giving Ink time to reconcile before Enter', () => {
    assert.equal(typeof SUBMIT_DELAY_MS, 'number');
    assert.ok(SUBMIT_DELAY_MS >= 50 && SUBMIT_DELAY_MS <= 1000);
  });
});
describe('buildDisplayArgs', () => {
  it('builds correct args', () => {
    assert.deepEqual(buildDisplayArgs('%3', '#{pane_current_command}'),
      ['display-message', '-t', '%3', '-p', '#{pane_current_command}']);
  });
});
describe('parseTmuxVersion', () => {
  it('parses "tmux 3.4"', () => { assert.equal(parseTmuxVersion('tmux 3.4'), 3.4); });
  it('parses "tmux 2.1"', () => { assert.equal(parseTmuxVersion('tmux 2.1'), 2.1); });
  it('returns 0 for unparseable', () => { assert.equal(parseTmuxVersion('not tmux'), 0); });
});

describe('buildSetWindowOptionArgs', () => {
  it('builds correct args for mouse on', () => {
    assert.deepEqual(buildSetWindowOptionArgs('session:0', 'mouse', 'on'),
      ['set-window-option', '-t', 'session:0', 'mouse', 'on']);
  });
  it('builds correct args for mode-keys vi', () => {
    assert.deepEqual(buildSetWindowOptionArgs('claude-retry-123:0', 'mode-keys', 'vi'),
      ['set-window-option', '-t', 'claude-retry-123:0', 'mode-keys', 'vi']);
  });
});
