import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverload, overloadMatch, isWorking } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_OVERLOAD } from '../src/config.js';
import {
  createMonitorState, processOneTick,
  overloadBaseWaitMs, applyJitter, nextOverloadWaitMs,
} from '../src/monitor.js';

const PATS = DEFAULT_OVERLOAD.patterns;

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true, event = null) {
  const t = {
    _sent: [], _event: event, _cleared: false,
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    isClaudeForeground: async () => claudeForeground,
    readEvent: async () => t._event,
    clearEvent: async () => { t._event = null; t._cleared = true; },
  };
  return t;
}

// Deterministic config: zero jitter so scheduled waits are exact.
function cfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, overload: { ...DEFAULT_OVERLOAD, jitterPct: 0, ...overrides } };
}

const NO_JITTER = () => 0.5; // factor = 1 + (0.5*2-1)*pct = 1 (no shift)

describe('detectOverload', () => {
  it('matches "API Error: 529"', () => assert.equal(detectOverload('API Error: 529 Overloaded', PATS), true));
  it('matches "API Error: 500 Internal server error"', () => assert.equal(detectOverload('API Error: 500 Internal server error', PATS), true));
  it('matches "API Error: 503 no healthy upstream" (plain-text edge body)', () => assert.equal(detectOverload('API Error: 503 no healthy upstream', PATS), true));
  it('matches "API Error: 502"', () => assert.equal(detectOverload('API Error: 502 Bad Gateway', PATS), true));
  it('matches "API Error: 504"', () => assert.equal(detectOverload('API Error: 504 Gateway Timeout', PATS), true));
  it('matches the overloaded_error JSON type', () => assert.equal(detectOverload('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', PATS), true));
  it('matches the dedicated API-429 render (no 3-digit code in the slot)', () => assert.equal(detectOverload('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', PATS), true));
  it('tolerates missing space after the colon', () => assert.equal(detectOverload('API Error:529', PATS), true));
  it('is case-insensitive', () => assert.equal(detectOverload('api error: 529 OVERLOADED', PATS), true));
  it('detects through ANSI codes', () => assert.equal(detectOverload('\x1b[31mAPI Error: 529\x1b[0m \x1b[1mOverloaded\x1b[0m', PATS), true));
  it('returns false for normal output', () => assert.equal(detectOverload('Here is the code you asked for', PATS), false));
  it('returns false for empty patterns', () => assert.equal(detectOverload('API Error: 529', []), false));
  it('returns false for empty text', () => assert.equal(detectOverload('', PATS), false));

  // --- Regression: the exact false positives that injected "Continue where you left
  //     off." into live sessions. None of these are a terminal API error. ---
  it('does NOT match a bare status number ("got a 529 back")', () => assert.equal(detectOverload('got a 529 back', PATS), false));
  it('does NOT match Express code under edit (res.status(503))', () => assert.equal(detectOverload('      res.status(503).json({ status: "degraded", db: "down" });', PATS), false));
  it('does NOT match a Dockerfile HEALTHCHECK with 503/500 in a comment', () => assert.equal(detectOverload('# 500 Internal server error / 503 ... liveness check (200 even if DB down)', PATS), false));
  it('does NOT match a "status.claude.com" mention in prose/comments', () => assert.equal(detectOverload('see status.claude.com for incidents', PATS), false));
  it('does NOT match a bare "500 Internal server error" without the API Error frame', () => assert.equal(detectOverload('500 Internal server error · try again', PATS), false));

  // --- Self-referential: the phrase patterns must not fire when merely quoted/discussed in
  //     the pane (a session explaining this tool, or a chat about API errors). The real
  //     render always carries an `API Error` line, like the safeguard path requires.
  //     (Observed live: the tool's own diagnostic text matched /temporarily limiting requests/.) ---
  it('does NOT match "temporarily limiting requests" in prose (no API Error nearby)', () => {
    assert.equal(detectOverload('the "temporarily limiting requests" pattern is a built-in overload signal', PATS), false);
  });
  it('does NOT match a quoted "overloaded_error" in prose (no API Error nearby)', () => {
    assert.equal(detectOverload('the overloaded_error JSON type is what we anchor on', PATS), false);
  });
  it('still matches the real API-429 render (API Error on the line)', () => {
    assert.equal(detectOverload('● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', PATS), true);
  });
  it('still matches a multi-line overloaded_error body (API Error one line up)', () => {
    assert.equal(detectOverload('API Error: 529\n{"type":"error","error":{"type":"overloaded_error"}}', PATS), true);
  });

  // --- Terminal vs transient: the parens form means Claude is STILL retrying. Acting
  //     on it would interrupt Claude's own backoff. Only the colon form is terminal. ---
  it('does NOT match the transient parens retry form', () => assert.equal(detectOverload('API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10', PATS), false));

  // --- Tail-anchoring: an error that has scrolled up out of the live tail is no
  //     longer terminal (clean tail, an old status code sitting up in scrollback). ---
  it('does NOT match an API error buried above the 12-line tail', () => {
    const pane = ['API Error: 529 Overloaded', ...Array(15).fill('● Deleted workflow TEMP_fx_verify'), 'done.'].join('\n');
    assert.equal(detectOverload(pane, PATS), false);
  });
  it('matches an API error sitting in the live tail', () => {
    const pane = ['some earlier output', 'more output', 'API Error: 529 Overloaded'].join('\n');
    assert.equal(detectOverload(pane, PATS), true);
  });

  // --- Finding 6: the 50-line capture + chrome-strip let an old quoted error be reached
  //     from far up when everything below it is chrome (a tall task widget). Unlike the
  //     content-below case above (contentTail stops at the content), chrome is all
  //     stripped, so an error 20+ raw lines up would re-enter the window. A terminal error
  //     sits just above the input box; bound overload to a max raw distance from the
  //     bottom so a widget-buried stale error stays out. ---
  it('does NOT match an API error buried >20 raw lines up behind a tall chrome widget', () => {
    const pane = [
      'API Error: 529 Overloaded',
      '  20 tasks (0 done, 20 open)',
      ...Array(22).fill('  □ pending task'),
      '───────────────', '❯ ',
    ].join('\n');
    assert.equal(detectOverload(pane, PATS), false);
  });
  it('still matches a terminal API error just above the input box', () => {
    const pane = ['API Error: 529 Overloaded', '───────────────', '❯ ', '───────────────', '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(detectOverload(pane, PATS), true);
  });
});

describe('overloadMatch (observability)', () => {
  it('reports the matched pattern and offending line', () => {
    const m = overloadMatch('thinking…\nAPI Error: 529 Overloaded', PATS);
    assert.ok(m && /429\|500/.test(m.pattern));
    assert.equal(m.line, 'API Error: 529 Overloaded');
  });
  it('returns null when nothing matches', () => assert.equal(overloadMatch('res.status(503)', PATS), null));
  it('truncates a very long offending line to 200 chars', () => {
    const m = overloadMatch('API Error: 500 ' + 'x'.repeat(500), PATS);
    assert.ok(m && m.line.length <= 200);
  });
});

describe('isWorking', () => {
  it('detects the working footer', () => assert.equal(isWorking('Cogitating… (esc to interrupt)'), true));
  it('detects esc/interrupt through ANSI', () => assert.equal(isWorking('\x1b[2mesc to interrupt\x1b[0m'), true));
  it('returns false at an idle prompt', () => assert.equal(isWorking('│ > '), false));
  // Claude's internal-retry indicator means retries are NOT exhausted → not terminal.
  it('treats the "Retrying in" suffix as still-working', () => assert.equal(isWorking('API Error: 529 Overloaded · Retrying in 5s · attempt 3/10'), true));
  it('treats an "attempt n/m" indicator as still-working', () => assert.equal(isWorking('thinking… attempt 2/10'), true));

  // The main thread awaiting a subagent is working — injecting a retry there spams a
  // progressing session. LIVE-ONLY render, so it's safe (see the counter-repro below).
  it('treats "Waiting for N background agent(s) to finish" as working', () => {
    assert.equal(isWorking('✻ Waiting for 1 background agent to finish'), true);
    assert.equal(isWorking('✻ Waiting for 3 background agents to finish'), true);
  });
  // Counter-repro (reviewer): the "Backgrounded agent" NOTICE is a transcript line that
  // lingers after the agent finished. It must NOT be treated as working, or a genuinely
  // limited idle session (banner live below the stale notice) would never be retried.
  it('does NOT treat the lingering "Backgrounded agent" transcript notice as working', () => {
    const pane = ['● Task(build the parser)', '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
      '● Done. The parser passes all 14 tests.',
      "You've hit your session limit · resets 3pm (Europe/Zurich)", '❯ '].join('\n');
    assert.equal(isWorking(pane), false);   // agent finished; the pane is idle at a live limit
  });

  // --- Finding 3: isWorking must measure the SAME bottom as isRateLimited (both
  //     chrome-aware). A live working footer pushed up by a tall chrome stack below it was
  //     invisible to the old raw tail, while chrome-aware isRateLimited still saw a
  //     lingering banner → the waiting branch injected retry text into a mid-flight
  //     session. contentTail strips the chrome stack and reaches the working footer. ---
  it('sees a working footer even when a tall chrome stack is rendered below it', () => {
    const pane = [
      '✻ Cogitating… (12s · esc to interrupt)',
      '  10 tasks (2 done, 1 in progress, 7 open)',
      '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g',
      '   … +2 completed',
      '  new task? /clear to save 300k tokens',
      '',
      '───────────────',
      '❯ ',
      '───────────────',
      '  Opus 4.8 | repo@dev | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');   // 17 lines: footer at index 0 is >12 raw lines from the bottom
    assert.equal(isWorking(pane), true);
  });
  it('does not treat the idle "✻ Brewed for …" spinner as working', () => {
    assert.equal(isWorking('✻ Brewed for 54m 35s\n❯ '), false);
  });
});

describe('DEFAULT_OVERLOAD config', () => {
  it('is present on DEFAULT_CONFIG with expected shape', () => {
    assert.equal(DEFAULT_CONFIG.overload.enabled, true);
    assert.deepEqual(DEFAULT_CONFIG.overload.backoffSeconds, [30, 60, 120, 240, 300]);
    assert.equal(DEFAULT_CONFIG.overload.steadyStateSeconds, 300);
    assert.equal(DEFAULT_CONFIG.overload.jitterPct, 15);
    assert.equal(DEFAULT_CONFIG.overload.maxTotalWaitMinutes, 120);
    assert.equal(DEFAULT_CONFIG.overload.relaunchOnExit, false);
    assert.ok(DEFAULT_CONFIG.overload.patterns.includes('overloaded_error'));
    // Defaults must never carry a bare status number — that's the false-positive class.
    assert.ok(!DEFAULT_CONFIG.overload.patterns.some(p => /^\d+$/.test(p)));
  });
});

async function loadFrom(obj) {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = join(tmpdir(), `car-ovl-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`);
  await writeFile(f, JSON.stringify(obj));
  try { return await loadConfig(f); } finally { await unlink(f); }
}

describe('overload config validation', () => {
  it('merges a partial overload block onto defaults', async () => {
    const c = await loadFrom({ overload: { maxTotalWaitMinutes: 30 } });
    assert.equal(c.overload.maxTotalWaitMinutes, 30);
    assert.deepEqual(c.overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
    assert.equal(c.overload.enabled, true);
  });
  it('clamps jitterPct to 0..100', async () => {
    assert.equal((await loadFrom({ overload: { jitterPct: 999 } })).overload.jitterPct, 100);
    assert.equal((await loadFrom({ overload: { jitterPct: -5 } })).overload.jitterPct, 0);
  });
  it('falls back on empty/invalid backoffSeconds', async () => {
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: [] } })).overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: 'soon' } })).overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
  });
  it('drops non-positive backoff entries but keeps valid ones', async () => {
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: [10, -1, 0, 20] } })).overload.backoffSeconds, [10, 20]);
  });
  it('falls back on bad maxTotalWaitMinutes', async () => {
    assert.equal((await loadFrom({ overload: { maxTotalWaitMinutes: -1 } })).overload.maxTotalWaitMinutes, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  });
  it('filters non-string patterns and falls back when none valid', async () => {
    assert.deepEqual((await loadFrom({ overload: { patterns: ['Boom', 42, ''] } })).overload.patterns, ['Boom']);
    assert.deepEqual((await loadFrom({ overload: { patterns: [1, 2] } })).overload.patterns, DEFAULT_OVERLOAD.patterns);
  });
  it('coerces non-boolean enabled/relaunchOnExit to defaults', async () => {
    const c = await loadFrom({ overload: { enabled: 'yes', relaunchOnExit: 1 } });
    assert.equal(c.overload.enabled, true);
    assert.equal(c.overload.relaunchOnExit, false);
  });
});

