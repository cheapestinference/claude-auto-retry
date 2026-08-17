import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectStreamInterrupted, streamInterruptedMatch } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_STREAM_INTERRUPTED } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

const PATS = DEFAULT_STREAM_INTERRUPTED.patterns;

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
  return { ...DEFAULT_CONFIG, streamInterrupted: { ...DEFAULT_STREAM_INTERRUPTED, ...overrides } };
}

// The real render, captured verbatim from a session whose stream was cut by a laptop
// suspend (tmux pane %111). Note the wrap: "incomplete." lands on its own indented
// continuation line, and the turn ENDS — the prompt returns idle, so nothing resumes
// until something is typed.
const SLEPT = [
  '⏺ API Error: Your computer went to sleep mid-response. The response above may be',
  '  incomplete.',
  '',
  '✻ Cooked for 13m 58s',
  '❯ ',
].join('\n');

describe('detectStreamInterrupted', () => {
  it('matches the suspend render that truncated a response', () =>
    assert.equal(detectStreamInterrupted(SLEPT, PATS), true));

  it('matches the variant where the suspend hit before any output', () =>
    assert.equal(detectStreamInterrupted(
      '⏺ API Error: Your computer went to sleep before a response was produced. Try again.', PATS), true));

  // The same watchdog finalizer emits these for a dropped connection or a stalled
  // stream; the pane is left in the identical truncated-turn state, so the remedy is
  // the same. Sleeping is just the cause we can name.
  it('matches the sibling truncation renders from the same finalizer', () => {
    for (const line of [
      '⏺ API Error: The response stopped arriving. The response above may be incomplete.',
      '⏺ API Error: Connection lost mid-response. The response above may be incomplete.',
      '⏺ API Error: Server error mid-response. The response above may be incomplete.',
      '⏺ API Error: The response stalled before a response was produced. Try again.',
      '⏺ API Error: Connection lost before a response was produced. Try again.',
    ]) assert.equal(detectStreamInterrupted(line, PATS), true, line);
  });

  it('matches when the wrap splits the render head from the phrase', () =>
    assert.equal(detectStreamInterrupted([
      '⏺ API Error: Your computer',
      '  went to sleep mid-response. The response above may be incomplete.',
    ].join('\n'), PATS), true));

  it('is case-insensitive', () =>
    assert.equal(detectStreamInterrupted('● API ERROR: YOUR COMPUTER WENT TO SLEEP MID-RESPONSE.', PATS), true));

  // The discriminator is the SHAPE of the line, not its vocabulary (#73): a real render
  // BEGINS with "API Error:" behind at most a message glyph. Prose that merely quotes the
  // phrase carries the anchor mid-sentence, so an "anchor nearby" rule would fire on a
  // session explaining this very feature — which is how the pane gets a copy of the string
  // without anything being wrong.
  it('does NOT fire on model prose quoting the render mid-sentence', () => {
    assert.equal(detectStreamInterrupted([
      '⏺ The monitor watches for "API Error: Your computer went to sleep mid-response." and',
      '  sends a continue when it sees it.',
    ].join('\n'), PATS), false);
  });

  it('does NOT fire on the phrase typed by the user', () =>
    assert.equal(detectStreamInterrupted(
      '❯ API Error: Your computer went to sleep mid-response. what does that mean?', PATS), false));

  it('does NOT fire without the API Error render head at all', () =>
    assert.equal(detectStreamInterrupted('my computer went to sleep mid-response yesterday', PATS), false));

  it('does NOT fire on the render quoted inside a tool result', () => {
    const pane = [
      '⏺ Bash(grep -n "sleep" pane.txt)',
      '  ⎿ ⏺ API Error: Your computer went to sleep mid-response. The response above may be',
      '       incomplete.',
      '❯ ',
    ].join('\n');
    assert.equal(detectStreamInterrupted(pane, PATS), false);
  });

  it('does NOT fire on the render left far up in scrollback (tail-anchored)', () => {
    const pane = ['⏺ API Error: Your computer went to sleep mid-response.',
      ...Array(15).fill('⏺ unrelated work'), '❯ '].join('\n');
    assert.equal(detectStreamInterrupted(pane, PATS), false);
  });

  it('returns false for empty patterns/text', () => {
    assert.equal(detectStreamInterrupted(SLEPT, []), false);
    assert.equal(detectStreamInterrupted('', PATS), false);
  });

  it('reports the matched pattern + line', () => {
    const m = streamInterruptedMatch(SLEPT, PATS);
    assert.ok(m && /went to sleep mid-response/.test(m.pattern));
    assert.ok(m.line.length <= 200);
  });
});

