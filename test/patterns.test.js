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