describe('overload backoff schedule (pure)', () => {
  it('follows 30/60/120/240/300 then steady 300', () => {
    const o = DEFAULT_OVERLOAD;
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => overloadBaseWaitMs(i, o) / 1000),
      [30, 60, 120, 240, 300, 300, 300]);
  });
  it('applyJitter stays within ±jitterPct', () => {
    for (let i = 0; i < 200; i++) {
      const out = applyJitter(100_000, 15);
      assert.ok(out >= 85_000 && out <= 115_000, `out=${out}`);
    }
  });
  it('applyJitter with pct=0 is exact', () => assert.equal(applyJitter(120_000, 0), 120_000));
  it('applyJitter is symmetric at rand extremes', () => {
    assert.equal(applyJitter(100_000, 10, () => 0), 90_000);   // rand=0 → -10%
    assert.equal(applyJitter(100_000, 10, () => 1), 110_000);  // rand=1 → +10%
    assert.equal(applyJitter(100_000, 10, () => 0.5), 100_000);
  });
  it('nextOverloadWaitMs composes base + jitter', () => {
    assert.equal(nextOverloadWaitMs(0, { ...DEFAULT_OVERLOAD, jitterPct: 0 }), 30_000);
  });
});

const near = (actual, expectedMs) => Math.abs(actual - expectedMs) < 2000;

