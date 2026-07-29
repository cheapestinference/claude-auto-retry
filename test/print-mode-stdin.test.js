import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A piped prompt (`cat doc.md | claude -p`) is read to EOF by the FIRST attempt when
// stdin is inherited. After a rate-limit retry, the second claude then runs with an
// empty prompt — the retry silently produces a wrong answer. The launcher must buffer
// piped stdin once and re-feed it to every attempt.
describe('print-mode retry re-feeds piped stdin', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-stdin-'));
    await mkdir(join(dir, 'home'), { recursive: true });
    // Instant retry: relative reset "0 minutes" + no margin.
    await writeFile(join(dir, 'home', '.claude-auto-retry.json'),
      JSON.stringify({ marginSeconds: 0, maxRetries: 2 }));
    // Stub claude: consumes stdin like the real `claude -p`. Run 1 prints a rate-limit
    // banner; run 2 echoes what it received on stdin.
    await writeFile(join(dir, 'claude'), [
      '#!/bin/sh',
      `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
      `n=$((n+1)); echo $n > "${dir}/count"`,
      'input=$(cat)',
      'if [ "$n" = "1" ]; then',
      '  echo "rate limit"',
      '  echo "try again in 0 minutes"',
      'else',
      '  echo "GOT:[$input]"',
      'fi',
    ].join('\n'));
    await chmod(join(dir, 'claude'), 0o755);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('the retry attempt receives the original piped prompt', () => {
    const env = { ...process.env, HOME: join(dir, 'home'), PATH: `${dir}:${process.env.PATH}` };
    delete env.CLAUDE_AUTO_RETRY_ACTIVE;   // dev boxes running inside a wrapped session
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'src', 'launcher.js'), '-p', 'go'], {
      env, input: 'the important prompt', encoding: 'utf-8', timeout: 30_000,
    });
    assert.match(out, /GOT:\[the important prompt\]/);
  });
});
