import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRetryableError, isUsageLimitError, writeStopFailureEvent, readStopFailureEvent, clearStopFailureEvent,
} from '../src/events.js';
import { readLatestUsageLimitLine } from '../src/transcript.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('isRetryableError', () => {
  it('accepts the transient-overload classes', () => {
    for (const e of ['overloaded', 'server_error', 'OVERLOADED']) {
      assert.equal(isRetryableError(e), true, e);
    }
  });
  it('rejects rate_limit (a session/usage limit is an hours-scale wait, not an overload)', () => {
    // Regression: routing rate_limit through the event/overload path made the monitor
    // fire futile seconds-scale "Continue" retries into a session-limited pane and fight
    // the scraper usage-wait path. Session limits are owned by the scraper usage path.
    assert.equal(isRetryableError('rate_limit'), false);
  });
  it('rejects permanent / unknown classes', () => {
    for (const e of ['authentication_failed', 'billing_error', 'invalid_request', '', undefined, null, 42]) {
      assert.equal(isRetryableError(e), false, String(e));
    }
  });
});

describe('isUsageLimitError', () => {
  it('accepts rate_limit (case-insensitive)', () => {
    for (const e of ['rate_limit', 'RATE_LIMIT']) {
      assert.equal(isUsageLimitError(e), true, e);
    }
  });
  it('rejects the overload classes and permanent/unknown classes', () => {
    for (const e of ['overloaded', 'server_error', 'authentication_failed', '', undefined, null, 42]) {
      assert.equal(isUsageLimitError(e), false, String(e));
    }
  });
});

