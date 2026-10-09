import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorState, processOneTick, ACCOUNT_SETTLE_MS, ACCOUNT_CHANGE_RECENT_MS } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { isRateLimited } from '../src/patterns.js';
import { claudeConfigPath, createAccountReader } from '../src/account.js';
import { waitForResetOrSwitch, ACCOUNT_POLL_MS } from '../src/launcher.js';

// A real 50-row capture (Claude Code 2.1.289, project text replaced): a weekly limit hit
// inside a collapsed tool group, then an account switcher (claude-swap's `cswap auto`) moved
// the machine to another account, so Remote Control printed its "account changed" notice,
// and an update notice appeared on the row above the input box. The waiting monitor
// dropped its 5-day wait as "user continued" without sending anything; the session sat idle.
const blank = (n) => Array(n).fill('');
// The weekly reset, five days out from whenever the suite runs: a fixed date ("Oct 9") makes
// the multi-day wait below a time bomb.
const RESET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', month: 'short', day: 'numeric' })
  .format(new Date(Date.now() + 5 * 24 * 3600_000));
const RULE = '─'.repeat(196);
// The rule above the input box carries the session's name when it has one (--name, /rename).
const NAMED_RULE = `${'─'.repeat(185)} agent-3 ─`;
const SWITCHED_PANE = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.289',
  '▝▜██████▀  Opus 5.5 with high effort · Claude Pro',
  ' ▝▝   ▝▝   ~/projects/app · /rc failed',
  '', '',
  '❯ Work through the open issues in this repo.',
  '',
  '⏺ Claimed issue #2 (sandboxing). Reading the code now.',
  '',
  '  Ran 2 shell commands',
  '',
  '⏺ Docker is available, so I can test the sandbox inside a container.',
  '',
  '  Ran 3 shell commands',
  `  ⎿  You've hit your weekly limit · resets ${RESET_DAY} at 6am (Europe/London)`,
  '     /upgrade to increase your usage limit.',
  '',
  '✻ Worked for 1m 46s · done 3:38',
  '',
  '⏺ Remote Control disconnected — signed-in claude.ai account or organization changed on this machine — run /remote-control to start a session for the current account, or /login to switch back,',
  '  then /remote-control',
  ...blank(10),
  `${' '.repeat(160)}✔ Update installed · Restart to update`,
  NAMED_RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  '',
].join('\n');

// The same session at the moment it hit the limit, before the switch.
const LIMIT_PANE = SWITCHED_PANE.split('\n').filter((l) =>
  !/Remote Control disconnected|then \/remote-control|Update installed/.test(l)).join('\n');

const NEW_ACCOUNT_LIMIT_PANE = LIMIT_PANE.replace(
  '/upgrade to increase your usage limit.',
  "/upgrade to increase your usage limit.\n\n❯ continue\n  ⎿  You've hit your session limit · resets 4pm (Europe/London)",
);

function mockTmux(content, { foreground = true } = {}) {
  const t = {
    _sent: [],
    content,
    capturePane: async () => t.content,
    getPaneCommand: async () => (foreground ? 'node' : 'vim'),
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => foreground,
  };
  return t;
}

// The session mid-turn, before any limit.
const WORKING_PANE = LIMIT_PANE.split('\n').filter((l) =>
  !/hit your weekly limit|\/upgrade to increase/.test(l)).join('\n');

// Age the last account change by `ms`, as if that much time had passed since it was seen.
const age = (s, ms) => { s._accountChange.at -= ms; };

const tick = (s, t, account) => processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, Math.random, () => account);

async function waitingOn(account) {
  const s = createMonitorState();
  const t = mockTmux(LIMIT_PANE);
  assert.equal(await tick(s, t, account), 'waiting');
  assert.ok(s.waitUntil > Date.now() + 24 * 3600_000, 'a multi-day weekly wait');
  return { s, t };
}