describe('processOneTick — overload path', () => {
  it('enters overload (not usage-wait) on a 529', async () => {
    const t = mockTmux('API Error: 529 Overloaded');
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-detected');
    assert.equal(s.status, 'overload');
    assert.ok(near(s.overloadWaitUntil - Date.now(), 30_000));
    assert.equal(t._sent.length, 0);
  });

  it('does NOT enter overload while Claude is working', async () => {
    const t = mockTmux('API Error: 529 Overloaded\n· Cogitating… (esc to interrupt)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(s.status, 'monitoring');
  });

  it('does NOT enter overload while Claude is still internally retrying (colon form + suffix)', async () => {
    const t = mockTmux('API Error: 529 {"type":"error"} · Retrying in 5s · attempt 3/10');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  it('does NOT retry a non-target error', async () => {
    const t = mockTmux('Here is the answer to your question. Done.');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  it('usage-limit takes precedence over a co-present overload pattern', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\nAPI Error: 529 Overloaded');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(s.status, 'waiting');
  });

  it('sends the overload retry when the backoff window expires', async () => {
    const t = mockTmux('API Error: 529 Overloaded');
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    const r = await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-retried');
    assert.equal(t._sent.length, 1);
    assert.equal(t._sent[0], DEFAULT_OVERLOAD.retryMessage);
    assert.equal(s.overloadAttempts, 1);
    assert.ok(near(s.overloadWaitUntil - Date.now(), 60_000)); // next backoff = index 1
  });

  it('walks the full 30→60→120→240→300→300 schedule across retries', async () => {
    const t = mockTmux('API Error: 529 Overloaded');
    const s = createMonitorState();
    // tick 1: detect → first 30s window
    await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
    const seen = [Math.round((s.overloadWaitUntil - Date.now()) / 1000)];
    for (let i = 0; i < 5; i++) {
      s.overloadWaitUntil = Date.now() - 1;                       // force expiry
      await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
      seen.push(Math.round((s.overloadWaitUntil - Date.now()) / 1000));
    }
    assert.deepEqual(seen, [30, 60, 120, 240, 300, 300]);
    assert.equal(t._sent.length, 5);
  });

  it('defers (overload-working) if Claude resumes work during the wait', async () => {
    const t = mockTmux('API Error: 529 Overloaded\nThinking… (esc to interrupt)');
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-working');
    assert.equal(t._sent.length, 0);
    assert.equal(s.overloadAttempts, 0); // no attempt consumed
  });

  it('clears back to monitoring when the overload text is gone', async () => {
    const t = mockTmux('All good, here is your refactor.');
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadAttempts = 2; s.overloadTotalWaitMs = 90_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.overloadAttempts, 0);
  });

  it('gives up at the maxTotalWait cap', async () => {
    const t = mockTmux('API Error: 529 Overloaded');
    const c = cfg({ backoffSeconds: [30, 60], maxTotalWaitMinutes: 0.75 }); // cap = 45s
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', c, () => true, NO_JITTER), 'overload-detected'); // +30s (total 30)
    s.overloadWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true, NO_JITTER), 'overload-retried');   // +60s (total 90 > cap)
    s.overloadWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true, NO_JITTER), 'overload-gave-up');
    assert.equal(t._sent.length, 1);
    assert.equal(s._gaveUp, true, 'give-up must be flagged for external consumers (e.g. tmux status bar)');
  });

  it('switches to the usage path if a usage limit appears mid-overload', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadAttempts = 1; s.overloadTotalWaitMs = 60_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(s.status, 'waiting');
    assert.equal(s.overloadAttempts, 0);
  });
});

