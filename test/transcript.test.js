import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, transcriptPathFor, readLatestUsageLimitLine } from '../src/transcript.js';

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
  }

  it('returns the LAST isApiErrorMessage record when several are present', async () => {
    await writeTranscript('/home/u/a', 'sess-1', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, text: "You've hit your session limit · resets 2:10am (Australia/Melbourne)" }),
      JSON.stringify({ type: 'user', message: { content: 'continue' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, text: "You've hit your session limit · resets 4:30pm (Australia/Melbourne)" }),
    ]);
    const line = await readLatestUsageLimitLine('/home/u/a', 'sess-1', dir);
    assert.match(line, /resets 4:30pm/);
  });

  it('returns null when the transcript file does not exist', async () => {
    assert.equal(await readLatestUsageLimitLine('/home/u/nope', 'sess-x', dir), null);
  });

  it('returns null when no record carries isApiErrorMessage', async () => {
    await writeTranscript('/home/u/b', 'sess-2', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'all good' } }),
    ]);
    assert.equal(await readLatestUsageLimitLine('/home/u/b', 'sess-2', dir), null);
  });

  it('returns null when cwd or sessionId is missing', async () => {
    assert.equal(await readLatestUsageLimitLine(null, 'sess-1', dir), null);
    assert.equal(await readLatestUsageLimitLine('/home/u/a', null, dir), null);
  });
});
