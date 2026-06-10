import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureArgs, buildSendTextArgs, buildSendEnterArgs, buildDisplayArgs, parseTmuxVersion } from '../src/tmux.js';

describe('buildCaptureArgs', () => {
  it('builds correct args', () => {
    assert.deepEqual(buildCaptureArgs('%3', 200),
      ['capture-pane', '-t', '%3', '-p', '-S', '-200']);
  });
});
describe('buildSendTextArgs', () => {
  it('sends text literally without Enter (issue #7)', () => {
    assert.deepEqual(buildSendTextArgs('%3', 'hello world'),
      ['send-keys', '-t', '%3', '-l', '--', 'hello world']);
  });
});
describe('buildSendEnterArgs', () => {
  it('sends Enter as its own keystroke', () => {
    assert.deepEqual(buildSendEnterArgs('%3'),
      ['send-keys', '-t', '%3', 'Enter']);
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
