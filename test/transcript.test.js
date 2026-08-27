import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug, transcriptPathFor, readLatestUsageLimitLine } from '../src/transcript.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('projectSlug', () => {
  // Verified against a real Claude Code install: every run of non-alphanumeric
  // characters in the cwd becomes a single "-".
  it('maps a simple path', () => {
    assert.equal(projectSlug('/home/ubuntu/claude-auto-retry'), '-home-ubuntu-claude-auto-retry');
  });
  it('maps each of two adjacent separators to its own dash (no collapsing)', () => {
    assert.equal(projectSlug('/home/u/.claude'), '-home-u--claude');
  });
});

describe('transcriptPathFor', () => {
  it('joins configDir/projects/<slug>/<sessionId>.jsonl', () => {
    assert.equal(
      transcriptPathFor('/home/u/proj', 'abc-123', '/home/u/.claude'),
      join('/home/u/.claude', 'projects', '-home-u-proj', 'abc-123.jsonl'),
    );
  });
});

describe('readLatestUsageLimitLine', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'car-transcript-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeTranscript(cwd, sessionId, lines) {
    const slugDir = join(dir, 'projects', projectSlug(cwd));
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${sessionId}.jsonl`), lines.join('\n'));
    return join(slugDir, `${sessionId}.jsonl`);
  }

  // Fixture: a single real record captured off this machine's own ~/.claude/projects
  // (session_id/cwd sanitized to generic placeholders; the record shape, field names, and
  // the literal UTF-8 "·" in the reset text are otherwise byte-for-byte as written by
  // Claude Code 2.1.233). Guards against the JSONL shape drifting from what we assume —
  // a synthetic fixture built from our own field-name guesses can't catch that.
  it('reads a real Claude Code isApiErrorMessage record via transcript_path', async () => {
    const fixture = join(FIXTURES_DIR, 'transcript-rate-limit-record.jsonl');
    const line = await readLatestUsageLimitLine({ transcript_path: fixture });
    assert.match(line, /"error":"rate_limit"/);
    assert.match(line, /You've hit your weekly limit · resets Aug 21 at 3pm \(Australia\/Brisbane\)/);
  });

  it('prefers transcript_path over reconstructing cwd/session_id, even when they diverge', async () => {
    const fixture = join(FIXTURES_DIR, 'transcript-rate-limit-record.jsonl');
    // A deliberately wrong cwd/session_id (the scenario in the PR review: the session's
    // cwd at marker time differs from the transcript's actual directory) must not stop
    // transcript_path from being read directly.
    const line = await readLatestUsageLimitLine({
      transcript_path: fixture, cwd: '/nonexistent/wrong-dir', session_id: 'wrong-session',
    });
    assert.match(line, /resets Aug 21 at 3pm/);
  });

  it('falls back to cwd/session_id reconstruction when transcript_path is absent', async () => {
    await writeTranscript('/home/u/a', 'sess-1', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, text: "You've hit your session limit · resets 2:10am (Australia/Melbourne)" }),
      JSON.stringify({ type: 'user', message: { content: 'continue' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, text: "You've hit your session limit · resets 4:30pm (Australia/Melbourne)" }),
    ]);
    const line = await readLatestUsageLimitLine({ cwd: '/home/u/a', session_id: 'sess-1' }, dir);
    assert.match(line, /resets 4:30pm/);
  });

  it('returns null when neither transcript_path nor cwd/session_id resolve a file', async () => {
    assert.equal(await readLatestUsageLimitLine({ cwd: '/home/u/nope', session_id: 'sess-x' }, dir), null);
    assert.equal(await readLatestUsageLimitLine({ transcript_path: join(dir, 'nope.jsonl') }), null);
  });

  it('returns null when no record carries isApiErrorMessage', async () => {
    await writeTranscript('/home/u/b', 'sess-2', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'all good' } }),
    ]);
    assert.equal(await readLatestUsageLimitLine({ cwd: '/home/u/b', session_id: 'sess-2' }, dir), null);
  });

  it('returns null when the marker carries neither transcript_path nor cwd/session_id', async () => {
    assert.equal(await readLatestUsageLimitLine({}), null);
    assert.equal(await readLatestUsageLimitLine({ cwd: '/home/u/a' }), null);
    assert.equal(await readLatestUsageLimitLine({ session_id: 'sess-1' }), null);
  });
});
