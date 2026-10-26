import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimited, findRateLimitMessage, isRateLimitOptionsPrompt, detectOverload, detectSafeguard,
  detectStreamInterrupted, nearLimitWrapUpMatch, staleResetMatch, nativeWaitArmed,
} from '../src/patterns.js';
import { parseResetTime } from '../src/time-parser.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

// Non-firing pins for native auto-continue's own after-the-fact renders (Claude Code
// v2.1.234+; strings verbatim from the v2.1.310 binary). Each one is a conversation line
// recording what native did — cancelled, continued, gave up. None is a live limit, an
// error or a parked session this tool should act on, and none fired before native support
// landed (verified); these pins keep it that way as the native-aware detectors grow.
const TAIL = 12;  // monitor.js RATE_LIMIT_TAIL_LINES

const pane = (...convo) => [
  '⏺ Migrated the first half of the handlers; the rest are queued in the todo list.',
  '',
  ...convo,
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on',
].join('\n');

const CANCEL_EXITED = pane('⏺ Automatic continue cancelled · Claude Code exited during the wait, so the task will '
  + 'not resume on its own when the usage limit resets (send a prompt after the reset to continue)');
const CANCEL_REARM = pane('⏺ Automatic continue cancelled · /rate-limit-options to re-arm');
const CONTINUED = pane('⏺ Usage limit reset · continuing automatically');
const GAVE_UP_LINE = '⏺ Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again';
const GAVE_UP = pane(GAVE_UP_LINE);

function mockTmux(paneContent) {
  const t = {
    _sent: [], _keys: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => true,
  };
  return t;
}

async function tick(text) {
  const s = createMonitorState();
  const t = mockTmux(text);
  const result = await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true);
  return { result, s, t };
}

function assertNoDetection(text) {
  const c = DEFAULT_CONFIG;
  assert.equal(isRateLimited(text, c.customPatterns, TAIL), false, 'isRateLimited');
  assert.equal(isRateLimitOptionsPrompt(text, TAIL), false, 'menu');
  assert.equal(detectOverload(text, c.overload.patterns), false, 'overload');
  assert.equal(detectSafeguard(text, c.safeguard.patterns), false, 'safeguard');
  assert.equal(detectStreamInterrupted(text, c.streamInterrupted.patterns), false, 'stream-interrupted');
  assert.equal(nearLimitWrapUpMatch(text), null, 'wrap-up');
  assert.equal(staleResetMatch(text), null, 'stale reset');
  assert.equal(nativeWaitArmed(text, TAIL), null, 'native armed/firing');
}

describe('native auto-continue renders that must NOT trigger anything', () => {
  for (const [name, text] of [
    ['cancelled · Claude Code exited during the wait', CANCEL_EXITED],
    ['cancelled · /rate-limit-options to re-arm', CANCEL_REARM],
    ['usage limit reset · continuing automatically', CONTINUED],
    ['stopped after repeated usage-limit hits (alone)', GAVE_UP],
  ]) {
    it(`${name}: no detector fires`, () => assertNoDetection(text));
    it(`${name}: the monitor just keeps monitoring (no keys sent)`, async () => {
      const { result, t } = await tick(text);
      assert.equal(result, 'monitoring');
      assert.deepEqual(t._sent, []);
      assert.deepEqual(t._keys, []);
    });
  }
});

describe('native give-up line with a fresh limit banner below it', () => {
  // After the give-up, the next limit hit renders a fresh banner as status chrome. The
  // give-up line must not mask it: the usage wait arms off the banner as usual.
  const text = [
    '⏺ Migrated the first half of the handlers.',
    '',
    GAVE_UP_LINE,
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  Usage limit reached · limit resets 9pm',
  ].join('\n');

  it('isRateLimited is true and the reset parses as 9pm', () => {
    assert.equal(isRateLimited(text, DEFAULT_CONFIG.customPatterns, TAIL), true);
    const parsed = parseResetTime(findRateLimitMessage(text, DEFAULT_CONFIG.customPatterns, TAIL));
    assert.equal(parsed.hour, 21);
    assert.equal(parsed.minute, 0);
  });

  it('the monitor arms the usage wait (no keys sent)', async () => {
    const { result, s, t } = await tick(text);
    assert.equal(result, 'waiting');
    assert.equal(s.status, 'waiting');
    assert.deepEqual(t._sent, []);
    assert.deepEqual(t._keys, []);
  });
});