describe('account switch during a usage-limit wait', () => {
  it('keeps the banner in view: a named input-box rule is chrome', () => {
    assert.equal(isRateLimited(SWITCHED_PANE, [], 12), true);
  });

  it('keeps waiting when the account has not changed', async () => {
    const { s, t } = await waitingOn('acct-a/org-a');
    t.content = SWITCHED_PANE;
    assert.equal(await tick(s, t, 'acct-a/org-a'), 'waiting');
    assert.deepEqual(t._sent, []);
  });

  it('retries once the account change has settled', async () => {
    const { s, t } = await waitingOn('acct-a/org-a');
    t.content = SWITCHED_PANE;
    // Claude Code may still hold the old credential (macOS Keychain cache): not yet.
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.deepEqual(t._sent, []);
    age(s, ACCOUNT_SETTLE_MS);
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'retried-account-switch');
    assert.deepEqual(t._sent, [DEFAULT_CONFIG.retryMessage]);
    assert.equal(s.status, 'waiting');
  });

  it('waits on the new account\'s own reset if it is limited too', async () => {
    const { s, t } = await waitingOn('acct-a/org-a');
    t.content = SWITCHED_PANE;
    await tick(s, t, 'acct-b/org-b');
    age(s, ACCOUNT_SETTLE_MS);
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'retried-account-switch');
    t.content = NEW_ACCOUNT_LIMIT_PANE;
    s.waitUntil = Date.now() - 1;   // the post-send cooldown has passed
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.match(s.lastRateLimitMessage, /session limit · resets 4pm/);
    assert.ok(s.waitUntil > Date.now() && s.waitUntil < Date.now() + 24 * 3600_000);
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.equal(t._sent.length, 1, 'no second blind retry');
  });

  it('retries when the switch landed just before the limit was seen', async () => {
    // At a ~100% switch threshold the switcher acts on the same exhaustion Claude hits: it
    // can move the machine to the other account before the monitor reads the banner.
    const s = createMonitorState();
    const t = mockTmux(WORKING_PANE);
    await tick(s, t, 'acct-a/org-a');
    t.content = LIMIT_PANE;
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.equal(s._waitAccount, 'acct-a/org-a', 'the limit is the previous account\'s');
    assert.deepEqual(t._sent, []);
    age(s, ACCOUNT_SETTLE_MS);
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'retried-account-switch');
    assert.deepEqual(t._sent, [DEFAULT_CONFIG.retryMessage]);
  });

  it('does not blame a limit on an account switch from long before', async () => {
    const s = createMonitorState();
    const t = mockTmux(WORKING_PANE);
    await tick(s, t, 'acct-a/org-a');
    await tick(s, t, 'acct-b/org-b');
    age(s, ACCOUNT_CHANGE_RECENT_MS + 1);
    t.content = LIMIT_PANE;
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.equal(s._waitAccount, 'acct-b/org-b');
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.deepEqual(t._sent, []);
  });

  it('does not type into a session that is already working', async () => {
    const { s, t } = await waitingOn('acct-a/org-a');
    t.content = LIMIT_PANE + '\n✻ Cogitating… (esc to interrupt)';
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'user-continued');
    assert.deepEqual(t._sent, []);
  });

  it('does not type when Claude is not in the foreground', async () => {
    const { s } = await waitingOn('acct-a/org-a');
    const t = mockTmux(SWITCHED_PANE, { foreground: false });
    await tick(s, t, 'acct-b/org-b');
    age(s, ACCOUNT_SETTLE_MS);
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'skipped-not-claude');
    assert.deepEqual(t._sent, []);
  });

  it('ignores an unreadable account (no config, logged out)', async () => {
    const { s, t } = await waitingOn(null);
    t.content = SWITCHED_PANE;
    assert.equal(await tick(s, t, 'acct-b/org-b'), 'waiting');
    assert.equal(await tick(s, t, null), 'waiting');
    assert.deepEqual(t._sent, []);
  });
});

describe('createAccountReader', () => {
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'car-account-')); path = join(dir, '.claude.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (oauthAccount, mtime) => {
    writeFileSync(path, JSON.stringify({ projects: {}, oauthAccount }));
    if (mtime) utimesSync(path, mtime, mtime);
  };

  it('reads account and organization from .claude.json', () => {
    write({ accountUuid: 'a1', organizationUuid: 'o1', emailAddress: 'x@y' });
    assert.equal(createAccountReader(path)(), 'a1/o1');
  });

  it('returns null without a file, an oauthAccount or valid JSON', () => {
    assert.equal(createAccountReader(path)(), null);
    writeFileSync(path, '{"projects":{}}');
    assert.equal(createAccountReader(path)(), null);
    writeFileSync(path, '{not json');
    assert.equal(createAccountReader(path)(), null);
  });

  it('re-reads only when the file changes', () => {
    write({ accountUuid: 'a1', organizationUuid: 'o1' }, 1_000);
    const read = createAccountReader(path);
    assert.equal(read(), 'a1/o1');
    write({ accountUuid: 'a2', organizationUuid: 'o2' }, 2_000);
    assert.equal(read(), 'a2/o2');
  });

  it('follows CLAUDE_CONFIG_DIR like Claude Code', () => {
    assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg/.claude.json');
    assert.match(claudeConfigPath({}), /\.claude\.json$/);
  });
});

describe('waitForResetOrSwitch (print mode)', () => {
  // A fake clock: sleep advances it, and the account the reader returns is scripted by time.
  const clock = (accountAt) => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => { t += ms; },
      readAccount: () => accountAt(t),
      elapsed: () => t,
    };
  };
  const HOUR = 3600_000;

  it('sleeps the whole wait when the account never changes', async () => {
    const c = clock(() => 'a/o');
    assert.equal(await waitForResetOrSwitch(HOUR, 'a/o', c), 'reset');
    assert.equal(c.elapsed(), HOUR);
  });

  it('retries once a switch has held for the settle time, not before', async () => {
    const c = clock((t) => (t >= 60_000 ? 'b/o' : 'a/o'));
    assert.equal(await waitForResetOrSwitch(HOUR, 'a/o', c), 'switched');
    assert.ok(c.elapsed() >= 60_000 + ACCOUNT_SETTLE_MS, `elapsed ${c.elapsed()}`);
    assert.ok(c.elapsed() < 60_000 + ACCOUNT_SETTLE_MS + ACCOUNT_POLL_MS * 2, `elapsed ${c.elapsed()}`);
  });

  it('ignores a switch that is reverted before it settles', async () => {
    const c = clock((t) => (t >= 60_000 && t < 80_000 ? 'b/o' : 'a/o'));
    assert.equal(await waitForResetOrSwitch(10 * 60_000, 'a/o', c), 'reset');
  });

  it('treats an unreadable account as no change', async () => {
    const c = clock(() => null);
    assert.equal(await waitForResetOrSwitch(10 * 60_000, 'a/o', c), 'reset');
  });

  it('an unreadable read mid-switch does not restart the settle clock', async () => {
    const c = clock((t) => (t < 60_000 ? 'a/o' : t === 70_000 ? null : 'b/o'));
    assert.equal(await waitForResetOrSwitch(HOUR, 'a/o', c), 'switched');
    assert.ok(c.elapsed() < 60_000 + ACCOUNT_SETTLE_MS + ACCOUNT_POLL_MS * 2);
  });

  it('is a plain sleep when no account was known at launch', async () => {
    const c = clock(() => 'b/o');
    assert.equal(await waitForResetOrSwitch(10 * 60_000, null, c), 'reset');
    assert.equal(c.elapsed(), 10 * 60_000);
  });
});
