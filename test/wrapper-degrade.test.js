import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// #65: `npm uninstall -g claude-auto-retry` (without `claude-auto-retry uninstall`
// first) deletes launcher.js but leaves the rc-file wrapper pointing at it — every
// `claude` invocation then dies with MODULE_NOT_FOUND. The wrapper must degrade to
// `command claude` when the launcher is gone, so an orphaned wrapper is harmless.
describe('wrapper.sh degrades when the launcher no longer exists (#65)', () => {
  let dir, template;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-wrap-'));
    template = await readFile(join(REPO_ROOT, 'src', 'wrapper.sh'), 'utf-8');
    // Stub `claude` binary on PATH so `command claude` is observable.
    await writeFile(join(dir, 'claude'), '#!/bin/sh\necho REAL-CLAUDE "$@"\n');
    await chmod(join(dir, 'claude'), 0o755);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Strip the wrapped-session flag: when the test suite itself runs inside a
  // claude-auto-retry session, the inherited CLAUDE_AUTO_RETRY_ACTIVE=1 would make
  // the wrapper degrade unconditionally and mask the launcher-exists path.
  function cleanEnv() {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    delete env.CLAUDE_AUTO_RETRY_ACTIVE;
    return env;
  }

  it('falls back to `command claude` when the launcher path is gone', async () => {
    const wrapper = template.replace(/__LAUNCHER_PATH__/g, join(dir, 'nonexistent', 'launcher.js'));
    const rc = join(dir, 'rc-gone.sh');
    await writeFile(rc, wrapper);
    const out = execFileSync('bash', ['-c', `source ${rc}; claude --version`], {
      env: cleanEnv(),
    }).toString();
    assert.match(out, /REAL-CLAUDE --version/);
  });

  it('still routes through the launcher when it exists', async () => {
    const launcher = join(dir, 'launcher.js');
    await writeFile(launcher, 'console.log("VIA-LAUNCHER", process.argv.slice(2).join(" "))');
    const wrapper = template.replace(/__LAUNCHER_PATH__/g, launcher);
    const rc = join(dir, 'rc-ok.sh');
    await writeFile(rc, wrapper);
    const out = execFileSync('bash', ['-c', `source ${rc}; claude --resume`], {
      env: cleanEnv(),
    }).toString();
    assert.match(out, /VIA-LAUNCHER --resume/);
  });
});
