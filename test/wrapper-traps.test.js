import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The wrapper must not clobber a user's INT/TERM traps. `trap -p` is a bashism: in zsh
// it SETS a handler for the literal signal "-p"-ish args instead of printing, and $( )
// runs in a subshell where zsh lists no traps anyway — so the capture was silently empty
// and the "restore" line reset the user's traps to default. zsh path now uses native
// localtraps; bash keeps trap -p. Runs against whatever zsh is on PATH (or $ZSH_BIN);
// skips if none.
describe('wrapper.sh preserves user INT/TERM traps', () => {
  let dir, rc;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-traps-'));
    const template = (await readFile(join(REPO_ROOT, 'src', 'wrapper.sh'), 'utf-8'));
    // Stub launcher: exits cleanly so the wrapper's post-run path executes.
    const launcher = join(dir, 'launcher.js');
    await writeFile(launcher, 'process.exit(0)');
    rc = join(dir, 'rc.sh');
    await writeFile(rc, template.replace(/__LAUNCHER_PATH__/g, launcher));
    await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
    await chmod(join(dir, 'claude'), 0o755);
  });

  const script = () => [
    `PATH="${dir}:$PATH"`,
    `source ${rc}`,
    'trap \'echo "USER INT CLEANUP"\' INT',
    'trap \'echo "USER TERM CLEANUP"\' TERM',
    'claude --version >/dev/null 2>&1',
    'trap',
  ].join('; ');

  const cleanEnv = () => {
    const env = { ...process.env };
    delete env.CLAUDE_AUTO_RETRY_ACTIVE;   // dev boxes running inside a wrapped session
    return env;
  };

  it('bash: traps intact after a wrapped run', () => {
    const out = execFileSync('bash', ['-c', script()], { env: cleanEnv(), encoding: 'utf-8' });
    assert.match(out, /USER INT CLEANUP/);
    assert.match(out, /USER TERM CLEANUP/);
  });

  it('zsh: traps intact after a wrapped run (trap -p is a bashism)', (t) => {
    const zsh = process.env.ZSH_BIN || 'zsh';
    try { execFileSync(zsh, ['-c', 'true']); } catch { return t.skip('no zsh available'); }
    const out = execFileSync(zsh, ['-c', script()], { env: cleanEnv(), encoding: 'utf-8' });
    assert.match(out, /USER INT CLEANUP/);
    assert.match(out, /USER TERM CLEANUP/);
  });
});
