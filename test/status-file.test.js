import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStatus, readStatus, clearStatus, sweepStaleStatus } from '../src/status-file.js';

describe('per-pane status file', () => {
  let dir;
  let originalTmux;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'car-status-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });
  beforeEach(() => { originalTmux = process.env.TMUX; delete process.env.TMUX; });
  afterEach(() => {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  });

  it('round-trips a pane-keyed status snapshot', async () => {
    await writeStatus('%2', { status: 'monitoring', waitUntil: 0, overloadWaitUntil: 0, attempts: 0, overloadAttempts: 0 }, dir);
    const s = await readStatus('%2', dir);
    assert.equal(s.status, 'monitoring');
    assert.equal(typeof s.updatedAt, 'number');
  });

  it('stamps updatedAt in epoch seconds, overwriting any caller-supplied value', async () => {
    const before_ = Math.floor(Date.now() / 1000);
    await writeStatus('%2', { status: 'monitoring', updatedAt: 1 }, dir);
    const s = await readStatus('%2', dir);
    assert.ok(s.updatedAt >= before_, 'updatedAt should be a real current-time stamp, not the caller value');
  });

  it('sanitizes the pane id into the filename, prefixed by a socket key', async () => {
    await writeStatus('%7', { status: 'monitoring' }, dir);
    const files = await readdir(dir);
    // No TMUX env in this test (see beforeEach) -> falls back to the 'default' socket key.
    assert.ok(files.includes('default__7.json'), files.join(','));
  });

  // Reconcile/timer-armed monitors have no $TMUX (the systemd/launchd job runs outside
  // any client), so they wrote under the 'default' key while the status-bar reader looks
  // up by #{socket_path} — permanently blank segment for every self-healed monitor.
  // Reconcile now passes the enumerated server's socket via CLAUDE_AUTO_RETRY_SOCKET.
  it('prefers CLAUDE_AUTO_RETRY_SOCKET over $TMUX for the socket key', async () => {
    process.env.CLAUDE_AUTO_RETRY_SOCKET = '/tmp/tmux-1000/default';
    try {
      await writeStatus('%7', { status: 'monitoring' }, dir);
      const files = await readdir(dir);
      assert.ok(files.includes('_tmp_tmux-1000_default__7.json'), files.join(','));
    } finally {
      delete process.env.CLAUDE_AUTO_RETRY_SOCKET;
    }
  });

  it('returns null for an absent pane', async () => {
    assert.equal(await readStatus('%99', dir), null);
  });

  it('ignores an unparseable status file', async () => {
    await writeFile(join(dir, 'default__4.json'), 'not json');
    assert.equal(await readStatus('%4', dir), null);
  });

  it('clear() removes the status file', async () => {
    await writeStatus('%5', { status: 'waiting' }, dir);
    await clearStatus('%5', dir);
    assert.equal(await readStatus('%5', dir), null);
  });

  it('clear() on an absent pane is a no-op', async () => {
    await assert.doesNotReject(clearStatus('%no-such-pane', dir));
  });

  it('write is a no-op without a pane key', async () => {
    assert.equal(await writeStatus('', { status: 'monitoring' }, dir), null);
  });

  it('overwrites a previous snapshot for the same pane', async () => {
    await writeStatus('%6', { status: 'monitoring' }, dir);
    await writeStatus('%6', { status: 'waiting', waitUntil: 12345 }, dir);
    const s = await readStatus('%6', dir);
    assert.equal(s.status, 'waiting');
    assert.equal(s.waitUntil, 12345);
  });

  describe('cross-server pane-id disambiguation', () => {
    it('keys the same pane id differently under different TMUX socket paths', async () => {
      process.env.TMUX = '/tmp/tmux-1000/work,111,0';
      await writeStatus('%2', { status: 'monitoring' }, dir);

      process.env.TMUX = '/tmp/tmux-1000/personal,222,0';
      await writeStatus('%2', { status: 'waiting', waitUntil: 999 }, dir);

      process.env.TMUX = '/tmp/tmux-1000/work,111,0';
      const workStatus = await readStatus('%2', dir);
      assert.equal(workStatus.status, 'monitoring', 'the "work" server\'s pane %2 must not see "personal"\'s write');

      process.env.TMUX = '/tmp/tmux-1000/personal,222,0';
      const personalStatus = await readStatus('%2', dir);
      assert.equal(personalStatus.status, 'waiting');
      assert.equal(personalStatus.waitUntil, 999);
    });

    it('falls back to a stable "default" socket key when TMUX is unset', async () => {
      delete process.env.TMUX;
      await writeStatus('%8', { status: 'monitoring' }, dir);
      const files = await readdir(dir);
      assert.ok(files.includes('default__8.json'), files.join(','));
    });
  });

  describe('sweepStaleStatus', () => {
    it('removes files older than maxAgeSeconds and leaves fresh ones', async () => {
      const sweepDir = await mkdtemp(join(tmpdir(), 'car-status-sweep-'));
      try {
        await writeFile(join(sweepDir, 'default__old.json'), JSON.stringify({ status: 'monitoring', updatedAt: Math.floor(Date.now() / 1000) - 1000 }));
        await writeStatus('%fresh', { status: 'monitoring' }, sweepDir);

        const removed = await sweepStaleStatus(sweepDir, 300);
        assert.equal(removed, 1);

        const files = await readdir(sweepDir);
        assert.equal(files.length, 1);
        assert.ok(files[0].endsWith('__fresh.json'), files.join(','));
      } finally {
        await rm(sweepDir, { recursive: true, force: true });
      }
    });

    it('removes an unparseable .json snapshot', async () => {
      const sweepDir = await mkdtemp(join(tmpdir(), 'car-status-sweep-'));
      try {
        await writeFile(join(sweepDir, 'default__orphan.json'), 'not json');
        const removed = await sweepStaleStatus(sweepDir, 300);
        assert.equal(removed, 1);
        assert.deepEqual(await readdir(sweepDir), []);
      } finally {
        await rm(sweepDir, { recursive: true, force: true });
      }
    });

    it('sweeps an orphaned .tmp file (crash between writeFile and rename)', async () => {
      const sweepDir = await mkdtemp(join(tmpdir(), 'car-status-sweep-'));
      try {
        // A real atomic-write temp is named "<pane>.json.<pid>.tmp" and may be
        // half-written. Age it past the threshold via an explicit past mtime.
        const orphan = join(sweepDir, 'default__2.json.9999.tmp');
        await writeFile(orphan, '{"status":"monito');
        const past = new Date((Math.floor(Date.now() / 1000) - 1000) * 1000);
        await utimes(orphan, past, past);

        const removed = await sweepStaleStatus(sweepDir, 300);
        assert.equal(removed, 1);
        assert.deepEqual(await readdir(sweepDir), []);
      } finally {
        await rm(sweepDir, { recursive: true, force: true });
      }
    });

    it('leaves a fresh .tmp alone (a live writeStatus may be mid-rename)', async () => {
      const sweepDir = await mkdtemp(join(tmpdir(), 'car-status-sweep-'));
      try {
        // Just-created temp with a current mtime — a concurrent writeStatus could be
        // about to rename it into place, so the sweep must not race it away.
        await writeFile(join(sweepDir, 'default__3.json.1234.tmp'), '{"status":"mon');
        const removed = await sweepStaleStatus(sweepDir, 300);
        assert.equal(removed, 0);
        assert.deepEqual(await readdir(sweepDir), ['default__3.json.1234.tmp']);
      } finally {
        await rm(sweepDir, { recursive: true, force: true });
      }
    });

    it('is a no-op (returns 0) when the status directory does not exist yet', async () => {
      const missing = join(tmpdir(), 'car-status-does-not-exist-' + Date.now());
      assert.equal(await sweepStaleStatus(missing, 300), 0);
    });
  });
});
