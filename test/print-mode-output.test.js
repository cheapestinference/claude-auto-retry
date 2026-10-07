import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIG = 1024 * 1024;   // well past the 64 KiB a pipe holds

// Print mode buffers claude's output and writes it once claude is done. Two races cut it
// off at 64 KiB when stdout is a pipe (`--output-format stream-json` into a harness):
// resolving on the child's 'exit', which can fire before its stdout pipe has drained, and
// calling process.exit() right after process.stdout.write(), which drops whatever has not
// flushed yet (pipe writes are asynchronous on macOS).
describe('print mode passes large output through intact', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-output-'));
    await mkdir(join(dir, 'home'), { recursive: true });
    await writeFile(join(dir, 'home', '.claude-auto-retry.json'), JSON.stringify({}));
    // Stub claude: 1 MiB on stdout and on stderr, each followed by an end marker.
    await writeFile(join(dir, 'claude'), [
      '#!/bin/sh',
      `head -c ${BIG} /dev/zero | tr '\\0' 'o'`,
      'echo END-OUT',
      `head -c ${BIG} /dev/zero | tr '\\0' 'e' >&2`,
      'echo END-ERR >&2',
      'exit 3',
    ].join('\n'));
    await chmod(join(dir, 'claude'), 0o755);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  function runLauncher() {
    const env = { ...process.env, HOME: join(dir, 'home'), PATH: `${dir}:${process.env.PATH}` };
    delete env.CLAUDE_AUTO_RETRY_ACTIVE;   // dev boxes running inside a wrapped session
    const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'launcher.js'), '-p', 'go'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    return new Promise((resolve) => child.on('close', (code) => resolve({
      code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(),
    })));
  }

  it('writes all of claude\'s stdout and stderr and keeps its exit code', async () => {
    const r = await runLauncher();
    assert.equal(r.stdout.length, BIG + 'END-OUT\n'.length);
    assert.ok(r.stdout.endsWith('END-OUT\n'), 'stdout cut off before the end marker');
    assert.equal(r.stderr.length, BIG + 'END-ERR\n'.length);
    assert.ok(r.stderr.endsWith('END-ERR\n'), 'stderr cut off before the end marker');
    assert.equal(r.code, 3);
  });
});
