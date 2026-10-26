import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWaitArmed } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

// Native auto-continue (Claude Code v2.1.234+) armed at a usage limit: the two status
// lines under the input box. Native fires at reset + 30–90 s jitter; our own wait would
// fire at reset + marginSeconds and race it.
function hhmm(msFromNow) {
  return new Date(Date.now() + msFromNow)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s+/g, '').toLowerCase();                       // "3:45pm"
}
const RESET = hhmm(2 * 3600_000);
const BANNER_ONLY = [
  '⏺ Refactored the parser; the tests are next.',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  `  Usage limit reached · limit resets ${RESET}`,
].join('\n');
const ARMED = `${BANNER_ONLY}\n  Continuing automatically at ${RESET} · esc to cancel · /usage-credits to continue now`;
const FIRING = `${BANNER_ONLY}\n  Continuing shortly · esc to cancel`;

function mockTmux(paneContent = '', claudeForeground = true) {
  const t = {
    _sent: [], _keys: [],
    capturePane: async () => t._pane,
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => claudeForeground,
    _pane: paneContent,
  };
  return t;
}

describe('nativeWaitArmed', () => {
  it('matches the armed wait chrome line', () => {
    for (const pane of [
      ARMED,
      'Continuing automatically at 3:45pm · esc to cancel',
      '  Continuing automatically at 3:45pm - esc to cancel',
      '│ Continuing automatically at 15:45 (Europe/Madrid) · Esc to cancel │',
    ]) assert.ok(nativeWaitArmed(pane, 12), pane);
  });

  it('matches the firing line ("Continuing shortly")', () => {
    assert.ok(nativeWaitArmed(FIRING, 12));
    assert.ok(nativeWaitArmed('  Continuing shortly · esc to cancel', 12));
  });

  it('reports which of the two states is on screen', () => {
    assert.equal(nativeWaitArmed(ARMED, 12).firing, false);
    assert.equal(nativeWaitArmed(FIRING, 12).firing, true);
  });

  // Harmless if it matches: it marks the same episode.
  it('matches the transcript variant', () =>
    assert.ok(nativeWaitArmed('  Usage limit reached · continuing automatically at 3:45pm · esc to cancel', 12)));

  // "esc to cancel" on the SAME line is the anti-prose gate.
  it('does NOT match prose mentioning "continuing automatically" without esc to cancel', () => {
    assert.equal(nativeWaitArmed('The CLI says it is continuing automatically at 3:45pm.', 12), null);
    assert.equal(nativeWaitArmed('  Continuing automatically at 3:45pm', 12), null);
    assert.equal(nativeWaitArmed('  Continuing shortly', 12), null);
    assert.equal(nativeWaitArmed('  Continuing automatically at 3:45pm\n  · esc to cancel', 12), null);
  });

  it('does NOT match "esc to cancel" before the phrase', () =>
    assert.equal(nativeWaitArmed('  esc to cancel · Continuing automatically at 3:45pm', 12), null));

  it('does NOT match behind a message glyph, the prompt glyph, or inside a tool echo', () => {
    assert.equal(nativeWaitArmed('⏺ Continuing automatically at 3:45pm · esc to cancel', 12), null);
    assert.equal(nativeWaitArmed('❯ Continuing shortly · esc to cancel', 12), null);
    assert.equal(nativeWaitArmed([
      '⏺ Bash(cat notes.txt)',
      '  ⎿  Continuing automatically at 3:45pm · esc to cancel',
      '⏺ That file documents the native wait.',
    ].join('\n'), 12), null);
  });

  it('does NOT match a line outside the tail window', () => {
    const pane = ['  Continuing shortly · esc to cancel', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n');
    assert.equal(nativeWaitArmed(pane, 12), null);
  });

  it('returns null for empty text', () => assert.equal(nativeWaitArmed('', 12), null));
});

describe('nativeDeferSeconds config validation', () => {
  async function loadFrom(obj) {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-nd-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`);
    await writeFile(f, JSON.stringify(obj));
    try { return await loadConfig(f); } finally { await unlink(f); }
  }
  it('defaults to 180', () => assert.equal(DEFAULT_CONFIG.nativeDeferSeconds, 180));
  it('accepts 0 (no defer)', async () => assert.equal((await loadFrom({ nativeDeferSeconds: 0 })).nativeDeferSeconds, 0));
  it('accepts a custom value', async () => assert.equal((await loadFrom({ nativeDeferSeconds: 600 })).nativeDeferSeconds, 600));
  it('falls back on bad values', async () => {
    for (const bad of [-1, '180', null, Infinity]) {
      assert.equal((await loadFrom({ nativeDeferSeconds: bad })).nativeDeferSeconds, 180, String(bad));
    }
  });
});

// Arms a wait from a fresh monitoring state and returns { result, ms-until-wake }.
async function arm(pane, config = DEFAULT_CONFIG) {
  const s = createMonitorState();
  const result = await processOneTick(s, mockTmux(pane), '%0', config, () => true);
  return { result, s, ms: s.waitUntil - Date.now() };
}
const near = (actual, expected, tol = 2000) => Math.abs(actual - expected) < tol;

describe('processOneTick — defer to an armed native wait', () => {
  it('adds nativeDeferSeconds to the wait when the native wait is armed', async () => {
    const base = await arm(BANNER_ONLY);
    const armed = await arm(ARMED);
    assert.equal(base.result, 'waiting');
    assert.equal(armed.result, 'native-armed-deferring');
    assert.equal(armed.s.status, 'waiting');
    assert.ok(near(armed.ms - base.ms, DEFAULT_CONFIG.nativeDeferSeconds * 1000),
      `expected +${DEFAULT_CONFIG.nativeDeferSeconds}s, got +${Math.round((armed.ms - base.ms) / 1000)}s`);
  });

  it('leaves the wait unchanged without the native chrome (reset + margin only)', async () => {
    const base = await arm(BANNER_ONLY);
    // ~2h to the reset + 60 s margin; the minute boundary costs at most 60 s.
    assert.ok(base.ms > 2 * 3600_000 - 60_000 && base.ms < 2 * 3600_000 + 60_000 + 2000,
      `got ${Math.round(base.ms / 1000)}s`);
  });

  it('nativeDeferSeconds: 0 leaves the wait unchanged', async () => {
    const base = await arm(BANNER_ONLY);
    const armed = await arm(ARMED, { ...DEFAULT_CONFIG, nativeDeferSeconds: 0 });
    assert.equal(armed.result, 'waiting');
    assert.ok(near(armed.ms, base.ms));
  });

  it('skips the send while native is firing ("Continuing shortly")', async () => {
    const t = mockTmux(FIRING);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
    const r = await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(r, 'native-firing');
    assert.equal(t._sent.length, 0, 'never type over a firing native continue');
    assert.equal(s.attempts, 0, 'a skip does not consume a retry');
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now(), 'short cooldown before the next recheck');
    assert.ok(s.waitUntil - Date.now() <= DEFAULT_CONFIG.pollIntervalSeconds * 1000 * 2 + 1000);
  });

  it('still sends when the wait expires with native armed but not firing', async () => {
    const t = mockTmux(ARMED);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });

  it('native fired during our wait → the recheck still exits user-continued', async () => {
    const t = mockTmux(ARMED);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(s.status, 'waiting');
    // Native fired: the wait chrome is gone and Claude is working on the continuation.
    t._pane = [
      '  Usage limit reset · continuing automatically',
      '⏺ Picking the tests back up.',
      '✻ Cogitating… (esc to interrupt)',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
    ].join('\n');
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  it('a resumed pane mid-wait also stands down early (before the deferred expiry)', async () => {
    const t = mockTmux(ARMED);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    t._pane = `${BANNER_ONLY}\n⏺ Picking the tests back up.\n✻ Cogitating… (esc to interrupt)`;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
  });
});

// The firing skip must not become a permanent no-send: native wedged mid-fire, or the
// firing text sitting in the tail as an indented reply continuation line, would otherwise
// skip every expiry forever and park the session — the backstop must fire eventually.
describe('processOneTick — the native-firing skip is bounded', () => {
  const BOUND_MS = 3 * 60_000;
  const expiredWaiting = () => {
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
    return s;
  };
  // Runs ticks on the mocked clock, advancing past each cooldown, until a non-skip result.
  async function runUntilNotSkipped(t, s, tmux, limitMs = 10 * 60_000) {
    const t0 = Date.now();
    let r;
    while (Date.now() - t0 < limitMs) {
      r = await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
      if (r !== 'native-firing') break;
      t.mock.timers.tick(Math.max(1, s.waitUntil - Date.now()));
    }
    return { r, elapsed: Date.now() - t0 };
  }

  it('a firing line that never clears stops being skipped after 3 min and the retry is sent', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tmux = mockTmux(FIRING);
    const s = expiredWaiting();
    const { r, elapsed } = await runUntilNotSkipped(t, s, tmux);
    assert.equal(r, 'native-firing-overdue', 'distinct result so the run loop warns');
    assert.ok(elapsed >= BOUND_MS && elapsed < BOUND_MS + DEFAULT_CONFIG.pollIntervalSeconds * 2000 + 1,
      `skipped for ${Math.round(elapsed / 1000)}s`);
    assert.equal(tmux._sent.length, 1);
    assert.equal(s.attempts, 1, 'the overdue send is a real attempt (bounded by maxRetries)');
  });

  it('the latch clears on a new arm, so a later episode gets its own 3 minutes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tmux = mockTmux(FIRING);
    const s = expiredWaiting();
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-firing');
    t.mock.timers.tick(BOUND_MS + 60_000);
    // A new limit episode arms from monitoring.
    s.status = 'monitoring';
    tmux._pane = ARMED;
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(s.status, 'waiting');
    s.waitUntil = Date.now() - 1;
    tmux._pane = FIRING;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-firing');
    assert.equal(tmux._sent.length, 0);
  });

  it('the latch clears on stand-down', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tmux = mockTmux(FIRING);
    const s = expiredWaiting();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    t.mock.timers.tick(BOUND_MS + 60_000);
    tmux._pane = `${BANNER_ONLY}\n⏺ Picking the tests back up.\n✻ Cogitating… (esc to interrupt)`;
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    // Same state re-enters waiting without going through an arm (defensive: the latch
    // belongs to the episode that just stood down).
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; tmux._pane = FIRING;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-firing');
  });
});
