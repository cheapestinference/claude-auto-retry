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

  // The armed regex already tolerated the one-line record ("Usage limit reached ·
  // continuing automatically at … · esc to cancel"); firing did not, so a one-line firing
  // render matched NEITHER and an expired wait typed over native mid-fire.
  it('matches the one-line firing variant as firing', () => {
    const r = nativeWaitArmed('  Usage limit reached · continuing shortly · esc to cancel', 12);
    assert.ok(r);
    assert.equal(r.firing, true);
    assert.equal(nativeWaitArmed(FIRING, 12).firing, true, 'two-line form unchanged');
    assert.equal(nativeWaitArmed('  Usage limit reached · continuing shortly', 12), null,
      'still needs esc to cancel on the same line');
    assert.equal(nativeWaitArmed('⏺ Usage limit reached · continuing shortly · esc to cancel', 12), null,
      'a model-output line still never matches');
  });
});

// Invisible codepoints are unreviewable (#75 shipped a VS16 miss): the source spells the
// variation selector as an escape, never as the raw character.
it('src/patterns.js carries no raw U+FE0F', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/patterns.js', import.meta.url), 'utf8');
  assert.equal(src.includes('️'), false);
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

  // Native fired, the continuation instantly re-hit the limit, and native re-armed for the
  // NEXT reset — the brief working spinner slipped between polls, so nothing stood us
  // down. At our deferred expiry the pane shows a fresh banner + a fresh armed line.
  // Typing here cancels native's fresh wait (and repeating it burns into max-retries):
  // both signals agree a new wait is armed, so re-arm ours instead.
  it('re-arms instead of sending when the expiry finds a fresh native wait (future reset)', async () => {
    const t = mockTmux(ARMED);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 3;
    const base = await arm(BANNER_ONLY);
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'native-rearmed');
    assert.equal(t._sent.length, 0, 'never type over a freshly armed native wait');
    assert.equal(s.status, 'waiting');
    assert.equal(s.attempts, 0, 'a re-hit limit is a fresh episode');
    assert.ok(near(s.waitUntil - Date.now(), base.ms + DEFAULT_CONFIG.nativeDeferSeconds * 1000));
  });

  // The guard: the armed line alone must not re-arm. A banner whose reset has passed
  // means native's wait is over (or that line is stale) — the backstop must send.
  it('still sends when the armed line is visible but the banner reset is already past', async () => {
    const past = hhmm(-4 * 60_000);
    const pane = BANNER_ONLY.replace(RESET, past) + `\n  Continuing automatically at ${past} · esc to cancel`;
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });

  it('drives a native-row-only /rate-limit-options menu instead of typing into it', async () => {
    const t = mockTmux([
      `You've hit your session limit · resets ${RESET}`,
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      `  2. Wait here, then continue automatically at ${RESET}`,
      'Enter to confirm · Esc to cancel',
    ].join('\n'));
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    assert.deepEqual(t._keys, ['Down', 'Enter']);
    assert.equal(t._sent.length, 0);
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

// The waiting branch must notice native's stale "Press enter to continue" on EVERY tick,
// not only at expiry. A host that slept >1h past the reset can re-arm us ~24h out (the
// first post-wake capture races Claude Code's redraw and still shows the old armed line,
// whose reset rolls to tomorrow); if the stale route only ran at expiry, the session
// stayed parked for a day. Same gap for a long fallback wait.
describe('processOneTick — mid-wait stale-reset awareness', () => {
  const STALE = [
    '⏺ Migrated the first half of the handlers; the rest are queued.',
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  Your usage limit has reset',
    '  Press enter to continue',
  ].join('\n');
  const IDLE = [
    '⏺ Migrated the first half of the handlers; the rest are queued.',
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
  ].join('\n');
  const farWait = () => {
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + 23 * 3600_000; s.attempts = 0;
    return s;
  };

  it('a stale screen mid-wait routes to the stale nudge on that tick, then Enter is pressed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tmux = mockTmux(STALE);
    const s = farWait();
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'stale-reset-detected');
    assert.equal(s.status, 'stale-reset');
    t.mock.timers.tick(DEFAULT_CONFIG.nativeStaleReset.retryDelaySeconds * 1000 + 1);
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'stale-reset-nudged');
    assert.deepEqual(tmux._keys, ['Enter']);
    assert.equal(tmux._sent.length, 0);
  });

  it('banner gone WITHOUT the stale screen mid-wait keeps waiting (no early user-continued)', async () => {
    const tmux = mockTmux(IDLE);
    const s = farWait();
    const until = s.waitUntil;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.status, 'waiting');
    assert.equal(s.waitUntil, until);
    assert.equal(tmux._sent.length + tmux._keys.length, 0);
  });

  it('banner still present mid-wait keeps waiting unchanged', async () => {
    const tmux = mockTmux(ARMED);
    const s = farWait();
    const until = s.waitUntil;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitUntil, until);
    assert.equal(tmux._sent.length + tmux._keys.length, 0);
  });

  // The mid-wait check sits behind a cheap literal pre-gate (it runs every tick of a
  // multi-hour wait). The gate must be exactly as permissive as staleResetMatch, which
  // is case-insensitive — a case-sensitive includes() would miss "Press Enter".
  it('the pre-gate keeps detection: a capitalised "Press Enter to continue" still routes', async () => {
    const tmux = mockTmux(STALE.replace('Press enter', 'Press Enter'));
    const s = farWait();
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'stale-reset-detected');
  });

  it('nativeStaleReset disabled: a stale screen mid-wait keeps waiting', async () => {
    const tmux = mockTmux(STALE);
    const s = farWait();
    const config = { ...DEFAULT_CONFIG, nativeStaleReset: { ...DEFAULT_CONFIG.nativeStaleReset, enabled: false } };
    assert.equal(await processOneTick(s, tmux, '%0', config, () => true), 'waiting');
  });
});

