import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, isRateLimited, findRateLimitMessage, isRateLimitOptionsPrompt, menuStepsToWaitOption } from '../src/patterns.js';

const MENU_UPGRADE_FIRST = [
  "You've hit your session limit · resets 6:50pm (Europe/London)",
  '/rate-limit-options',
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

describe('stripAnsi', () => {
  it('removes bold codes', () => {
    assert.equal(stripAnsi('\x1b[1mlimit\x1b[0m'), 'limit');
  });
  it('removes color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });
  it('removes cursor positioning', () => {
    assert.equal(stripAnsi('\x1b[2Jhello\x1b[H'), 'hello');
  });
  it('leaves plain text unchanged', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });
  it('handles mixed content', () => {
    assert.equal(
      stripAnsi('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'),
      '5-hour limit reached - resets 3pm'
    );
  });
});

describe('isRateLimited', () => {
  it('detects "5-hour limit reached"', () => {
    assert.equal(isRateLimited('5-hour limit reached - resets 3pm'), true);
  });
  it('detects "usage limit" with reset', () => {
    assert.equal(isRateLimited('Claude usage limit reached. Resets at 2pm'), true);
  });
  it('detects "out of extra usage"', () => {
    assert.equal(isRateLimited("You're out of extra usage · resets 3pm"), true);
  });
  it('detects "try again in 5 hours"', () => {
    assert.equal(isRateLimited('Please try again in 5 hours'), true);
  });
  it('detects "rate limit resets"', () => {
    assert.equal(isRateLimited('Rate limit hit. Resets at 4pm'), true);
  });
  it('returns false for normal output', () => {
    assert.equal(isRateLimited('I can help you with that code'), false);
  });
  it('returns false for empty string', () => {
    assert.equal(isRateLimited(''), false);
  });
  it('detects rate limit with ANSI codes embedded', () => {
    assert.equal(isRateLimited('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'), true);
  });
  it('matches custom patterns', () => {
    assert.equal(isRateLimited('custom error xyz', [/custom error/i]), true);
  });
  // --- Finding 4: customPatterns test the RAW tail window (master's semantics), not the
  //     chrome-stripped one — the user owns their own false-positive tradeoff. A pattern
  //     keyed on footer text (e.g. a usage percentage) must still fire even though the
  //     footer is furniture the chrome path strips. ---
  it('matches a footer-keyed custom pattern in the raw tail (not chrome-stripped)', () => {
    const pane = [
      ...Array(6).fill('● ordinary work'),
      '  Opus 4.8 | repo@dev | 5h 3% left @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on',
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [/\b3% left\b/i], 12), true);
  });
  it('detects "You\'ve hit your limit" (real Claude Code message)', () => {
    assert.equal(isRateLimited("You've hit your limit · resets 3pm (Asia/Tbilisi)"), true);
  });
  it('detects "hit the limit resets"', () => {
    assert.equal(isRateLimited('You hit the limit. Resets at 5pm'), true);
  });
  it('detects "usage limit · resets in: 3 hours"', () => {
    assert.equal(isRateLimited('usage limit · resets in: 3 hours'), true);
  });
  it('detects "You\'ve hit your session limit" (current Claude Code wording, #15)', () => {
    assert.equal(isRateLimited("You've hit your session limit · resets 4:50pm (Asia/Shanghai)"), true);
  });
  it('detects "You\'ve hit your weekly limit" (#15)', () => {
    assert.equal(isRateLimited("You've hit your weekly limit · resets 9am (Europe/London)"), true);
  });
  it('still detects "You\'ve hit your 5-hour limit" (no qualifier regression)', () => {
    assert.equal(isRateLimited("You've hit your 5-hour limit · resets 3pm (UTC)"), true);
  });

  // --- Chrome-aware tail (tailLines > 0): a live banner pushed up by UI furniture is
  //     still found; a stale/quoted banner with real work below it is not. ---
  const withChrome = (banner) => [
    banner,
    "     /usage-credits to finish what you're working on.",
    '', '✻ Brewed for 12m 3s', '',
    '  8 tasks (4 done, 1 in progress, 3 open)',
    '  ◼ a', '  □ b', '  □ c', '  ✓ d', '   … +3 completed',
    '  new task? /clear to save 300k tokens',
    '', '──────', '❯ ', '──────',
    '  Opus 4.8 | repo@dev | v2.1.201', '  ⏵⏵ auto mode on',
  ].join('\n');
  it('finds a banner buried behind a task widget + input box (tail=12)', () => {
    assert.equal(isRateLimited(withChrome("You've hit your session limit · resets 2am (Europe/Zurich)"), [], 12), true);
  });
  it('finds it via the /usage-credits companion even without the reset on the banner line', () => {
    const pane = ['Ran 1 shell command', '  └ Session limit hit',
      '     /usage-credits to finish what you\'re working on. resets 2am',
      '', '  8 tasks (4 done, 1 in progress, 3 open)', '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
  });
  // --- #63 follow-up: the tool-echo mask must survive a tool RESULT taller than the tail
  //     window. When the `● Bash(` header falls outside the 12-content-line window, a mask
  //     computed only on the windowed lines never latches inBlock and the quoted log lines
  //     go unmasked — reviving the exact #63 false positive one grep-length away. ---
  const logLine = (t) => `     [2026-07-18 ${t}] Rate limit detected: "5-hour limit reached - resets 3pm (UTC)". Waiting 12600s...`;
  const tallToolResult = [
    '● Bash(grep "limit" ~/.claude-auto-retry/logs/2026-07-18.log)',
    '  ⎿  [2026-07-18 09:58:01] Monitor started for pane %3 (claude PID: 51023)',
    logLine('10:29:37'), logLine('11:31:12'), logLine('12:33:40'), logLine('13:35:02'),
    '     [2026-07-18 13:35:02] Sent retry message (attempt 1)',
    '     [2026-07-18 13:36:20] User already continued. Attempt counter reset.',
    logLine('14:41:55'), logLine('15:44:10'),
    '     [2026-07-18 15:44:10] Sent retry message (attempt 1)',
    logLine('16:29:37'), logLine('16:31:12'),
    '     [2026-07-18 16:31:12] Max retries (5) reached. Monitor still active...',
  ];
  it('does NOT fire on a tool result taller than the tail window (header outside it, #63)', () => {
    const pane = [...tallToolResult, '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('still detects a LIVE banner rendered below a tall tool result', () => {
    const pane = [...tallToolResult,
      "You've hit your session limit · resets 2am (Europe/Zurich)", '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
  });

  // Fable review F3: a session EXPLAINING /usage-credits (companion + a loose "usage limit"
  // LIMIT match, but no reset time) must not fire the backstop.
  it('does NOT backstop-fire on a conversation explaining /usage-credits (no reset nearby)', () => {
    const pane = ['When you hit your usage limit you can run',
      '/usage-credits to purchase extra usage.', '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  // --- Finding 1: the /usage-credits backstop must have the same liveness discipline as
  //     the main path. A resumed session's scrollback always contains the stale
  //     banner+companion (the live render prints the companion), with real work rendered
  //     BELOW it. The backstop must not fire on that — otherwise up to maxRetries bogus
  //     injections and (since "resets 2am" has passed) a ~24h wait rolled to tomorrow. ---
  it('does NOT fire on a stale banner+companion with real work rendered below (resumed session)', () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      ...Array(15).fill('● wrote some code'),
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire when a stale companion sits above later non-chrome output', () => {
    const pane = [
      "  └ Session limit hit · /usage-credits to finish. resets 2am",
      '● Ran a shell command',
      '  └ done',
      ...Array(12).fill('● more real work after the resume'),
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire on a quoted banner with real work below it (tail=12)', () => {
    const pane = ["You've hit your session limit · resets 3pm (UTC)",
      ...Array(15).fill('● wrote some code'), '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('full scan (tailLines=0, print mode) is unaffected by chrome logic', () => {
    assert.equal(isRateLimited("You've hit your session limit · resets 3pm (UTC)", [], 0), true);
  });

  // --- Review follow-up: the flagship "banner behind a widget" fix must also fire for the
  //     BOXED input render Claude Code actually uses. contentTail stops at the first
  //     non-chrome line from the bottom; the box middle row "│ >          │" isn't matched
  //     by the all-box-chars rule (the `>` breaks it) nor the empty-prompt rule (starts
  //     with `│`), so the strip halted at the input box and never reached the widget/banner
  //     above. Classifying the "│ … │" row as chrome fixes it. ---
  const widget = ['  8 tasks (4 done, 1 in progress, 3 open)',
    '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g', '   … +3 completed',
    '  new task? /clear to save 300k tokens'];
  const banner = "You've hit your session limit · resets 3pm (UTC)";
  it('finds a banner behind a widget above a BARE prompt (tail=12)', () => {
    const bare = ['───────', '❯ ', '───────', '  ⏵⏵ auto mode on'];
    assert.equal(isRateLimited([banner, ...widget, ...bare].join('\n'), [], 12), true);
  });
  it('finds a banner behind a widget above a BOXED input "│ > │" (tail=12)', () => {
    const boxed = ['╭────────────────────────╮', '│ >                      │', '╰────────────────────────╯', '  ? for shortcuts'];
    assert.equal(isRateLimited([banner, ...widget, ...boxed].join('\n'), [], 12), true);
  });
  it('boxed input with typed text is still chrome (box row stripped)', () => {
    const boxed = ['╭────────────────────────╮', '│ > continue the task    │', '╰────────────────────────╯'];
    assert.equal(isRateLimited([banner, ...widget, ...boxed].join('\n'), [], 12), true);
  });
  // The rule must NOT strip unicode-border tool output (psql/mysql/duf tables). Those rows
  // (`│ 0 │ user0 │`, no prompt glyph) are content — stripping them would collapse the
  // content distance and pull a stale, scrolled-past banner back into the window.
  it('does NOT strip a psql unicode-border table, so a stale banner above it stays out', () => {
    const table = ['  ⎿  ┌────────┬───────────┐', '     │ id     │ name      │', '     ├────────┼───────────┤',
      ...Array(10).fill('     │ 0      │ user0     │'), '     └────────┴───────────┘'];
    const pane = ["You've hit your session limit · resets 3pm (UTC)",
      '● Bash(psql -c "select * from users limit 8")', ...table, '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  // Fable review F4a: the boxed-input rule must not match a table row whose FIRST cell is a
  // ">"/prompt glyph (`│ >  │ … │`) — the `[^│]*` (was `.*`) forbids an internal bar.
  it('does NOT strip a psql row whose first cell is ">" (internal bar guard)', () => {
    const table = ['  ⎿  ┌────────┬───────────┐', '     │ op     │ meaning   │', '     ├────────┼───────────┤',
      ...Array(10).fill('     │ >      │ greater-than op │'), '     └────────┴───────────┘'];
    const pane = ["You've hit your session limit · resets 3pm (UTC)", '● Bash(psql)', ...table, '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });

  // --- Finding 2: chrome classifiers must not match ordinary content. Each probe below is
  //     a real output line the reviewer showed being wrongly stripped as chrome, which
  //     lets contentTail "see through" it and pull a STALE banner above back into the
  //     window. Scenario: stale banner, then 13 copies of the probe (the "real work
  //     below"), then the input box. If the probe is correctly CONTENT, contentTail stops
  //     at it and the stale banner stays out (→ false). If wrongly chrome, all get
  //     stripped and the banner re-enters the window (→ true, the false positive). ---
  const CONTENT_PROBES = [
    'Press ctrl+c to stop the dev server',   // contains "ctrl+"
    '⎿ Renamed a.js → b.js',                  // contains arrow →
    '✓ Fixed the bug',                        // checkmark bullet, no leading indent
    'Released v0.5.1',                        // bare semver, no footer pipe
    'Run /rc to reconnect',                   // contains /rc
  ];
  for (const probe of CONTENT_PROBES) {
    it(`does not strip "${probe}" as chrome, so a stale banner above it stays out (tail=12)`, () => {
      const pane = [
        "You've hit your session limit · resets 3pm (UTC)",
        ...Array(13).fill(probe),
        '───────────────────────────────',
        '❯ ',
      ].join('\n');
      assert.equal(isRateLimited(pane, [], 12), false);
    });
  }
  // The genuine footer/widget lines these patterns replaced must still classify as chrome,
  // so a banner behind them is still reachable.
  it('still strips the real version footer and mode footer (banner behind them detected)', () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      '───────────────────────────────',
      '❯ ',
      '───────────────────────────────',
      '  Opus 4.8 1M | automation-monorepo@dev | 5h 100% @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
  });

  // --- Fable review F4b: four CHROME_LINE patterns still matched ordinary PROSE as a
  //     last-content-line, so a stale banner exactly at the content boundary could be
  //     stripped back into the window (same false-positive class as Finding 2). Anchor each
  //     to its actual render: the auto-mode notice, the "N tasks (" widget header, the
  //     "Backgrounded agent (" notice, and the "/clear to save" save hint. ---
  const F4B_PROSE_PROBES = [
    'auto mode is enabled in your settings',   // matched bare /\bauto mode\b/
    '3 tasks remain in the backlog',           // matched /^\s*\d+\s+tasks?\b/ (no widget "(")
    'Backgrounded agent finished the lint run', // matched bare /Backgrounded agent/
    'Should I start the new task?',            // matched standalone /new task\?/
  ];
  for (const probe of F4B_PROSE_PROBES) {
    it(`does not strip prose "${probe}" as chrome, so a stale banner above it stays out (tail=12)`, () => {
      const pane = [
        "You've hit your session limit · resets 3pm (UTC)",
        ...Array(13).fill(probe),
        '───────────────────────────────',
        '❯ ',
      ].join('\n');
      assert.equal(isRateLimited(pane, [], 12), false);
    });
  }
  // The genuine renders these anchors target must STILL classify as chrome (banner behind
  // them detected): the auto-mode footer/notice, the "N tasks (" header, the backgrounded-
  // agent notice, and the "new task? /clear to save" hint.
  const F4B_CHROME_RENDERS = [
    '  Allowed by auto mode',
    '  8 tasks (4 done, 1 in progress, 3 open)',
    '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
    '  new task? /clear to save 300k tokens',
  ];
  for (const render of F4B_CHROME_RENDERS) {
    it(`still strips genuine render "${render.trim()}" as chrome (banner behind it detected)`, () => {
      const pane = [
        "You've hit your session limit · resets 2am (Europe/Zurich)",
        ...Array(13).fill(render),
        '❯ ',
      ].join('\n');
      assert.equal(isRateLimited(pane, [], 12), true);
    });
  }
});

describe('stripAnsi (private-mode sequences)', () => {
  it('strips cursor hide sequence', () => {
    assert.equal(stripAnsi('\x1b[?25lhello\x1b[?25h'), 'hello');
  });
  it('strips bracketed paste mode', () => {
    assert.equal(stripAnsi('\x1b[?2004htext\x1b[?2004l'), 'text');
  });
});

describe('findRateLimitMessage', () => {
  // --- #73: a line may MENTION a limit or reset time without BEING one. `try again in …`
  //     is plain English, so model output or a user's own message — which renders BELOW the
  //     banner it discusses — stole the bottom-up scan and turned a 5h wait into ~3min.
  //     Eligibility is now per-line: the clause must LEAD the line, or the line must lead
  //     with the limit itself. Freshness (bottom-up) is unchanged. ---
  const PROSE  = '⏺ The API said to try again in 2 minutes before the limit window rolls';
  const TYPED  = '❯ it told me to try again in 2 minutes, is that right?';
  const BANNER = "You've hit your session limit · resets 5:20pm (Europe/London)";

  it('prefers the one-line banner over model prose below it (#73)', () => {
    assert.equal(findRateLimitMessage([BANNER, '', PROSE].join('\n'), [], 12), BANNER);
  });
  it('prefers the one-line banner over user-typed text below it (#73)', () => {
    assert.equal(findRateLimitMessage([BANNER, '', TYPED].join('\n'), [], 12), BANNER);
  });
  it('prefers the banner over SEVERAL reset-shaped prose lines below it (#73)', () => {
    // The realistic shape of the report: the model says it, then the user asks about it.
    // With one prose line any "is a limit nearby" rule looks like it works; with two, a
    // rule that lets prose qualify itself is exposed.
    assert.equal(findRateLimitMessage([BANNER, '', PROSE, TYPED].join('\n'), [], 12), BANNER);
  });
  it('prose carrying BOTH a limit phrase and a retry hint cannot outrank the banner', () => {
    // Self-vouching: this line satisfies the limit and reset vocabularies at once, so any
    // rule keyed on vocabulary rather than position accepts it.
    const selfVouching = "⏺ You've hit your usage limit, so try again in 2 minutes.";
    assert.equal(findRateLimitMessage([BANNER, '', selfVouching].join('\n'), [], 12), BANNER);
  });
  it('prefers the multi-line render over prose below it (#73)', () => {
    const text = ["⚠ You've hit your limit", '· resets 3pm (UTC)', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '· resets 3pm (UTC)');
  });
  it('still resolves the multi-line render with nothing below it', () => {
    const text = ["⚠ You've hit your limit", '· resets 3pm (UTC)'].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '· resets 3pm (UTC)');
  });
  it('still returns standalone terse API wording with no banner in sight', () => {
    assert.equal(findRateLimitMessage('Please try again in 5 hours', [], 12), 'Please try again in 5 hours');
  });
  it('a terse line below a stale banner still wins — freshness is not inverted', () => {
    // The fix must not reach backwards. "Please try again in 15 minutes" leads its line, so
    // it is eligible and, being lower, it is the live one.
    const text = ["You've hit your limit · resets 11:30am (UTC)", 'output',
      'Please try again in 15 minutes'].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), 'Please try again in 15 minutes');
  });
  it('still returns reset-shaped prose when nothing else presents a reset', () => {
    // Degrade to the historical behavior rather than to null.
    assert.equal(findRateLimitMessage(PROSE, [], 12), PROSE);
  });

  // Freshness, pinned THROUGH the new eligibility pass (prose below, so the pass is what
  // resolves each of these rather than the old bottom-up scan).
  it('a stale banner loses to a fresher banner below it, prose notwithstanding', () => {
    const text = ["You've hit your limit · resets 11:30am (UTC)",
      "You've hit your limit · resets 4:30pm (UTC)", PROSE].join('\n');
    assert.ok(findRateLimitMessage(text, [], 12).includes('4:30pm'));
  });
  it('a stale one-line banner loses to a fresher multi-line render, prose notwithstanding', () => {
    const text = ["You've hit your limit · resets 11:30am (UTC)",
      "⚠ You've hit your limit", '· resets 3pm (UTC)', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '· resets 3pm (UTC)');
  });
  it('the ⎿-prefixed banner from the original report is preferred over prose', () => {
    // The exact render from the incident: Claude Code echoes the banner as a child line.
    const banner = "  ⎿  You've hit your session limit · resets 6:20pm (Europe/London)";
    assert.equal(findRateLimitMessage([banner, '', PROSE].join('\n'), [], 12), banner.trim());
  });
  it('a "rate limit" render is preferred over prose', () => {
    const text = ['Rate limit hit. Resets at 4pm', '', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), 'Rate limit hit. Resets at 4pm');
  });
  it('a render whose limit phrase does NOT lead is still preferred over prose', () => {
    // "Claude usage limit reached…" buries the phrase behind a word, so no allowlist of
    // banner shapes reaches it. The rule is a veto instead: the line says nothing that
    // marks it as conversation, so it stays eligible.
    const text = ['Claude usage limit reached. Resets at 2pm', '', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), 'Claude usage limit reached. Resets at 2pm');
  });
  it('a stale banner never outranks an unrecognised render below it', () => {
    // The freshness inversion an allowlist would introduce, and the reason the rule is a
    // veto. Demoting every render this file doesn't know hands the monitor the stale time —
    // and #70's latch, seeing a parsed result, marks it non-correctable.
    const text = ["You've hit your limit · resets 11:30am (UTC)", 'output',
      'API Error: rate_limit_error, try again in 15 minutes'].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), 'API Error: rate_limit_error, try again in 15 minutes');
  });
  it('a timezone-qualified render is not mistaken for prose', () => {
    // The veto's second signal counts what follows the reset clause; a bare timezone word
    // ("resets 3am NY", the #6 fixture) is furniture, not a sentence carrying on.
    const text = ['5-hour limit reached - resets 3am NY', '', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '5-hour limit reached - resets 3am NY');
  });
  it('a parenthesised timezone does not spend the tail budget', () => {
    // Qualifiers in brackets are furniture whatever their length — "(NZDT, UTC+13)" would
    // otherwise consume the whole budget and veto a real render.
    const banner = 'Rate limit hit. Resets at 11:40pm Auckland (NZDT, UTC+13)';
    assert.equal(findRateLimitMessage([banner, '', PROSE].join('\n'), [], 12), banner);
  });
  it('WRAPPED prose whose continuation line begins with the clause cannot win', () => {
    // tmux capture-pane is unjoined, so a wrapped sentence arrives as its own line — and
    // the wrap can land right before "try again in …", which is then what LEADS the line.
    // The sentence continuing past the clause is what marks it.
    const wrapped = ['⏺ The API told me the window is nearly over and that I should',
      '  try again in 2 minutes, so I will wait for that.'];
    assert.equal(findRateLimitMessage([BANNER, '', ...wrapped].join('\n'), [], 12), BANNER);
  });
  it('WRAPPED prose continuing past a reset time cannot win', () => {
    const wrapped = ['⏺ Your session limit is still live and it',
      '  resets 9:00am tomorrow according to the header.'];
    assert.equal(findRateLimitMessage([BANNER, '', ...wrapped].join('\n'), [], 12), BANNER);
  });
  it('WRAPPED prose ending AT the clause cannot win either', () => {
    // The tail is empty here, so only the full stop marks it — a render never ends in one.
    const wrapped = ['⏺ I checked the header and the limit', '  resets 3pm.'];
    assert.equal(findRateLimitMessage([BANNER, '', ...wrapped].join('\n'), [], 12), BANNER);
  });

  // --- Shapes the veto must NOT claim. Each of these is a real render that the pre-#73
  //     scan returned; demoting one hands the monitor whatever stale line sits above it. ---
  const STALE = "You've hit your limit · resets 11:30am (UTC)";
  it('a banner rendered on a message bullet is not vetoed (#63 fixture)', () => {
    // "API errors render with the same ● glyph but never as `Name(...)`" — test/tool-echo.
    // The bullet marks a line only when what follows it is not a limit or reset clause.
    const live = "● You've hit your session limit · resets 2:10am (Australia/Melbourne)";
    assert.equal(findRateLimitMessage([STALE, 'some output', live].join('\n'), [], 12), live);
  });
  // The bullet exemption is an ALLOWLIST of limit phrasings, so it recognises only the
  // wordings enumerated in BULLET_LEADS_WITH_CLAUSE. Every render below is one this file
  // already treats as real — each phrase comes straight out of LIMIT_PATTERNS — but none
  // of them leads with a phrase the exemption lists, so the bullet condemns them and the
  // STALE banner above wins. That is the freshness inversion the veto is documented as
  // never introducing ("Widening it into 'does this look like a banner I know' is what
  // re-introduces the freshness inversion, one unrecognised render at a time"), reached
  // by narrowing instead. The bullet is the ONLY discriminator: strip it and each line
  // wins, which is what the second assertion pins.
  for (const live of [
    '● Claude usage limit reached · resets 2pm',        // /limit reached/, /usage limit/
    '● Session limit reached · resets 9pm',             // /limit reached/
    '⏺ Your 5-hour limit resets 3pm',                   // /\d+-hour limit/ — not bullet-leading
    "● You're out of extra usage · resets 3pm",         // /out of.*usage/
  ]) {
    it(`a message bullet does not demote a real render: ${live.slice(0, 34)}…`, () => {
      assert.equal(findRateLimitMessage([STALE, 'some output', live].join('\n'), [], 12), live);
      const bare = live.replace(/^[⏺●]\s*/, '');
      assert.equal(findRateLimitMessage([STALE, 'some output', bare].join('\n'), [], 12), bare,
        'without the bullet this same line wins — the bullet is the only discriminator');
    });
  }

  // OPEN — deliberately left red-as-todo rather than fixed, because there is no free answer.
  // SENTENCE_END is load-bearing: dropping it un-vetoes "⏺ You've hit your usage limit, so
  // try again in 2 minutes." (pinned above) and the wrapped-prose case, both of which are
  // renders by every other available signal. Fixing this needs a discriminator that does not
  // exist yet, not a tweak — so it is recorded here as a known demotion rather than papered
  // over. Flip back to `it(` once a signal separating the two is found.
  it.todo('a full stop does not demote a real render', () => {
    // SENTENCE_END vetoes any reset-shaped line ending in .?!, but renders do end in a full
    // stop — the #71 fixture pinned below in this same file is "You've hit your monthly
    // spend limit." A period is punctuation, not evidence of prose, and treating it as the
    // signal hands the monitor the stale line above.
    for (const live of ["You've hit your session limit · resets 5:20pm.",
      "● You've hit your session limit · resets 5:20pm."]) {
      assert.equal(findRateLimitMessage([STALE, 'some output', live].join('\n'), [], 12), live);
      const bare = live.replace(/\.$/, '');
      assert.equal(findRateLimitMessage([STALE, 'some output', bare].join('\n'), [], 12), bare,
        'without the full stop this same line wins — the period is the only discriminator');
    }
  });

  it('a compound duration is not read as a sentence carrying on', () => {
    // The clause matcher stops at the first unit ("resets in 3"), leaving "hours 15 minutes"
    // in the tail — three words, and the whole budget, spent on the duration itself.
    for (const live of ["You've hit your limit · resets in 3 hours 15 minutes",
      'Please try again in 4 hours and 12 minutes']) {
      assert.equal(findRateLimitMessage([STALE, 'output', live].join('\n'), [], 12), live);
    }
  });
  it('a dual-limit render is measured from its last clause, same matcher twice', () => {
    const live = '5-hour limit resets 3pm, weekly limit resets 9am Monday';
    assert.equal(findRateLimitMessage([STALE, 'output', live].join('\n'), [], 12), live);
  });
  it('a separator does not count as one of the tail words', () => {
    for (const live of ['5-hour limit reached · resets 3pm - see above',
      '5-hour limit reached · resets 3pm / 10:30 UTC']) {
      assert.equal(findRateLimitMessage([STALE, 'output', live].join('\n'), [], 12), live);
    }
  });
  it('typed text still loses when the prompt glyph carries no space', () => {
    assert.equal(findRateLimitMessage([BANNER, 'output', '>try again in 2 minutes ok?'].join('\n'), [], 12), BANNER);
  });

  // --- One case per signal, shaped so the other two do not fire: each of these is vetoed
  //     by exactly one of the prompt glyph, the message bullet, and the tail budget. ---
  it('an unpunctuated instruction at the prompt cannot win', () => {
    assert.equal(findRateLimitMessage([BANNER, '', '❯ try again in 5 minutes'].join('\n'), [], 12), BANNER);
  });
  it('an unpunctuated sentence on a message bullet cannot win', () => {
    assert.equal(findRateLimitMessage([BANNER, '', '⏺ It said to try again in 2 minutes'].join('\n'), [], 12), BANNER);
  });
  it('an unpunctuated wrapped continuation cannot win', () => {
    // The wrap lands before the clause and the sentence runs on into the NEXT line, so
    // neither glyph nor full stop is on this one — only the tail marks it.
    const wrapped = ['⏺ Your session limit is still live and it',
      '  resets 9:00am tomorrow according to the header', '  of the transcript'];
    assert.equal(findRateLimitMessage([BANNER, '', ...wrapped].join('\n'), [], 12), BANNER);
  });
  it('a short question at the prompt cannot win', () => {
    // Nothing but the prompt glyph marks this one: the sentence ends at the clause, so the
    // tail signal alone would accept "❯ so it resets 5pm?" as a render.
    const typed = '❯ so it resets 5pm?';
    assert.equal(findRateLimitMessage([BANNER, '', typed].join('\n'), [], 12), BANNER);
  });
  it('a render carrying both clauses is measured from the LAST one', () => {
    // "· resets 3pm … or try again in 5 hours" — measuring the tail from the first clause
    // would read the second as a sentence running on and veto a real banner.
    const banner = "You've hit your limit · resets 3pm (UTC), or try again in 5 hours";
    assert.equal(findRateLimitMessage([banner, '', PROSE].join('\n'), [], 12), banner);
  });
  it('typed text carrying no prompt glyph cannot win', () => {
    // Submitted input re-renders without ❯ in some layouts; the sentence shape still marks it.
    const typed = 'try again in 2 minutes was what it said, right?';
    assert.equal(findRateLimitMessage([BANNER, '', typed].join('\n'), [], 12), BANNER);
  });
  it('a "5-hour limit" render is preferred over prose', () => {
    const text = ['5-hour limit reached - resets 3pm (Europe/Dublin)', '', PROSE].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '5-hour limit reached - resets 3pm (Europe/Dublin)');
  });
  it('a limit-leading line carrying NO reset time is not eligible', () => {
    // Eligibility needs a reset time to hand to the parser; leading with a limit phrase is
    // not enough, or prose that merely opens with "rate limit …" would be returned and
    // parse to null, discarding the real time above it.
    const text = ["You've hit your limit · resets 4:30pm (UTC)", '', 'rate limit questions are common'].join('\n');
    assert.ok(findRateLimitMessage(text, [], 12).includes('4:30pm'));
  });
  it('works in print mode too, where the scan is unbounded', () => {
    assert.equal(findRateLimitMessage([BANNER, '', PROSE].join('\n'), [], 0), BANNER);
  });
  it('a reset time quoted inside a tool result cannot win the eligibility pass', () => {
    // The tool-echo mask (#63) must still apply to the new pass. The quoted line has to sit
    // BELOW the real one to test anything: put it above and the bottom-up scan reaches the
    // real banner first, so the assertion passes even with the mask disabled.
    const text = ['· resets 4:30pm (UTC)', '● Bash(grep resets)',
      '  ⎿  · resets 9am (UTC)'].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), '· resets 4:30pm (UTC)');
  });

  // tailLines bounds the scan to the same chrome-aware window isRateLimited reads, so a
  // caller that gates on liveness can't then parse a line the gate never saw. The monitor
  // re-derives the wait during a fallback, where an unbounded scan could reach a stale
  // banner high in scrollback and (shorten-only) let the earliest stale time win.
  it('bounds the scan to the content tail when tailLines is set', () => {
    const text = ["You've hit your limit · resets 3pm (UTC)",
      ...Array(14).fill('ordinary content line')].join('\n');
    assert.equal(findRateLimitMessage(text, [], 12), null);        // banner sits above the window
    assert.ok(findRateLimitMessage(text, []).includes('3pm'));     // unbounded still reaches it
  });
  it('still finds a banner inside the tail window', () => {
    const text = ['ordinary content line',
      "You've hit your limit · resets 3pm (UTC)"].join('\n');
    assert.ok(findRateLimitMessage(text, [], 12).includes('3pm'));
  });
  it('tail window skips trailing chrome rather than spending budget on it', () => {
    // The banner is 13 raw lines up but only 1 line of real content up — the chrome-aware
    // window must still reach it, exactly as isRateLimited does.
    const text = ["You've hit your limit · resets 3pm (UTC)",
      ...Array(12).fill('  ◻ a task widget row'), '❯ '].join('\n');
    assert.ok(findRateLimitMessage(text, [], 12).includes('3pm'));
  });
  it('returns the matching line from multiline input', () => {
    const text = 'Some output\n5-hour limit reached - resets 3pm (Europe/Dublin)\nMore output';
    assert.equal(findRateLimitMessage(text), '5-hour limit reached - resets 3pm (Europe/Dublin)');
  });
  it('returns null when no match', () => {
    assert.equal(findRateLimitMessage('normal output\nmore output'), null);
  });
  it('returns the resets line from multi-line TUI render', () => {
    const text = '⚠ You\'ve hit your limit\n· resets 3pm (UTC)';
    assert.equal(findRateLimitMessage(text), '· resets 3pm (UTC)');
  });
  it('returns Resets line when limit and resets on different lines', () => {
    const text = '5-hour limit reached\nResets at 3pm (UTC)';
    assert.ok(findRateLimitMessage(text).includes('3pm'));
  });
  it('returns the most recent resets line when scrollback has a stale one', () => {
    const text = 'You\'ve hit your limit · resets 11:30am (UTC)\nlots of output\nYou\'ve hit your limit · resets 4:30pm (UTC)';
    assert.ok(findRateLimitMessage(text).includes('4:30pm'));
  });
});

describe('org/monthly spend-limit banner (#71)', () => {
  // Team/org accounts (and individuals whose extra-usage budget is exhausted) get a limit
  // banner about the SPEND budget, with NO reset time — both reporters confirmed the
  // underlying 5h block resets and waiting works. Detection is companion-anchored: only
  // the live-region /usage-credits backstop may accept it (no reset line exists to anchor
  // on), so wording about spend limits with real work below stays inert, and the wait it
  // produces downstream is the bounded, correctable fallback.
  const SPEND_ORG = "You've hit your org's monthly spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage";
  const spendRender = [
    SPEND_ORG,
    `  ⎿  ${SPEND_ORG}`,
    "     /usage-credits to finish what you're working on.",
    '', '❯ ',
  ].join('\n');
  it('detects the org spend-limit render (possessive + no reset time)', () => {
    assert.equal(isRateLimited(spendRender, [], 12), true);
  });
  it('detects the individual "monthly spend limit" variant next to its companion', () => {
    const pane = ["You've hit your monthly spend limit.",
      "     /usage-credits to finish what you're working on.", '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
  });
  it('does NOT fire on a stale spend banner with real work below it', () => {
    const pane = [SPEND_ORG, "     /usage-credits to finish what you're working on.",
      ...Array(15).fill('● wrote some code'), '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire on spend-limit wording without the /usage-credits companion', () => {
    const pane = ['the org hit its monthly spend limit yesterday, budget resets on the 1st', '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire on prose EXPLAINING spend limits ending at the prompt', () => {
    // Without a reset-time anchor the only prose defense is the banner shape itself:
    // both real renders start "You've hit …"; explanations reference it mid-sentence.
    const pane = ["⏺ When you hit your org's monthly spend limit, running",
      '/usage-credits raises it from the admin console.', '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('findRateLimitMessage returns the spend line (unparseable → bounded fallback downstream)', () => {
    assert.match(findRateLimitMessage(spendRender, [], 12), /spend limit/i);
  });
});

// --- Usage-meter statusline footer (#61) ---
// A ccusage-style statusline renders a permanent usage meter at the very bottom of the
// pane: "current ●●●●●●●●●● 100%  ⟳ resets in 1 hr 47 min". That row matches
// RESET_PATTERNS ("resets in <n>") and sits BELOW any live banner, so the bottom-up scan
// in findRateLimitMessage returned it instead of the banner — and parseResetTime can't
// read "1 hr 47 min", so the monitor fell back to the 5h default instead of waking at the
// banner's real reset time (observed live in #61).
const CCUSAGE_FOOTER = [
  '  [Fix CI linting] │ Opus 5 (high) │ ●●●●●●○○ ctx:87% │ /Volumes/Webdev/Yamtrack',
  '  current ●●●●●●●●●● 100%  ⟳ resets in 1 hr 47 min',
  '  weekly  ●○○○○○○○○○  10%',
  '  $230.61 ⏱ 59h14m │ diff:+63 -16',
].join('\n');

describe('usage-meter statusline footer (#61)', () => {
  it('findRateLimitMessage prefers the banner over the meter row below it', () => {
    const text = "  ⎿  You've hit your session limit · resets 6:20am (Europe/Brussels)\n\n"
      + CCUSAGE_FOOTER;
    assert.ok(findRateLimitMessage(text).includes('6:20am'),
      `expected the banner, got: ${findRateLimitMessage(text)}`);
  });

  it('the meter row alone does not anchor a limit mention into a detection', () => {
    // Prose ABOUT limits near the bottom must not get its "resets" anchor for free from
    // the permanently-rendered meter row.
    const text = 'I checked and you have not hit your usage limit yet.\n\n' + CCUSAGE_FOOTER;
    assert.equal(isRateLimited(text, [], 12), false);
  });

  it('prefers the banner over other statusline layout variants ("⌛ Resets at …")', () => {
    // ccusage layouts differ across versions/configs; the countdown glyph varies too.
    const text = "  ⎿  You've hit your session limit · resets 6:20am (Europe/Brussels)\n\n"
      + '  💰 $12.34 session │ ⌛ Resets at 15:00\n';
    assert.ok(findRateLimitMessage(text).includes('6:20am'),
      `expected the banner, got: ${findRateLimitMessage(text)}`);
  });

  it('still detects a real banner sitting above the full statusline footer', () => {
    const text = "You've hit your session limit · resets 6:20am (Europe/Brussels)\n"
      + '     /upgrade to increase your usage limit.\n\n' + CCUSAGE_FOOTER;
    assert.equal(isRateLimited(text, [], 12), true);
  });
});

describe('isRateLimitOptionsPrompt (#19)', () => {
  it('detects the menu with "Upgrade" highlighted first', () => {
    assert.equal(isRateLimitOptionsPrompt(MENU_UPGRADE_FIRST), true);
  });
  it('detects the menu with "Stop and wait" highlighted first', () => {
    assert.equal(isRateLimitOptionsPrompt(MENU_WAIT_FIRST), true);
  });
  it('detects through ANSI codes', () => {
    assert.equal(isRateLimitOptionsPrompt('\x1b[1mWhat do you want to do?\x1b[0m\n❯ 1. Stop and wait for limit to reset'), true);
  });
  it('returns false for a plain rate-limit banner (no menu)', () => {
    assert.equal(isRateLimitOptionsPrompt("You've hit your limit · resets 3pm (UTC)"), false);
  });
  it('returns false for normal output', () => {
    assert.equal(isRateLimitOptionsPrompt('What do you want to do? Build a feature?'), false);
  });
});

describe('isRateLimitOptionsPrompt / menuStepsToWaitOption chrome-aware (Finding 5)', () => {
  // A live menu pushed up by a tall widget below it must still be detected — otherwise the
  // menu branch is skipped, a usage-wait is entered, and the later sendKeys types into the
  // open menu where Enter confirms the highlighted default ("Upgrade your plan"). All four
  // detectors must share the chrome-aware window.
  const MENU_BEHIND_WIDGET = [
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    'Enter to confirm · Esc to cancel',
    '',
    '  8 tasks (2 done, 6 open)',
    '  □ a', '  □ b', '  □ c', '  □ d',
    '───────────────',
    '❯ ',
    '───────────────',
    '  ⏵⏵ auto mode on',
  ].join('\n');
  it('detects a live menu pushed up by a widget below it (tail-scoped)', () => {
    assert.equal(isRateLimitOptionsPrompt(MENU_BEHIND_WIDGET, 6), true);
  });
  it('counts steps to the wait option on a menu behind a widget (tail-scoped)', () => {
    assert.equal(menuStepsToWaitOption(MENU_BEHIND_WIDGET, 6), 1);
  });
  it('still ignores a menu only quoted above live work (tail-scoped)', () => {
    const pane = [...MENU_UPGRADE_FIRST.split('\n'), ...Array(10).fill('● unrelated work'), '❯ '].join('\n');
    assert.equal(isRateLimitOptionsPrompt(pane, 6), false);
  });
});

describe('menuStepsToWaitOption (#19)', () => {
  it('returns +1 when "Stop and wait" is one below the cursor (Upgrade first)', () => {
    assert.equal(menuStepsToWaitOption(MENU_UPGRADE_FIRST), 1);
  });
  it('returns 0 when "Stop and wait" is already highlighted', () => {
    assert.equal(menuStepsToWaitOption(MENU_WAIT_FIRST), 0);
  });
  it('returns -1 when "Stop and wait" is above the cursor', () => {
    const text = ['What do you want to do?', '  1. Stop and wait for limit to reset', '❯ 2. Upgrade your plan'].join('\n');
    assert.equal(menuStepsToWaitOption(text), -1);
  });
  it('returns null when there is no cursor to anchor on', () => {
    const text = ['What do you want to do?', '  1. Upgrade your plan', '  2. Stop and wait for limit to reset'].join('\n');
    assert.equal(menuStepsToWaitOption(text), null);
  });
  it('returns null when no menu options are present', () => {
    assert.equal(menuStepsToWaitOption('just some text'), null);
  });
});

describe('isRateLimited (multi-line TUI renders)', () => {
  it('detects limit + resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your limit\n· resets 3pm (UTC)'));
  });
  it('detects box-drawing TUI format', () => {
    const text = '╭──────────╮\n│ ⚠ You\'ve hit your limit │\n│ · resets 3pm │\n╰──────────╯';
    assert.ok(isRateLimited(text));
  });
  it('detects 5-hour limit + Resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ 5-hour limit reached\nResets at 3pm (UTC)'));
  });
  it('detects middle-dot separated multi-line', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your 5-hour limit\n· resets 3pm (Asia/Tbilisi)'));
  });
  it('rejects limit + resets too far apart (>6 lines)', () => {
    assert.equal(isRateLimited('hit your limit\n1\n2\n3\n4\n5\n6\n7\nresets 3pm'), false);
  });
  it('rejects normal output with no rate limit keywords', () => {
    assert.equal(isRateLimited('Working on your request\nHere is the code\nDone'), false);
  });
});

describe('stripAnsi (OSC sequences)', () => {
  it('strips OSC hyperlinks (\\x1b]8;;url\\x1b\\\\)', () => {
    const input = '\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), 'click here');
  });
  it('strips OSC window title (\\x1b]0;title\\x07)', () => {
    assert.equal(stripAnsi('\x1b]0;My Terminal\x07hello'), 'hello');
  });
  it('strips OSC + CSI mixed sequences', () => {
    const input = '\x1b]8;;url\x1b\\\x1b[33m5-hour limit reached - resets 3pm\x1b[0m\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), '5-hour limit reached - resets 3pm');
  });
  it('rate limit detection works through OSC hyperlinks', () => {
    const input = '\x1b]8;;link\x1b\\5-hour limit reached\x1b]8;;\x1b\\ - resets 3pm';
    assert.ok(isRateLimited(input));
  });
});
