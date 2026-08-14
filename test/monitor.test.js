import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { calculateWaitMs } from '../src/time-parser.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    _keys: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}

const MENU_UPGRADE_FIRST = [
  "You've hit your session limit · resets 6:50pm (Europe/London)",
  'What do you want to do?',
  '❯ 1. Upgrade your plan',
  '  2. Stop and wait for limit to reset',
  'Enter to confirm · Esc to cancel',
].join('\n');

const MENU_WAIT_FIRST = [
  "You've hit your session limit · resets 12:10am (Europe/Dublin)",
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Upgrade your plan',
  'Enter to confirm · Esc to cancel',
].join('\n');

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

  it('navigates the menu down to "Stop and wait" when "Upgrade" is the default (#19)', async () => {
    const t = mockTmux(MENU_UPGRADE_FIRST);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    // One Down to move off "Upgrade", then Enter to confirm "Stop and wait".
    assert.deepEqual(t._keys, ['Down', 'Enter']);
    assert.equal(t._sent.length, 0);            // never typed a stray message
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });

  it('confirms directly when "Stop and wait" is already highlighted (#19)', async () => {
    const t = mockTmux(MENU_WAIT_FIRST);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    assert.deepEqual(t._keys, ['Enter']);       // no navigation needed
    assert.equal(s.status, 'waiting');
  });

  it('does not drive the menu when Claude is not in the foreground (#19 safety)', async () => {
    // Menu is up, but some other app (vim) is focused and the process isn't fg.
    const t = mockTmux(MENU_UPGRADE_FIRST, 'vim', false);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._keys.length, 0);   // pressed no menu keys
    assert.notEqual(s.status, 'waiting');
  });

  // --- Regression: a menu only quoted in scrollback is NOT the live prompt. Driving
  //     arrow keys + Enter on it would act on whatever is actually on screen. ---
  it('does NOT drive a /rate-limit-options menu only quoted above the live tail', async () => {
    const pane = [...MENU_UPGRADE_FIRST.split('\n'), ...Array(12).fill('● unrelated work below the quoted menu'), '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
    assert.notEqual(r, 'menu-confirmed');
    assert.equal(t._keys.length, 0);   // no arrow/Enter keys driven
  });

  it('refuses to press Enter when the menu layout is unreadable (#19)', async () => {
    // Cursor marker absent → we cannot tell which option is highlighted.
    const noCursor = ['What do you want to do?', '  1. Upgrade your plan', '  2. Stop and wait for limit to reset', 'Enter to confirm'].join('\n');
    const t = mockTmux(noCursor);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-unreadable');
    assert.equal(t._keys.length, 0);            // pressed nothing
    assert.equal(t._sent.length, 0);
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
    // Should stay in 'waiting' with a cooldown to let Claude process
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('detects multi-line TUI rate limit', async () => {
    const t = mockTmux('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });

  // --- Regression (#71): a wait computed from a screen with no parseable reset time (the
  //     /rate-limit-options menu) lands on the fallbackWaitHours default and used to stand
  //     for its full duration, because the waiting branch returned early and never looked
  //     at the pane again. See the CHANGELOG entry for the observed incident. ---

  // Deterministic clock. Banners are rendered in the fixed-offset zone where the current
  // instant reads as ~midday and carry that zone explicitly, so a relative offset can never
  // cross a date boundary (a host at 00:15 rendered YESTERDAY's "11:45pm", which parses
  // ~23.5h into the future and made these tests red for that half-hour) and no DST
  // transition can move the answer. Etc/GMT zones have no DST; note the POSIX sign
  // inversion — Etc/GMT+6 is UTC-6.
  function middayZone(now = new Date()) {
    const shift = 12 - now.getUTCHours();       // hours to add to UTC to land near 12:00
    if (shift === 0) return 'UTC';
    return shift > 0 ? `Etc/GMT-${shift}` : `Etc/GMT+${-shift}`;
  }
  function bannerAt(msFromNow, zone = middayZone()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(Date.now() + msFromNow));
    const h = Number(parts.find(p => p.type === 'hour').value);
    const m = parts.find(p => p.type === 'minute').value;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `You've hit your session limit · resets ${h12}:${m}${h >= 12 ? 'pm' : 'am'} (${zone})`;
  }
  // The real fallback, from the real code path — not a hand-copy of the formula.
  const FALLBACK_MS = calculateWaitMs(null, DEFAULT_CONFIG.marginSeconds, DEFAULT_CONFIG.fallbackWaitHours);
  const MENU_NO_RESET = [
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const marginish = () => Date.now() + (DEFAULT_CONFIG.marginSeconds + 5) * 1000;

  it('menu with no reset line commits the fallback and latches it as correctable', async () => {
    const t = mockTmux(MENU_NO_RESET);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    assert.equal(s._waitIsFallback, true);
    assert.ok(Math.abs((s.waitUntil - Date.now()) - FALLBACK_MS) < 5000,
      `expected the fallback, got ${Math.round((s.waitUntil - Date.now()) / 1000)}s`);
  });

  it('shortens the menu fallback once the post-confirm banner appears', async () => {
    const t = mockTmux(MENU_NO_RESET);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    // Claude Code prints the banner carrying the real time; reset was ~30 min ago.
    t.capturePane = async () => bannerAt(-30 * 60_000);
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'wait-corrected');
    assert.equal(t._sent.length, 0);              // corrects the clock, does not send yet
    assert.ok(s.waitUntil <= marginish(),
      `expected a margin-sized wait, got ${Math.round((s.waitUntil - Date.now()) / 1000)}s`);
    assert.equal(s._waitIsFallback, false);       // no longer a fallback → no re-parsing
  });

  it('corrects the menu fallback even after a retry has already been sent', async () => {
    // The menu re-rendering means the session hit the limit again: a fresh episode. Keying
    // the correction on the raw attempt counter blocked exactly this flow, so the
    // post-confirm banner one minute away was ignored for the whole 5h fallback.
    const t = mockTmux(MENU_NO_RESET);
    const s = createMonitorState();
    s.status = 'waiting'; s.attempts = 1; s.waitUntil = Date.now() - 1000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    assert.equal(s.attempts, 0);                  // fresh episode
    assert.equal(s._gaveUp, false);
    t.capturePane = async () => bannerAt(-30 * 60_000);
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'wait-corrected');
    assert.ok(s.waitUntil <= marginish());
  });

  it('a maxed-out episode still gives up rather than looping on the same banner', async () => {
    const t = mockTmux(bannerAt(-30 * 60_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.attempts = DEFAULT_CONFIG.maxRetries; s.waitUntil = Date.now() - 1;
    s._waitIsFallback = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
    assert.equal(t._sent.length, 0);
    assert.equal(s._gaveUp, true);
    // The give-up backoff is not reset-derived; the correction must not shorten it.
    const hold = s.waitUntil;
    assert.equal(s._waitIsFallback, false);
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitUntil, hold);
  });

  // --- #73 at the level the bug actually hurt: the wait itself. Reset-shaped prose below
  //     a live banner used to win the parse, committing ~3min instead of ~5h — the monitor
  //     then woke into the still-live limit and burned maxRetries before the real reset. ---
  for (const [label, prose] of [
    ['model prose', '⏺ The API said to try again in 2 minutes before the limit window rolls'],
    ['user-typed text', '❯ it told me to try again in 2 minutes, is that right?'],
  ]) {
    it(`derives the wait from the banner, not ${label} below it (#73)`, async () => {
      const t = mockTmux([bannerAt(5 * 3600_000), '', prose].join('\n'));
      const s = createMonitorState();
      assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
      const secs = (s.waitUntil - Date.now()) / 1000;
      assert.ok(secs > 4 * 3600, `expected ~5h from the banner, got ${Math.round(secs)}s`);
      // Parsed from a real reset time, so #70's latch correctly marks it non-correctable.
      assert.equal(s._waitIsFallback, false);
      assert.equal(t._sent.length, 0);
    });
  }

  it('never re-parses a wait that came from a real reset time', async () => {
    // Regression for the window/latch pair: reset-shaped prose ("try again in 2 minutes")
    // drifting into the pane during a correctly-derived multi-hour wait must not collapse
    // it — the monitor would wake into the still-live limit and burn its retries early.
    const t = mockTmux(bannerAt(5 * 3600_000));
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s._waitIsFallback, false);
    const derived = s.waitUntil;
    assert.ok((derived - Date.now()) / 1000 > 4 * 3600,
      `expected ~5h, got ${Math.round((derived - Date.now()) / 1000)}s`);
    t.capturePane = async () => [
      bannerAt(5 * 3600_000),
      '',
      '⏺ The API said to try again in 2 minutes before the limit window rolls',
    ].join('\n');
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitUntil, derived);           // untouched
    assert.equal(t._sent.length, 0);
  });

  it('shortens to a still-future reset without sending', async () => {
    const t = mockTmux(bannerAt(2 * 3600_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + FALLBACK_MS; s._waitIsFallback = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'wait-corrected');
    assert.equal(t._sent.length, 0);
    const secs = (s.waitUntil - Date.now()) / 1000;
    assert.ok(secs > 3600 && secs < 3 * 3600, `expected ~2h, got ${Math.round(secs)}s`);
  });

  it('never LENGTHENS the wait from the banner', async () => {
    const t = mockTmux(bannerAt(2 * 3600_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + 30 * 60_000; s._waitIsFallback = true;
    const before = s.waitUntil;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitUntil, before);
  });

  it('does not correct the post-send cooldown', async () => {
    // After a send, waitUntil is the 30s cooldown; re-deriving it from an already-passed
    // reset would collapse it to the margin and burn every attempt in a few ticks.
    const t = mockTmux(bannerAt(-30 * 60_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s._waitIsFallback = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s.attempts, 1);
    assert.equal(s._waitIsFallback, false);
    const cooldown = s.waitUntil;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitUntil, cooldown);
    assert.equal(t._sent.length, 1);
  });

  it('sends immediately when the corrected wait has already elapsed', async () => {
    const cfg = { ...DEFAULT_CONFIG, marginSeconds: 0 };
    const t = mockTmux(bannerAt(-30 * 60_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + FALLBACK_MS; s._waitIsFallback = true;
    assert.equal(await processOneTick(s, t, '%0', cfg, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });

  it('a corrected wait that falls through does not log as a fresh detection', async () => {
    // correctUsageWait used to stash the banner on state regardless of which branch won;
    // a tick that fell through to 'retried' left it there for the next 'waiting' tick to
    // report as a brand-new rate limit. Set-with-clear is the invariant.
    const cfg = { ...DEFAULT_CONFIG, marginSeconds: 0 };
    const t = mockTmux(bannerAt(-30 * 60_000));
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + FALLBACK_MS; s._waitIsFallback = true;
    assert.equal(await processOneTick(s, t, '%0', cfg, () => true), 'retried');
    assert.equal(s.lastRateLimitMessage, null);
  });

  // --- Regression: do not spam an already-resumed session. The usage path used to
  //     re-send every poll (up to maxRetries) while the limit banner lingered in
  //     scrollback after a successful resume — observed live as 5 injections into a
  //     working session. The isWorking gate stops the moment Claude resumes. ---
  it('does NOT re-send once Claude has resumed and is working', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Doing… (esc to interrupt)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);          // never injects into the working session
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
  });

  // --- Regression (#39): while the wait timer is still counting down, a session that
  //     has resumed working (the user manually typed "continue" to unstick a wrong/stale
  //     wait) must drop back to monitoring immediately — otherwise the monitor is parked
  //     blind on the old timer and never detects a SECOND, genuine limit that follows. ---
  it('drops out of the wait as soon as Claude resumes working, before the timer expires (#39)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Doing… (esc to interrupt)');
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + 60 * 60 * 1000; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
    assert.equal(t._sent.length, 0);
  });

  // --- Regression (Finding 3): isWorking and isRateLimited must measure the same bottom.
  //     A live "esc to interrupt" footer pushed up by a chrome stack was invisible to the
  //     raw-tail isWorking while chrome-aware isRateLimited still saw a lingering banner →
  //     retry text into a mid-flight session. Both are chrome-aware now. ---
  it('does NOT re-send when Claude is working above a chrome stack (banner still lingering)', async () => {
    const pane = [
      "You've hit your session limit · resets 3pm (UTC)",
      '✻ Cogitating… (12s · esc to interrupt)',
      '  10 tasks (2 done, 1 in progress, 7 open)',
      '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g',
      '   … +2 completed', '  new task? /clear to save 300k tokens', '',
      '───────────────', '❯ ', '───────────────',
      '  Opus 4.8 | repo@dev | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');   // working footer sits >12 raw lines above the bottom
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);
    assert.equal(s.status, 'monitoring');
  });

  // --- Background-agent activity: a session awaiting a subagent is progressing; a stale
  //     banner above it must not drive an INJECTION. The waiting-branch `|| isWorking` gate
  //     handles that (returns user-continued, sends nothing). ---
  it('does NOT inject into a session running a background agent (waiting branch gate)', async () => {
    const pane = [
      "You've hit your session limit · resets 3pm (Europe/Zurich)", '',
      '● gsd:gsd-executor(Execute plan 24.1-10)', '',
      '✻ Waiting for 1 background agent to finish', '',
      '───────────────', '❯ ', '───────────────', '  Fable 5 | repo@dev | 5h 9% @20:00 | v2.1.202',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);
  });

  // --- Regression (#38): a limit banner pushed far up by a tall chrome block (a big task
  //     widget + footer, ~90 lines) must still be captured. The detector chrome-strips the
  //     tail, but only within the CAPTURED buffer — so the capture window has to reach past
  //     the widget. Uses a capture mock that honours the requested line count, like real
  //     `tmux capture-pane -S -N` (the shared mockTmux ignores it). ---
  it('detects a limit banner behind a ~90-line chrome block (capture window)', async () => {
    const chrome = [
      ...Array.from({ length: 88 }, (_, i) => `  □ task item ${i}`),
      '   … +2 completed', '  ? for shortcuts', '  Opus 4.8 | repo@dev | v2.1.201',
    ];
    const full = ["You've hit your session limit · resets 4:40pm (UTC)", ...chrome].join('\n');
    const t = {
      _sent: [],
      capturePane: async (_p, n) => full.split('\n').slice(-n).join('\n'), // honours N
      getPaneCommand: async () => 'node',
      sendKeys: async (_p, x) => t._sent.push(x),
      isClaudeForeground: async () => true,
    };
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
  });

  // --- Regression (Fable review F1): a transcript line matching a working pattern
  //     (`Retrying in …`/`attempt N/M` in a flaky deploy/test log) must NOT permanently
  //     suppress detection. The monitoring path has no !isWorking gate, so a genuine live
  //     limit is still detected even with such prose in the tail. ---
  it('still detects a live limit when a "Retrying in / attempt" transcript line is in the tail', async () => {
    const pane = [
      '  ⎿  deploying… Retrying in 5s (attempt 2/3)...',
      '  ⎿  deploy failed after 3 attempts',
      "You've hit your session limit · resets 3pm (UTC)", '❯ ',
    ].join('\n');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, mockTmux(pane), '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.status, 'waiting');   // NOT suppressed by the transcript over-match
  });
  // --- F1 follow-up: detection surviving the transcript over-match is not enough — the
  //     WAITING branch's isWorking gate flipped the same pane to 'user-continued' at every
  //     expiry tick, churning waiting↔user-continued forever with zero sends. "Resumed"
  //     must mean working signal BELOW the last banner line; work above it is history. ---
  const F1_PANE = [
    '  ⎿  deploying… Retrying in 5s (attempt 2/3)...',
    '  ⎿  deploy failed after 3 attempts',
    "You've hit your session limit · resets 3pm (UTC)", '❯ ',
  ].join('\n');
  it('F1 pane at wait expiry: the stale transcript must not suppress the retry send', async () => {
    const t = mockTmux(F1_PANE);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('F1 pane mid-wait keeps counting down (not flipped to user-continued)', async () => {
    const t = mockTmux(F1_PANE);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() + 60_000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(t._sent.length, 0);
  });
  it('LIVE work below the banner still reads as user-continued (no injection)', async () => {
    const pane = [
      "You've hit your session limit · resets 3pm (UTC)",
      '● Continuing with the refactor…',
      '✻ Thinking… (esc to interrupt)',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(t._sent.length, 0);
  });

  // Counter-repro: a genuinely limited, IDLE session whose scrollback contains a finished
  // agent's "Backgrounded agent" transcript line MUST still be retried — the transcript
  // notice is not working state.
  it('still retries a limited idle session with a finished-agent transcript in scrollback', async () => {
    const pane = [
      '● Task(build the parser)', '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
      '● Done. The parser passes all 14 tests.',
      "You've hit your session limit · resets 3pm (UTC)", '❯ ',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);   // NOT suppressed — the transcript line isn't "working"
  });

  // --- Regression: self-referential false positive. A limit banner only quoted in
  //     scrollback (a conversation discussing limits, a stale banner scrolled past) is
  //     NOT the live state. Tail-anchoring stops it from driving a retry. ---
  it('does NOT enter a wait for a limit banner buried above the live tail', async () => {
    const pane = ['You hit your session limit · resets 3pm (UTC)', ...Array(15).fill('● working on unrelated code'), '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('still enters a wait when the limit banner is in the live tail', async () => {
    const pane = ['earlier output', 'more output', "You've hit your session limit · resets 3pm (UTC)"].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
  });

  // --- Regression (Finding 1): the /usage-credits backstop must not resurrect the
  //     scrollback false positive. A resumed session shows the stale banner+companion
  //     with real work rendered below it — that is NOT the live limit state and must not
  //     drive a retry (previously: up to maxRetries injections + a ~24h wait to tomorrow). ---
  it('does NOT enter a wait via the /usage-credits backstop when real work is below it', async () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      ...Array(15).fill('● wrote some code after resuming'),
      '❯ ',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  // --- #71: the spend-limit banner carries no reset time, so the wait it produces must be
  //     the bounded fallback AND stay latched correctable — if the 5h block resets
  //     underneath and a real "resets <time>" banner appears, the mid-wait correction
  //     shortens to the true instant; genuine budget exhaustion ends in the normal
  //     max-retries give-up rather than an unbounded loop. ---
  it('enters the bounded fallback wait on the spend-limit banner, latched for correction (#71)', async () => {
    const SPEND_ORG = "You've hit your org's monthly spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage";
    const pane = [SPEND_ORG, `  ⎿  ${SPEND_ORG}`,
      "     /usage-credits to finish what you're working on.", '', '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    const expected = DEFAULT_CONFIG.fallbackWaitHours * 3600_000;
    const delta = s.waitUntil - Date.now();
    assert.ok(Math.abs(delta - expected) < 120_000, `wait ${delta}ms not ≈ fallback ${expected}ms`);
    assert.equal(s._waitIsFallback, true);
  });

  // --- Regression: a LIVE limit banner pushed far up the pane by UI chrome (a tall task
  //     widget + input box + footer) must still be detected. Observed live: a session-limit
  //     banner ~16 lines up behind a task list went unretried for ~54 min because the fixed
  //     12-line tail never reached it. Chrome-aware tail strips trailing furniture first. ---
  it('detects a live limit banner buried behind a task widget + input box + footer', async () => {
    const pane = [
      '● Agent "Map LI drop-point" finished · 1m 5s',
      "  └ You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      '',
      '✻ Brewed for 54m 35s',
      '',
      '  8 tasks (4 done, 1 in progress, 3 open)',
      '  ◼ FU-4(b): build + run per-order re-drive over remnant',
      '  □ FU-4(a): cache OD inventory map per country',
      '  □ FU-1: analyze tax-free/reverse-charge COGS netting',
      '  □ FU-2: LI routing gap fix',
      '  ✓ Restore sqlrun webhook for DB queries',
      '   … +3 completed',
      '                              new task? /clear to save 468.1k tokens',
      '',
      '───────────────────────────────',
      '❯ ',
      '───────────────────────────────',
      '  Opus 4.8 1M | automation-monorepo@dev | 5h 100% @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.status, 'waiting');
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
    // Flagged so external consumers (tmux status bar) don't render a perpetually
    // resetting countdown for a monitor that will not send further retries.
    assert.equal(s._gaveUp, true);
  });
  it('resets from max-retries when rate limit clears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 10; s._gaveUp = true;
    // Rate limit cleared → should detect user-continued before max-retries check
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
    assert.equal(s._gaveUp, false);
  });
});
