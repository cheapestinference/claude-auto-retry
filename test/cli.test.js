import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { injectWrapper, removeWrapper, MARKER_START, MARKER_END, renderReconcileUnit, renderReconcilePlist } from '../bin/cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Finding 7: the generated systemd unit was fragile — unquoted ExecStart paths broke
//     on spaces, and Persistent=true is a no-op on a monotonic (OnUnitActiveSec) timer. ---
describe('renderReconcileUnit (Finding 7)', () => {
  it('substitutes into the quoted ExecStart so a path with spaces survives', () => {
    const out = renderReconcileUnit(
      'ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile\n',
      '/home/a b/.nvm/node', '/home/a b/cli.js',
    );
    assert.match(out, /ExecStart="\/home\/a b\/\.nvm\/node" "\/home\/a b\/cli\.js" reconcile/);
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped .service template quotes the ExecStart placeholders', async () => {
    const svc = await readFile(join(REPO_ROOT, 'systemd', 'claude-auto-retry-reconcile.service'), 'utf-8');
    assert.match(svc, /ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile/);
  });
  it('the shipped .timer template has no no-op Persistent=true', async () => {
    const timer = await readFile(join(REPO_ROOT, 'systemd', 'claude-auto-retry-reconcile.timer'), 'utf-8');
    assert.ok(!/Persistent\s*=\s*true/.test(timer));
  });
});

describe('renderReconcilePlist (macOS launchd)', () => {
  it('substitutes and XML-escapes the node/CLI paths', () => {
    const out = renderReconcilePlist(
      '<string>__NODE_PATH__</string><string>__CLI_PATH__</string>',
      '/Users/a&b/.nvm/node', '/Users/a<b>/cli.js',
    );
    assert.equal(out, '<string>/Users/a&amp;b/.nvm/node</string><string>/Users/a&lt;b&gt;/cli.js</string>');
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped plist template has the placeholders and detaches monitors from the job', async () => {
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-auto-retry.reconcile.plist'), 'utf-8');
    assert.match(plist, /<string>__NODE_PATH__<\/string>\s*<string>__CLI_PATH__<\/string>\s*<string>reconcile<\/string>/);
    // Same reason the systemd unit needs KillMode=process: without it the short-lived
    // reconcile job's exit reaps the freshly-armed detached monitors.
    assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  });
  it('the shipped plist sets a PATH that reaches a Homebrew tmux', async () => {
    // launchd jobs get only the system default PATH; without both Homebrew prefixes
    // reconcile dies with `spawn tmux ENOENT` on every timer fire.
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-auto-retry.reconcile.plist'), 'utf-8');
    assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*\/usr\/local\/bin[^<]*<\/string>/);
  });
});

describe('package.json files whitelist (Finding 1)', () => {
  it('includes systemd/ so install-timer works from an npm install', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('systemd/'), 'package.json "files" must include "systemd/"');
  });
  it('includes launchd/ so install-timer works from an npm install on macOS', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('launchd/'), 'package.json "files" must include "launchd/"');
  });
});

describe('injectWrapper', () => {
  const testFile = join(tmpdir(), `car-rc-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('adds wrapper to empty file', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes('/path/to/launcher.js'));
  });
  it('unaliases claude before defining the wrapper function (#10)', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    const unaliasIdx = content.indexOf('unalias claude');
    const fnIdx = content.indexOf('\nclaude() {');
    assert.ok(unaliasIdx !== -1, 'wrapper should unalias claude');
    assert.ok(unaliasIdx < fnIdx, 'unalias must come before the function definition');
  });
  it('adds wrapper to file with existing content', async () => {
    await writeFile(testFile, 'export PATH=$HOME/bin:$PATH\n');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('export PATH'));
    assert.ok(content.includes(MARKER_START));
  });
  it('replaces existing wrapper', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nold stuff\n${MARKER_END}\nafter\n`);
    await injectWrapper(testFile, '/new/path/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('/new/path'));
    assert.ok(!content.includes('old stuff'));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
});

describe('removeWrapper', () => {
  const testFile = join(tmpdir(), `car-rm-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('removes wrapper and preserves surrounding content', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nwrapper stuff\n${MARKER_END}\nafter\n`);
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(!content.includes(MARKER_START));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('does nothing when no wrapper present', async () => {
    await writeFile(testFile, 'just normal content\n');
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.equal(content, 'just normal content\n');
  });
});