// A relative hint reads as "future" on every re-read, so it must never drive the re-arm.
it('armed line + relative "try again in N min" banner at expiry → sends, no re-arm', async () => {
  const tmux = mockTmux('  Usage limit reached · try again in 30 minutes\n  Continuing automatically at 3:45pm · esc to cancel');
  const s = createMonitorState();
  s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.attempts = 0;
  assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'retried');
  assert.equal(tmux._sent.length, 1);
});

// The re-arm is bounded. "Armed line visible" and "banner reset still ahead" are not
// independent signals when both lines belong to ONE static episode (a quoted pair, a stuck
// redraw): read more than RESET_GRACE_MS (1h) past its reset, the banner rolls to
// tomorrow, so every expiry re-armed a fresh ~22h wait with attempts = 0 — forever, never
// reaching maxRetries.
describe('processOneTick — the native re-arm is bounded', () => {
  const H = 3600_000;
  const paneAt = (msFromNow) => ARMED.replaceAll(RESET, hhmm(msFromNow));
  const expire = (s) => { s.waitUntil = Date.now() - 1; };

  it('a static armed pair (same reset every read) does NOT re-arm at expiry — the retry is sent', async () => {
    const pane = paneAt(-2 * H);          // reset 2h ago → rolls to tomorrow on every read
    const tmux = mockTmux(pane);
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(s.status, 'waiting');
    expire(s);
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(tmux._sent.length, 1);
    assert.equal(s.attempts, 1, 'the attempt counts toward maxRetries');
  });

  it('a static pair still reaches max-retries instead of looping', async () => {
    const tmux = mockTmux(paneAt(-2 * H));
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    const results = [];
    for (let i = 0; i < DEFAULT_CONFIG.maxRetries + 1; i++) {
      expire(s);
      results.push(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true));
    }
    assert.ok(!results.includes('native-rearmed'), results.join(','));
    assert.equal(results.at(-1), 'max-retries');
  });

  it('a legit chain (the banner reset moved ~5h) still re-arms', async () => {
    const tmux = mockTmux(ARMED);
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    expire(s);
    tmux._pane = paneAt(7 * H);
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-rearmed');
    assert.equal(tmux._sent.length, 0);
  });

  it('caps consecutive re-arms at 3, then falls through to the send', async () => {
    const tmux = mockTmux(ARMED);
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    for (let k = 1; k <= 3; k++) {
      expire(s);
      tmux._pane = paneAt((2 + k) * H);
      assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-rearmed', `re-arm ${k}`);
    }
    expire(s);
    tmux._pane = paneAt(6 * H);
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(tmux._sent.length, 1);
  });

  it('the cap clears on stand-down, so a later genuine episode re-arms again', async () => {
    const tmux = mockTmux(ARMED);
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    for (let k = 1; k <= 3; k++) {
      expire(s);
      tmux._pane = paneAt((2 + k) * H);
      await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    }
    // Native fired and the session resumed: stand down.
    expire(s);
    tmux._pane = `${BANNER_ONLY}\n⏺ Picking the tests back up.\n✻ Cogitating… (esc to interrupt)`;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    // A new limit later in the run, and native chains once more.
    tmux._pane = paneAt(8 * H);
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(s.status, 'waiting');
    expire(s);
    tmux._pane = paneAt(9 * H);
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'native-rearmed');
    assert.equal(tmux._sent.length, 0);
  });
});

