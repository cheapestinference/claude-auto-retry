import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { staleResetMatch } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_NATIVE_STALE_RESET } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

// Native auto-continue (Claude Code v2.1.234+) gone stale: the host slept more than ~30
// min past the reset, so instead of continuing on its own the two status lines under the
// input box turn into a request for a human Enter — and wait for it indefinitely.
const STALE = [
  '⏺ Migrated the first half of the handlers; the rest are queued in the todo list.',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  Your usage limit has reset',
  '  Press enter to continue',
].join('\n');

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [], _keys: [],
    capturePane: async () => t._pane,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => claudeForeground,
    _pane: paneContent,
  };
  return t;
}

function cfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, nativeStaleReset: { ...DEFAULT_NATIVE_STALE_RESET, ...overrides } };
}

describe('staleResetMatch', () => {
  it('detects the stale pair in the pane tail', () =>
    assert.ok(staleResetMatch(STALE, 12)));

  it('detects the pair behind a chrome glyph / box prefix, with trailing suffixes', () => {
    for (const pane of [
      '  ⎿ Your usage limit has reset\n  ⎿ Press enter to continue',
      '│ Your usage limit has reset          │\n│ Press enter to continue · esc to cancel │',
      '⚠ Your usage limit has reset · 3:45pm\nPress enter to continue',
      'Your usage limit has reset\n\nPress Enter to continue …',
    ]) assert.ok(staleResetMatch(pane, 12), pane);
  });

  // "Press enter to continue" is a generic phrase — installers, pagers, test runners print
  // it. Only the PAIR, in order, is the signature.
  it('does NOT match "Press enter to continue" alone', () => {
    assert.equal(staleResetMatch('Running migrations…\nPress enter to continue', 12), null);
    assert.equal(staleResetMatch('  Press enter to continue', 12), null);
  });

  it('does NOT match the pair out of order', () =>
    assert.equal(staleResetMatch('Press enter to continue\nYour usage limit has reset', 12), null));

  it('does NOT match prose quoting both phrases mid-sentence', () => {
    assert.equal(staleResetMatch([
      '⏺ When the native wait goes stale it shows "Your usage limit has reset" and then',
      '  asks you to "Press enter to continue" before doing anything.',
    ].join('\n'), 12), null);
    assert.equal(staleResetMatch(
      'It said Your usage limit has reset, then Press enter to continue.', 12), null);
  });

  // The message glyph introduces the model's own output and ❯ the user's typed row —
  // neither is the native chrome, whatever follows it.
  it('does NOT match the phrases behind a message glyph or the prompt glyph', () => {
    assert.equal(staleResetMatch('⏺ Your usage limit has reset\n  Press enter to continue', 12), null);
    assert.equal(staleResetMatch('❯ Your usage limit has reset\nPress enter to continue', 12), null);
  });

  it('does NOT match the pair quoted inside a tool-call render', () =>
    assert.equal(staleResetMatch([
      '⏺ Bash(cat notes.txt)',
      '  ⎿  Your usage limit has reset',
      '     Press enter to continue',
    ].join('\n'), 12), null));

  it('does NOT match a pair OUTSIDE the tail window', () => {
    const below = Array.from({ length: 13 }, (_, i) => `line of later work ${i}`).join('\n');
    const pane = `Your usage limit has reset\nPress enter to continue\n${below}`;
    assert.equal(staleResetMatch(pane, 12), null);
    assert.ok(staleResetMatch(pane, 20), 'a wider window sees it — the window is what excludes it');
  });

  it('returns null for empty text', () =>
    assert.equal(staleResetMatch('', 12), null));
});