describe('processOneTick — StopFailure event path (authoritative)', () => {
  const ev = { error: 'overloaded', ts: Date.now() };

  it('enters overload from a StopFailure marker with NO scraper match', async () => {
    const t = mockTmux('working on a /health endpoint res.status(503)', 'node', true, ev);
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-detected');
    assert.equal(s.viaEvent, true);
    assert.equal(t._cleared, true);     // marker consumed
    assert.equal(t._sent.length, 0);    // no send yet — backoff first
    assert.ok(near(s.overloadWaitUntil - Date.now(), 30_000));
  });

  it('sends exactly once after the window, then returns to monitoring (edge-triggered)', async () => {
    const t = mockTmux('idle prompt', 'node', true, null);
    const s = createMonitorState();
    s.status = 'overload'; s.viaEvent = true; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    const r = await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-retried');
    assert.equal(t._sent[0], DEFAULT_OVERLOAD.retryMessage);
    assert.equal(s.status, 'monitoring');   // back to waiting for the next failure
    assert.equal(s.viaEvent, false);
    assert.equal(s.overloadAttempts, 1);
  });

  it('cancels the send if Claude self-recovered during the backoff', async () => {
    const t = mockTmux('Thinking… (esc to interrupt)', 'node', true, null);
    const s = createMonitorState();
    s.status = 'overload'; s.viaEvent = true; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(t._sent.length, 0);
    assert.equal(s.status, 'monitoring');
  });

  it('treats an event as self-recovered if Claude is already working at detection', async () => {
    const t = mockTmux('Cogitating… (esc to interrupt)', 'node', true, ev);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(t._cleared, true);
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  // --- Regression: the always-on scraper must not double-fire on the SAME overload banner
  //     that the event path just handled. After a viaEvent retry returns to monitoring with
  //     the banner still on screen (viaEvent is edge-triggered — it does not verify the
  //     banner cleared), a naive always-on scraper re-detects it and starts a SECOND backoff
  //     (extra injection + resetOverload defeats the give-up cap). ---
  it('does not re-fire the scraper on the same banner lingering after a viaEvent retry', async () => {
    const banner = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';
    const s = createMonitorState();
    // in a viaEvent backoff whose window just elapsed, the banner still rendered
    s.status = 'overload'; s.viaEvent = true; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    const t1 = mockTmux(banner, 'node', true, null);
    assert.equal(await processOneTick(s, t1, '%0', cfg(), () => true, NO_JITTER), 'overload-retried'); // send #1
    assert.equal(s.status, 'monitoring');
    assert.equal(t1._sent.length, 1);
    assert.equal(s.overloadAttempts, 1);
    // next tick: same banner still present, no new marker → scraper must NOT re-detect it
    const t2 = mockTmux(banner, 'node', true, null);
    assert.equal(await processOneTick(s, t2, '%0', cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(t2._sent.length, 0);        // no second injection
    assert.equal(s.overloadAttempts, 1);     // give-up budget not reset
  });

  it('consumes-and-ignores a non-retryable marker (e.g. rate_limit from an outdated hook)', async () => {
    // Regression: settings.json freezes the hook's cli.js path + matcher at install time,
    // so an old hook binary can still write rate_limit markers after an upgrade. The
    // daemon must not enter overload backoff off it — just consume it so it can't re-fire
    // (the scraper still gets its normal shot on the next tick).
    for (const bad of ['rate_limit', 'billing_error', 'invalid_request']) {
      const t = mockTmux('idle prompt', 'node', true, { error: bad, ts: Date.now() });
      const s = createMonitorState();
      const r = await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER);
      assert.equal(r, 'event-ignored', bad);
      assert.equal(s.status, 'monitoring', bad);
      assert.equal(t._cleared, true, bad);     // consumed so it can't re-fire
      assert.equal(t._sent.length, 0, bad);
    }
  });

  // --- Regression: the overload scraper must stay a live safety net AFTER the hook has
  //     fired. The event path only covers overloaded/server_error; a transient API 429
  //     ("temporarily limiting requests · Rate limited") emits no retryable marker, so ONLY
  //     the scraper can catch it. It was being permanently disabled once any StopFailure
  //     latched eventMode, so a genuinely-stuck 429 was never retried (had to be resumed by
  //     hand). ---
  it('keeps the overload scraper active after the hook has fired (transient 429 with no marker is still retried)', async () => {
    const s = createMonitorState();
    // 1. A retryable StopFailure fires — the hook is now known live for this pane.
    const t1 = mockTmux('idle prompt', 'node', true, { error: 'server_error', ts: Date.now() });
    assert.equal(await processOneTick(s, t1, '%0', cfg(), () => true, NO_JITTER), 'overload-detected');
    s.status = 'monitoring';  // recovered from that incident, back to watching
    // 2. Later, a transient API 429 the event path can't emit (no marker) appears. Only the
    //    scraper can catch it; the earlier event must not have disabled it.
    const render = '● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\n\n✻ Cogitated for 37s\n\n❯ ';
    const t2 = mockTmux(render, 'node', true, null);
    assert.equal(await processOneTick(s, t2, '%0', cfg(), () => true, NO_JITTER), 'overload-detected');
    assert.equal(s.status, 'overload');
  });

  it('does not send into a shell on an event (foreground gate still applies)', async () => {
    const t = mockTmux('user@host:~$', 'bash', false, null);
    const s = createMonitorState();
    s.status = 'overload'; s.viaEvent = true; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-exited-to-shell');
    assert.equal(t._sent.length, 0);
    assert.equal(s.status, 'monitoring');
  });

  it('flags gaveUp when a fresh event arrives already past the cap, even though status stays "monitoring"', async () => {
    // Regression: this path returns from within the (idle) 'monitoring' branch and never
    // assigns state.status, so a naive reader would see status:'monitoring' (green/live)
    // for a monitor that has permanently stopped acting on this pane's failures.
    const t = mockTmux('idle prompt', 'node', true, ev);
    const s = createMonitorState();
    const c = cfg({ maxTotalWaitMinutes: 0.5 }); // cap = 30s
    s.overloadTotalWaitMs = 30_000; // already at/over the cap before this tick
    const r = await processOneTick(s, t, '%0', c, () => true, NO_JITTER);
    assert.equal(r, 'overload-gave-up');
    assert.equal(s.status, 'monitoring');
    assert.equal(s._gaveUp, true);
  });
});

describe('processOneTick — overload gating (exited-to-shell vs alive)', () => {
  it('does NOT send-keys when foreground is a shell; reports exited-to-shell (relaunch off)', async () => {
    const t = mockTmux('API Error: 500 Internal server error\nuser@host:~$', 'bash', false);
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-exited-to-shell');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'bash');
  });

  it('relaunches via claude --continue when relaunchOnExit is on and foreground is a shell', async () => {
    const t = mockTmux('API Error: 500 Internal server error\nuser@host:~$', 'bash', false);
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    const c = cfg({ relaunchOnExit: true });
    assert.equal(await processOneTick(s, t, '%0', c, () => true, NO_JITTER), 'overload-relaunched');
    assert.equal(t._sent.length, 1);
    assert.equal(t._sent[0], 'claude --continue');
    assert.equal(s.overloadAttempts, 1);
  });

  it('skips (not exited-to-shell) when some other app is foreground', async () => {
    const t = mockTmux('API Error: 503', 'vim', false);
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
  });

  it('retries normally when claude is alive at the prompt (foreground check passes)', async () => {
    const t = mockTmux('API Error: 500 Internal server error', 'node', true);
    const s = createMonitorState();
    s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1; s.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true, NO_JITTER), 'overload-retried');
    assert.equal(t._sent.length, 1);
  });

  it('disabled overload block is ignored entirely', async () => {
    const t = mockTmux('API Error: 529 Overloaded');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg({ enabled: false }), () => true, NO_JITTER), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
});
