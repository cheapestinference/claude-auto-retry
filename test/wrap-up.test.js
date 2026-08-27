import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nearLimitWrapUpMatch } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_NEAR_LIMIT_WRAP_UP } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}
function cfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, nearLimitWrapUp: { ...DEFAULT_NEAR_LIMIT_WRAP_UP, ...overrides } };
}

// The render (#78). At ~95% of the 5-hour window Claude Code injects a checkpoint
// instruction into the model's context ("finish the current step, then list up to 3 short
// bullets of the most impactful remaining work") and prints this notice. The model finishes
// the step, lists the bullets and ENDS THE TURN — no limit banner, the prompt returns idle,
// and nothing resumes the session until the window has long since reset.
const NOTICE = '⏺ Approaching your 5-hour usage limit — Claude will wrap up the current step.';
const WRAPPED = [
  NOTICE,
  '',
  '⏺ Done — the migration runs clean. Remaining work, most impactful first:',
  '  - wire the retry into the CLI',
  '  - add the integration test',
  '  - update the README',
  '',
  '❯ ',
].join('\n');

describe('nearLimitWrapUpMatch', () => {
  it('matches the notice with the wrap-up output below it and an idle prompt', () => {
    assert.ok(nearLimitWrapUpMatch(WRAPPED));
  });
  it('matches a weekly-limit variant of the notice', () => {
    assert.ok(nearLimitWrapUpMatch('⏺ Approaching your weekly limit — Claude will wrap up the current step.\n\n❯ '));
  });
  // Our own nudge renders as a user row under the notice, as does anything the user typed:
  // once a user row sits below it, the notice belongs to a turn that has already been
  // answered. That row is the dedup — one nudge per notice, by construction.
  it('does NOT match once a user row is rendered below the notice', () => {
    const nudged = [WRAPPED.replace('\n❯ ', ''), '', '> continue', '', '⏺ Wiring the retry into the CLI now.', '', '❯ '].join('\n');
    assert.equal(nearLimitWrapUpMatch(nudged), null);
  });
  it('does NOT match the notice quoted mid-line in prose', () => {
    assert.equal(nearLimitWrapUpMatch('⏺ Earlier the TUI said "Approaching your 5-hour usage limit — Claude will wrap up the current step." and stopped.\n\n❯ '), null);
  });
  it('does NOT match the notice typed on the user\'s own input row', () => {
    assert.equal(nearLimitWrapUpMatch('❯ Approaching your 5-hour usage limit — Claude will wrap up the current step.\n❯ '), null);
  });
  it('does NOT match the notice echoed inside a tool result', () => {
    assert.equal(nearLimitWrapUpMatch('● Bash(grep "wrap up" session.log)\n  ⎿  ⏺ Approaching your 5-hour usage limit — Claude will wrap up the current step.\n\n❯ '), null);
  });
  it('is bounded: a notice buried behind more output than the window holds is scrollback', () => {
    const buried = [NOTICE, ...Array(60).fill('● a long wrap-up of the current step'), '❯ '].join('\n');
    assert.equal(nearLimitWrapUpMatch(buried), null);
  });
});

describe('processOneTick — near-limit wrap-up nudge', () => {
  it('sends the nudge once at the idle prompt after a wrap-up', async () => {
    const t = mockTmux(WRAPPED);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'wrap-up-nudged');
    assert.deepEqual(t._sent, ['continue']);
    assert.equal(s.status, 'monitoring');
  });
  it('does not nudge again while the pane has not yet re-rendered (post-send hold)', async () => {
    const t = mockTmux(WRAPPED);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'wrap-up-holding');
    assert.equal(t._sent.length, 1);
  });
  it('does nothing once the nudge has rendered as a user row below the notice', async () => {
    const pane = [WRAPPED.replace('\n❯ ', ''), '', '> continue', '', '⏺ Wiring the retry now.', '', '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('does not nudge while Claude is still working', async () => {
    const t = mockTmux([NOTICE, '', '✻ Cooking… (esc to interrupt)'].join('\n'));
    const s = createMonitorState();
    assert.notEqual(await processOneTick(s, t, '%0', cfg(), () => true), 'wrap-up-nudged');
    assert.equal(t._sent.length, 0);
  });
  it('a usage-limit banner takes precedence: enters the wait, sends no nudge', async () => {
    const pane = [NOTICE, '', "You've hit your session limit · resets 3pm (UTC)", '', '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'waiting');
    assert.equal(t._sent.length, 0);
  });
  it('does not send when Claude is not in the foreground', async () => {
    const t = mockTmux(WRAPPED, 'vim', false);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
  });
  it('can be disabled', async () => {
    const t = mockTmux(WRAPPED);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg({ enabled: false }), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('uses the configured nudge message', async () => {
    const t = mockTmux(WRAPPED);
    const s = createMonitorState();
    await processOneTick(s, t, '%0', cfg({ retryMessage: 'keep going' }), () => true);
    assert.deepEqual(t._sent, ['keep going']);
  });
});

describe('config: nearLimitWrapUp block', () => {
  it('defaults are enabled with "continue"', () => {
    assert.equal(DEFAULT_CONFIG.nearLimitWrapUp.enabled, true);
    assert.equal(DEFAULT_CONFIG.nearLimitWrapUp.retryMessage, 'continue');
  });
  it('validation falls back field-by-field on a malformed block', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'car-wrapup-'));
    const path = join(dir, 'cfg.json');
    await writeFile(path, JSON.stringify({ nearLimitWrapUp: { enabled: 'yes', retryMessage: '' } }));
    const c = await loadConfig(path);
    assert.equal(c.nearLimitWrapUp.enabled, true);
    assert.equal(c.nearLimitWrapUp.retryMessage, 'continue');
    await rm(dir, { recursive: true, force: true });
  });
});