describe('StopFailure event markers', () => {
  let dir, savedTmux, savedSock;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-ev-'));
    savedTmux = process.env.TMUX; savedSock = process.env.CLAUDE_AUTO_RETRY_SOCKET;
    delete process.env.TMUX; delete process.env.CLAUDE_AUTO_RETRY_SOCKET;
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    if (savedSock !== undefined) process.env.CLAUDE_AUTO_RETRY_SOCKET = savedSock;
  });

  it('round-trips a pane-keyed marker', async () => {
    await writeStopFailureEvent('%2', { error: 'overloaded', session_id: 'abc' }, dir);
    const ev = await readStopFailureEvent('%2', 60_000, dir);
    assert.equal(ev.error, 'overloaded');
    assert.equal(ev.pane, '%2');
    assert.equal(ev.session_id, 'abc');
    assert.equal(typeof ev.ts, 'number');
  });

  it('round-trips the cwd from the hook envelope (needed to resolve the transcript for a rate_limit marker)', async () => {
    await writeStopFailureEvent('%6', { error: 'rate_limit', session_id: 'abc', cwd: '/home/u/proj' }, dir);
    const ev = await readStopFailureEvent('%6', 60_000, dir);
    assert.equal(ev.cwd, '/home/u/proj');
  });

  it('round-trips transcript_path from the hook envelope (the field readLatestUsageLimitLine prefers over cwd/session_id reconstruction)', async () => {
    await writeStopFailureEvent('%10', { error: 'rate_limit', session_id: 'abc', cwd: '/home/u/proj', transcript_path: '/home/u/.claude/projects/-home-u-proj/abc.jsonl' }, dir);
    const ev = await readStopFailureEvent('%10', 60_000, dir);
    assert.equal(ev.transcript_path, '/home/u/.claude/projects/-home-u-proj/abc.jsonl');
  });

  it('defaults transcript_path to null when absent', async () => {
    await writeStopFailureEvent('%11', { error: 'rate_limit', session_id: 'abc', cwd: '/home/u/proj' }, dir);
    const ev = await readStopFailureEvent('%11', 60_000, dir);
    assert.equal(ev.transcript_path, null);
  });

  // End-to-end regression (Aug 26 review): a marker built by hand with transcript_path set
  // (as transcript.test.js does) proves nothing about the real pipeline — writeStopFailureEvent
  // was silently dropping the hook payload's transcript_path, so the cwd-vs-launch-dir fix
  // never reached production. This drives the full write -> read -> resolve chain with a
  // deliberately wrong cwd/session_id, so only transcript_path can make it resolve.
  it('carries transcript_path through the full write -> read -> resolve chain even when cwd/session_id are wrong', async () => {
    const fixture = join(FIXTURES_DIR, 'transcript-rate-limit-record.jsonl');
    await writeStopFailureEvent('%12', {
      error: 'rate_limit',
      session_id: 'wrong-session',
      cwd: '/nonexistent/wrong-dir',
      transcript_path: fixture,
    }, dir);
    const ev = await readStopFailureEvent('%12', 60_000, dir);
    const line = await readLatestUsageLimitLine(ev);
    assert.match(line, /resets Aug 21 at 3pm/);
  });

  it('defaults cwd to null when absent', async () => {
    await writeStopFailureEvent('%8', { error: 'overloaded' }, dir);
    const ev = await readStopFailureEvent('%8', 60_000, dir);
    assert.equal(ev.cwd, null);
  });

  it('sanitizes the pane id into the filename, prefixed by a socket key', async () => {
    await writeStopFailureEvent('%7', { error: 'server_error' }, dir);
    const files = await readdir(dir);
    // No TMUX/CLAUDE_AUTO_RETRY_SOCKET in this suite (see before hook) → 'default'.
    assert.ok(files.includes('default__7.json'), files.join(','));
  });

  // --- Pane ids are only unique per tmux server (same collision status files had): a
  //     marker from `tmux -L work`'s %2 must not be consumed by the monitor watching the
  //     default server's %2 — it would act on another session's failure and the real
  //     owner would miss its event. Markers are socket-keyed like status files. ---
  it('a marker written under one socket is invisible to a reader on another', async () => {
    process.env.TMUX = '/tmp/tmux-1000/work,1,0';
    try {
      await writeStopFailureEvent('%2', { error: 'overloaded' }, dir);
      process.env.TMUX = '/tmp/tmux-1000/personal,2,0';
      assert.equal(await readStopFailureEvent('%2', 60_000, dir), null);
      process.env.TMUX = '/tmp/tmux-1000/work,1,0';
      assert.ok(await readStopFailureEvent('%2', 60_000, dir), 'owner still reads it');
      await clearStopFailureEvent('%2', dir);
    } finally { delete process.env.TMUX; }
  });

  it('falls back to a legacy bare-pane marker (hook older than the reader)', async () => {
    await writeFile(join(dir, '_8.json'), JSON.stringify({ pane: '%8', error: 'overloaded', ts: Date.now() }));
    const ev = await readStopFailureEvent('%8', 60_000, dir);
    assert.equal(ev?.error, 'overloaded');
    await clearStopFailureEvent('%8', dir);
    const files = await readdir(dir);
    assert.ok(!files.includes('_8.json'), 'clear() must consume the legacy marker too');
  });

  it('returns null for an absent marker', async () => {
    assert.equal(await readStopFailureEvent('%99', 60_000, dir), null);
  });

  it('treats a marker past maxAge as stale', async () => {
    await writeStopFailureEvent('%3', { error: 'overloaded' }, dir);
    assert.equal(await readStopFailureEvent('%3', -1, dir), null);  // negative age → always stale
  });

  it('ignores an unparseable marker file', async () => {
    await writeFile(join(dir, '_4.json'), 'not json');
    assert.equal(await readStopFailureEvent('%4', 60_000, dir), null);
  });

  it('clear() consumes the marker', async () => {
    await writeStopFailureEvent('%5', { error: 'rate_limit' }, dir);
    await clearStopFailureEvent('%5', dir);
    assert.equal(await readStopFailureEvent('%5', 60_000, dir), null);
  });

  it('write is a no-op without a pane key', async () => {
    assert.equal(await writeStopFailureEvent('', { error: 'overloaded' }, dir), null);
  });
});