describe('streamInterrupted config validation', () => {
  async function loadFrom(obj) {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-si-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`);
    await writeFile(f, JSON.stringify(obj));
    try { return await loadConfig(f); } finally { await unlink(f); }
  }
  it('is present on DEFAULT_CONFIG with a small retry cap', () => {
    assert.equal(DEFAULT_CONFIG.streamInterrupted.enabled, true);
    assert.ok(DEFAULT_CONFIG.streamInterrupted.maxRetries <= 3);
    assert.ok(DEFAULT_CONFIG.streamInterrupted.patterns.includes('went to sleep mid-response'));
  });
  it('merges a partial block onto defaults', async () => {
    const c = await loadFrom({ streamInterrupted: { maxRetries: 1 } });
    assert.equal(c.streamInterrupted.maxRetries, 1);
    assert.deepEqual(c.streamInterrupted.patterns, DEFAULT_STREAM_INTERRUPTED.patterns);
  });
  it('falls back on bad values', async () => {
    const c = await loadFrom({ streamInterrupted: { maxRetries: -1, retryDelaySeconds: 0, patterns: [42] } });
    assert.equal(c.streamInterrupted.maxRetries, DEFAULT_STREAM_INTERRUPTED.maxRetries);
    assert.equal(c.streamInterrupted.retryDelaySeconds, DEFAULT_STREAM_INTERRUPTED.retryDelaySeconds);
    assert.deepEqual(c.streamInterrupted.patterns, DEFAULT_STREAM_INTERRUPTED.patterns);
  });
});

const near = (actual, expectedMs) => Math.abs(actual - expectedMs) < 2000;

describe('processOneTick — interrupted-stream path', () => {
  it('enters the wait on detection (no send yet)', async () => {
    const t = mockTmux(SLEPT);
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(r, 'interrupted-detected');
    assert.equal(s.status, 'interrupted');
    assert.equal(t._sent.length, 0);
    assert.ok(near(s.interruptedWaitUntil - Date.now(), DEFAULT_STREAM_INTERRUPTED.retryDelaySeconds * 1000));
  });

  it('sends the resume message once the delay elapses', async () => {
    const t = mockTmux(SLEPT);
    const s = createMonitorState();
    s.status = 'interrupted'; s.interruptedWaitUntil = Date.now() - 1;
    const r = await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(r, 'interrupted-retried');
    assert.equal(t._sent[0], DEFAULT_STREAM_INTERRUPTED.retryMessage);
    assert.equal(s.interruptedAttempts, 1);
  });

  // The wake often brings the network back a beat later than the process, so the resumed
  // turn can fail again. Bounded, like the safeguard family — a machine that keeps
  // suspending must not be typed into forever.
  it('is BOUNDED — gives up after maxRetries instead of looping', async () => {
    const t = mockTmux(SLEPT);
    const s = createMonitorState();
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    await processOneTick(s, t, '%0', c, () => true);
    for (let i = 0; i < 2; i++) { s.interruptedWaitUntil = Date.now() - 1; await processOneTick(s, t, '%0', c, () => true); }
    assert.equal(s.interruptedAttempts, 2);
    assert.equal(t._sent.length, 2);
    s.interruptedWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'interrupted-gave-up');
    assert.equal(t._sent.length, 2);
    assert.equal(s._gaveUp, true);
  });

  it('clears back to monitoring once the error is gone', async () => {
    const t = mockTmux('⏺ Here is the rest of the answer.');
    const s = createMonitorState();
    s.status = 'interrupted'; s.interruptedWaitUntil = Date.now() - 1; s.interruptedAttempts = 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'interrupted-cleared');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.interruptedAttempts, 0);
  });

  it('defers while Claude is working — WITHOUT resetting the attempt counter', async () => {
    const t = mockTmux(SLEPT + '\n✻ Thinking… (esc to interrupt)');
    const s = createMonitorState();
    s.status = 'interrupted'; s.interruptedWaitUntil = Date.now() - 1; s.interruptedAttempts = 2;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'interrupted-working');
    assert.equal(s.interruptedAttempts, 2);
    assert.equal(t._sent.length, 0);
  });

  it('does not enter the path while Claude is working', async () => {
    const t = mockTmux(SLEPT + '\n· Cooking… (esc to interrupt)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
  });

  it('does not send into a non-claude foreground', async () => {
    const t = mockTmux(SLEPT, 'vim', false);
    const s = createMonitorState();
    s.status = 'interrupted'; s.interruptedWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
  });

  it('usage-limit takes precedence over a co-present truncation render', async () => {
    const t = mockTmux(SLEPT + "\nYou've hit your session limit · resets 3pm (UTC)");
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'waiting');
    assert.equal(s.status, 'waiting');
  });

  it('does not inject into a healthy session discussing the error at an idle prompt', async () => {
    const t = mockTmux([
      '⏺ That "API Error: Your computer went to sleep mid-response" message comes from the',
      '  byte watchdog when the stream is cut by a suspend.',
      '',
      '❯ ',
    ].join('\n'));
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  it('disabled block is ignored', async () => {
    const t = mockTmux(SLEPT);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg({ enabled: false }), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
});
