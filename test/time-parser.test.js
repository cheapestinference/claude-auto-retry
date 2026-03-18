import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, calculateWaitMs } from '../src/time-parser.js';

describe('parseResetTime', () => {
  it('parses "resets 3pm (Europe/Dublin)"', () => {
    const r = parseResetTime('5-hour limit reached - resets 3pm (Europe/Dublin)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Europe/Dublin');
  });
  it('parses "resets at 2pm (America/New_York)"', () => {
    const r = parseResetTime('Usage limit. Resets at 2pm (America/New_York)');
    assert.equal(r.hour, 14); assert.equal(r.timezone, 'America/New_York');
  });
  it('parses "resets 15:30 (Asia/Kolkata)"', () => {
    const r = parseResetTime('resets 15:30 (Asia/Kolkata)');
    assert.equal(r.hour, 15); assert.equal(r.minute, 30);
  });
  it('parses 12pm as noon', () => {
    const r = parseResetTime('resets 12pm (UTC)');
    assert.equal(r.hour, 12);
  });
  it('parses 12am as midnight', () => {
    const r = parseResetTime('resets 12am (UTC)');
    assert.equal(r.hour, 0);
  });
  it('handles no timezone', () => {
    const r = parseResetTime('resets 3pm');
    assert.equal(r.hour, 15); assert.equal(r.timezone, null);
  });
  it('returns null for unparseable text', () => {
    assert.equal(parseResetTime('some random text'), null);
  });
});

describe('calculateWaitMs', () => {
  it('returns positive wait for future time', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 2) % 24;
    const wait = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 60, 5, now);
    assert.ok(wait > 0);
    assert.ok(wait <= 3 * 3600_000);
  });
  it('adds margin seconds', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 1) % 24;
    const w0 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 0, 5, now);
    const w120 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 120, 5, now);
    assert.ok(w120 - w0 >= 119_000 && w120 - w0 <= 121_000);
  });
  it('returns fallback when parsed is null', () => {
    const wait = calculateWaitMs(null, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000);
  });
  it('handles ambiguous hour by picking soonest future', () => {
    const now = new Date('2026-03-18T13:00:00Z');
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now
    );
    assert.ok(wait > 0 && wait <= 3 * 3600_000);
  });
});
