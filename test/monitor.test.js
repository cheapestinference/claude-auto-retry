import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

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
  //     banner above it must not drive retries. The monitoring tick doesn't even enter a
  //     wait (no re-detection cycle), and a waiting tick returns user-continued. ---
  it('does NOT enter a wait on a stale banner while a background agent runs (monitoring)', async () => {
    const pane = [
      "You've hit your session limit · resets 3pm (Europe/Zurich)", '',
      '● gsd:gsd-executor(Execute plan 24.1-10)', '',
      '✻ Waiting for 1 background agent to finish', '',
      '───────────────', '❯ ', '───────────────', '  Fable 5 | repo@dev | 5h 9% @20:00 | v2.1.202',
    ].join('\n');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, mockTmux(pane), '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(s.status, 'monitoring');
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
