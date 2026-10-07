import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrolledUpView } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

function mockTmux(paneContent, claudeForeground = true) {
  const t = {
    _sent: [], _keys: [],
    content: paneContent,
    capturePane: async () => t.content,
    getPaneCommand: async () => (claudeForeground ? 'node' : 'vim'),
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}
const cfg = (grace = 600) => ({ ...DEFAULT_CONFIG, scrolledUpGraceSeconds: grace });

// Real captures (tmux capture-pane -p) of Claude Code v2.1.292's fullscreen TUI, 120x40,
// after `!seq` filled the transcript: scrolled up with the mouse wheel ("(click)" variant),
// with PgUp in a session that never saw the mouse (keyboard variant), and back at the
// bottom after C-End. A draft sits in the input box of the click/live captures.
const fixture = (name) => readFileSync(new URL(`./fixtures/scrolled-up-${name}.txt`, import.meta.url), 'utf-8');
const CLICK = fixture('click');
const FN = fixture('fn');
const LIVE = fixture('live');
// Scrolled up with the mouse while output was still arriving below the view.
const NEW_MESSAGE = fixture('new-message');
// A live-looking limit banner sitting in the history the user scrolled up to.
const STALE_BANNER = CLICK.replace(/^\s+490\s*$/m, "  ⎿  You've hit your session limit · resets 9:50pm (Europe/London)");

describe('scrolledUpView', () => {
  it('detects the "(click)" indicator above the input box', () => {
    assert.match(scrolledUpView(CLICK).split('\n').at(-1), /Jump to bottom \(click\) ↓/);
  });
  it('detects the keyboard indicator overlaid on a transcript row', () => {
    assert.match(scrolledUpView(FN).split('\n').at(-1), /^\s+170\s+Jump to bottom: fn\+↓ to scroll/);
  });
  it('detects the "N new message" indicator once output arrives below the view', () => {
    assert.match(scrolledUpView(NEW_MESSAGE).split('\n').at(-1), /^\s+17\s+1 new message \(click\) ↓/);
  });
  it('does NOT match "new messages" in a sentence', () => {
    assert.equal(scrolledUpView('⏺ There are 3 new messages in the queue.\n❯ '), null);
  });
  it('does NOT match a padded phrase with no ↓ on its row (a table cell, a log line)', () => {
    assert.equal(scrolledUpView('  | inbox            |          3 new messages |\n❯ '), null);
    assert.equal(scrolledUpView('  status:              Jump to bottom disabled\n❯ '), null);
  });
  it('ignores trailing blank rows below the footer', () => {
    assert.ok(scrolledUpView(CLICK + '\n\n\n\n'));
  });
  it('returns null for a live (bottom-anchored) view', () => {
    assert.equal(scrolledUpView(LIVE), null);
  });
  it('does NOT match the phrase quoted in a sentence', () => {
    assert.equal(scrolledUpView('⏺ Click "Jump to bottom" to get back to the prompt.\n❯ '), null);
    assert.equal(scrolledUpView('  ⎿  the pane showed Jump to bottom (click) ↓\n❯ '), null);
  });
  it('does NOT match an indicator-shaped row far above the bottom', () => {
    const buried = ['                              Jump to bottom (click) ↓', ...Array(30).fill('⏺ more work'), '❯ '].join('\n');
    assert.equal(scrolledUpView(buried), null);
  });
});

describe('processOneTick — scrolled-up transcript', () => {
  it('stands down on a scrolled view instead of reading the stale banner in it', async () => {
    const t = mockTmux(STALE_BANNER);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'scrolled-up');
    assert.equal(s.status, 'monitoring');
    assert.deepEqual(t._sent, []);
    assert.deepEqual(t._keys, []);
  });
  it('holds through the grace period, then jumps to the bottom with C-End', async () => {
    const t = mockTmux(CLICK);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'scrolled-up-holding');
    s._scrolledUp.since -= 601_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'scrolled-down');
    assert.deepEqual(t._keys, ['C-End']);
    assert.equal(s._scrolledUp, null);
  });
  it('restarts the grace clock while the user is still scrolling', async () => {
    const t = mockTmux(CLICK);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg(), () => true);
    s._scrolledUp.since -= 601_000;
    t.content = FN;   // the view moved
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'scrolled-up-holding');
    assert.deepEqual(t._keys, []);
  });
  it('never sends the key when Claude is not the foreground process', async () => {
    const t = mockTmux(CLICK, false);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(0), () => true), 'scrolled-up-holding');
    assert.deepEqual(t._keys, []);
  });
  it('clears the hold once the view is back at the bottom', async () => {
    const t = mockTmux(CLICK);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg(), () => true);
    t.content = LIVE;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
    assert.equal(s._scrolledUp, null);
  });
});

describe('config — scrolledUpGraceSeconds', () => {
  const load = async (obj) => {
    const dir = await mkdtemp(join(tmpdir(), 'car-scroll-'));
    const p = join(dir, 'c.json');
    await writeFile(p, JSON.stringify(obj));
    return loadConfig(p);
  };
  it('defaults to 600s', () => assert.equal(DEFAULT_CONFIG.scrolledUpGraceSeconds, 600));
  it('accepts 0 (jump back at once)', async () => assert.equal((await load({ scrolledUpGraceSeconds: 0 })).scrolledUpGraceSeconds, 0));
  it('rejects a negative or non-number value', async () => {
    assert.equal((await load({ scrolledUpGraceSeconds: -5 })).scrolledUpGraceSeconds, 600);
    assert.equal((await load({ scrolledUpGraceSeconds: 'soon' })).scrolledUpGraceSeconds, 600);
  });
});