// Confirming the menu's native row arms native by construction, but the menu capture
// carries no armed line yet — so the wait used to arm reset + margin with no defer, and a
// parsed menu reset latched _waitIsFallback = false, so no later correction could add it.
describe('processOneTick — a native-row menu confirm defers', () => {
  const menuPane = (rows) => [
    `You've hit your session limit · resets ${RESET}`,
    'What do you want to do?',
    ...rows.map((r, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${r}`),
    'Enter to confirm · Esc to cancel',
  ].join('\n');

  it('native row selected + parsed reset → the wait includes nativeDeferSeconds', async () => {
    const base = await arm(BANNER_ONLY);
    const s = createMonitorState();
    const r = await processOneTick(s, mockTmux(menuPane(['Upgrade your plan', `Wait here, then continue automatically at ${RESET}`])),
      '%0', DEFAULT_CONFIG, () => true);
    assert.equal(r, 'menu-confirmed');
    assert.ok(near(s.waitUntil - Date.now(), base.ms + DEFAULT_CONFIG.nativeDeferSeconds * 1000),
      `got +${Math.round((s.waitUntil - Date.now() - base.ms) / 1000)}s over the plain wait`);
  });

  it('old "Stop and wait" row only → no defer (unchanged)', async () => {
    const base = await arm(BANNER_ONLY);
    const s = createMonitorState();
    await processOneTick(s, mockTmux(menuPane(['Upgrade your plan', 'Stop and wait for limit to reset'])),
      '%0', DEFAULT_CONFIG, () => true);
    assert.ok(near(s.waitUntil - Date.now(), base.ms), 'reset + margin only');
  });

  it('nativeDeferSeconds: 0 → no defer even on the native row', async () => {
    const base = await arm(BANNER_ONLY);
    const s = createMonitorState();
    await processOneTick(s, mockTmux(menuPane(['Upgrade your plan', `Wait here, then continue automatically at ${RESET}`])),
      '%0', { ...DEFAULT_CONFIG, nativeDeferSeconds: 0 }, () => true);
    assert.ok(near(s.waitUntil - Date.now(), base.ms));
  });

  // The menu often renders no reset line: the fallback wait is then corrected from the
  // banner printed after the confirm. The native row was still selected, so that
  // correction carries the defer even when the armed line hasn't rendered yet.
  it('a fallback menu wait corrected from the post-confirm banner keeps the defer', async () => {
    const base = await arm(BANNER_ONLY);
    const tmux = mockTmux([
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      '  2. Wait here, then continue automatically',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));
    const s = createMonitorState();
    await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true);
    assert.equal(s._waitIsFallback, true);
    tmux._pane = BANNER_ONLY;
    s._menuCooldownUntil = 0;
    assert.equal(await processOneTick(s, tmux, '%0', DEFAULT_CONFIG, () => true), 'wait-corrected');
    assert.ok(near(s.waitUntil - Date.now(), base.ms + DEFAULT_CONFIG.nativeDeferSeconds * 1000));
  });
});