describe('nativeStaleReset config validation', () => {
  async function loadFrom(obj) {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-sr-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`);
    await writeFile(f, JSON.stringify(obj));
    try { return await loadConfig(f); } finally { await unlink(f); }
  }
  it('is present on DEFAULT_CONFIG with the documented defaults', () =>
    assert.deepEqual(DEFAULT_CONFIG.nativeStaleReset, { enabled: true, maxRetries: 2, retryDelaySeconds: 3 }));
  it('merges a partial block onto defaults', async () => {
    const c = await loadFrom({ nativeStaleReset: { maxRetries: 1 } });
    assert.deepEqual(c.nativeStaleReset, { enabled: true, maxRetries: 1, retryDelaySeconds: 3 });
  });
  it('falls back on bad values', async () => {
    const c = await loadFrom({ nativeStaleReset: { enabled: 'yes', maxRetries: 0, retryDelaySeconds: -2 } });
    assert.deepEqual(c.nativeStaleReset, DEFAULT_NATIVE_STALE_RESET);
  });
});

const near = (actual, expectedMs) => Math.abs(actual - expectedMs) < 2000;

// A monitor that armed on the original banner and was suspended with the host: on wake
// the countdown has expired and the banner is gone — the screen the recheck used to read
// as "the user continued".
function expiredWait() {
  const s = createMonitorState();
  s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
  return s;
}

describe('processOneTick — native stale-reset nudge', () => {
  it('waiting-state recheck routes to the nudge instead of concluding user-continued', async () => {
    const t = mockTmux(STALE);
    const s = expiredWait();
    const r = await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(r, 'stale-reset-detected');
    assert.equal(s.status, 'stale-reset');
    assert.equal(s.attempts, 0);
    assert.equal(t._keys.length, 0, 'no key on detection — the delay comes first');
    assert.ok(near(s.staleResetWaitUntil - Date.now(), DEFAULT_NATIVE_STALE_RESET.retryDelaySeconds * 1000));
  });

  it('sends a bare Enter keypress (not a text message) once the delay elapses', async () => {
    const t = mockTmux(STALE);
    const s = createMonitorState();
    s.status = 'stale-reset'; s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'stale-reset-nudged');
    assert.deepEqual(t._keys, ['Enter']);
    assert.deepEqual(t._sent, []);
    assert.equal(s.staleResetAttempts, 1);
  });

  it('enters the family from plain monitoring too (monitor started after the wait armed)', async () => {
    const t = mockTmux(STALE);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'stale-reset-detected');
    assert.equal(s.status, 'stale-reset');
  });

  it('sends Enter at an idle prompt only', async () => {
    const working = STALE + '\n✻ Thinking… (esc to interrupt)';
    // Not entered while working…
    const t1 = mockTmux(working);
    assert.equal(await processOneTick(createMonitorState(), t1, '%0', cfg(), () => true), 'monitoring');
    // …and deferred, without consuming an attempt, if work starts mid-episode.
    const t2 = mockTmux(working);
    const s = createMonitorState();
    s.status = 'stale-reset'; s.staleResetWaitUntil = Date.now() - 1; s.staleResetAttempts = 1;
    assert.equal(await processOneTick(s, t2, '%0', cfg(), () => true), 'stale-reset-working');
    assert.equal(s.staleResetAttempts, 1);
    assert.equal(t2._keys.length, 0);
  });

  it('does not press Enter into a non-claude foreground', async () => {
    const t = mockTmux(STALE, 'vim', false);
    const s = createMonitorState();
    s.status = 'stale-reset'; s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'skipped-not-claude');
    assert.equal(t._keys.length, 0);
  });

  it('is BOUNDED — gives up loudly after maxRetries, once, then holds', async () => {
    const t = mockTmux(STALE);
    const s = createMonitorState();
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'stale-reset-detected');
    for (let i = 0; i < 2; i++) {
      s.staleResetWaitUntil = Date.now() - 1;
      assert.equal(await processOneTick(s, t, '%0', c, () => true), 'stale-reset-nudged');
    }
    assert.deepEqual(t._keys, ['Enter', 'Enter']);
    s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'stale-reset-gave-up');
    assert.equal(s._gaveUp, true);
    s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'stale-reset-holding');
    assert.equal(t._keys.length, 2);
  });

  it('a cleared render ends the episode and resets the counters', async () => {
    const t = mockTmux(STALE);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg(), () => true);
    s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'stale-reset-nudged');
    t._pane = '⏺ Picking up the remaining handlers.\n\n❯ ';
    s.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'stale-reset-cleared');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.staleResetAttempts, 0);
    assert.equal(s._gaveUp, false);
  });

  it('a live usage-limit banner takes precedence over the stale render', async () => {
    const t = mockTmux(STALE + "\nYou've hit your session limit · resets 3pm (UTC)");
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'waiting');
    // …and a banner returning mid-episode hands back to the usage wait.
    const s2 = createMonitorState();
    s2.status = 'stale-reset'; s2.staleResetWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s2, t, '%0', cfg(), () => true), 'waiting');
    assert.equal(t._keys.length, 0);
  });

  it('enabled: false disables it — the recheck concludes user-continued as before', async () => {
    const t = mockTmux(STALE);
    assert.equal(await processOneTick(expiredWait(), t, '%0', cfg({ enabled: false }), () => true), 'user-continued');
    assert.equal(await processOneTick(createMonitorState(), t, '%0', cfg({ enabled: false }), () => true), 'monitoring');
    assert.equal(t._keys.length, 0);
  });
});
