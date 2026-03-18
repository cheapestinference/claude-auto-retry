import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createLogger', () => {
  const testDir = join(tmpdir(), `car-logger-test-${Date.now()}`);

  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('creates log directory and writes log entry', async () => {
    const logger = createLogger(testDir);
    await logger.info('test message');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.ok(content.includes('test message'));
    assert.ok(content.includes('[INFO]'));
  });
  it('includes timestamp in log entries', async () => {
    const logger = createLogger(testDir);
    await logger.info('timestamped');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });
  it('supports warn and error levels', async () => {
    const logger = createLogger(testDir);
    await logger.warn('warning msg');
    await logger.error('error msg');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.ok(content.includes('[WARN]'));
    assert.ok(content.includes('[ERROR]'));
  });
});
