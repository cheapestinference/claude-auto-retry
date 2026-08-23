import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimited, findRateLimitMessage, detectOverload, safeguardMatch,
} from '../src/patterns.js';
import { DEFAULT_OVERLOAD } from '../src/config.js';

const TAIL = 12; // RATE_LIMIT_TAIL_LINES

const CHROME = [
  '╭──────────────────────────╮',
  '│ >                        │',
  '╰──────────────────────────╯',
  '  ⏵⏵ auto mode on',
  '~/project | opus 4.8 | 47k/200k | v2.1.214',
];

// #63: banner text inside a tool-call render — a grep argument, a quoted log line in the
// result block — is text ABOUT a limit, never a live banner. It sits in the most recent
// content rows (inside the tail window; chrome-stripping doesn't help), and before the
// fix it parked the monitor for the parsed hours (a real 22.5h incident).
describe('tool-call echo lines are not a live rate limit (#63)', () => {
  it("reporter's repro: banner text quoted in a Bash() argument", () => {
    const pane = [
      '● Bash(grep -c "5-hour limit reached - resets 3pm (UTC)" ~/.claude-auto-retry/logs/2026-07-18.log)',
      '  ⎿  3',
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
    assert.equal(findRateLimitMessage(pane, []), null);
  });

  it('banner text quoted in a tool RESULT block (grep output lines)', () => {
    const pane = [
      '● Bash(grep "limit reached" ~/.claude-auto-retry/logs/2026-07-18.log)',
      '  ⎿  [16:29:37] 5-hour limit reached - resets 3pm (UTC)',
      '     [16:31:12] 5-hour limit reached - resets 3pm (UTC)',
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
    assert.equal(findRateLimitMessage(pane, []), null);
  });

  it('control: the same text unquoted at the prompt IS detected', () => {
    const pane = [
      '5-hour limit reached - resets 3pm (UTC)',
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, []), /resets 3pm/);
  });

  it('control: a real banner ABOVE a small tool render is still detected', () => {
    const pane = [
      "You've hit your session limit · resets 2:10am (Australia/Melbourne)",
      '● Bash(date)',
      '  ⎿  Fri Jul 18',
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
  });

  it('a fresh quoted line does not steal the message from a real banner', () => {
    const pane = [
      "You've hit your session limit · resets 2:10am (Australia/Melbourne)",
      '● Bash(grep "old limit - resets 9am (UTC)" log.txt)',
      '  ⎿  1',
      ...CHROME,
    ].join('\n');
    // Bottom-up scan must skip the quoted grep line and land on the real banner.
    assert.match(findRateLimitMessage(pane, []), /resets 2:10am/);
  });

  it('control: a live banner rendered as a └ child of an agent-finished notice IS detected', () => {
    // Observed live shape: the limit interrupts a subagent; the banner renders under the
    // notice with a └ marker. Result markers must only mask beneath a `● Name(` header.
    const pane = [
      '● Agent "Map drop-point" finished · 1m 5s',
      "  └ You've hit your session limit · resets 2am (Europe/Zurich)",
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, []), /resets 2am/);
  });

  it('a REAL "● API Error" line is not mistaken for tool echo', () => {
    // API errors render with the same ● glyph but never as `Name(...)`.
    const pane = [
      "● You've hit your session limit · resets 2:10am (Australia/Melbourne)",
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
  });

  it('print mode (tailLines=0) keeps matching quoted/JSON error shapes', () => {
    // launcher.js scans spawned-process output where quoted errors are the REAL signal;
    // the tool-echo filter must stay TUI-only (#63 caveat 1).
    const out = 'API Error: 429 {"error":{"message":"You\'ve hit your session limit · resets 3pm (UTC)"}}';
    assert.equal(isRateLimited(out, []), true);
  });

  it('quoted overload text in a Bash() line does not fire the overload path', () => {
    const pane = [
      '● Bash(grep "API Error: 529 overloaded_error" ~/.claude-auto-retry/logs/x.log)',
      '  ⎿  2',
      ...CHROME,
    ].join('\n');
    assert.equal(detectOverload(pane, DEFAULT_OVERLOAD.patterns), false);
  });

  it('quoted safeguard text in a Bash() line does not fire the safeguard path', () => {
    const pane = [
      '● Bash(grep "safeguards flagged this message" session.log)',
      '  ⎿  API Error: safeguards flagged this message (legal/aup)',
      ...CHROME,
    ].join('\n');
    assert.equal(safeguardMatch(pane, ['safeguards flagged this message']), null);
  });

  it('control: a real overload API Error still fires', () => {
    const pane = [
      '● API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      ...CHROME,
    ].join('\n');
    assert.equal(detectOverload(pane, DEFAULT_OVERLOAD.patterns), true);
  });
});
