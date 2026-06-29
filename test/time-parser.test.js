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
  it('parses "try again in 5 minutes" as relative time', () => {
    const r = parseResetTime('try again in 5 minutes');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 5 * 60_000);
  });
  it('parses "try again in 2 hours" as relative time', () => {
    const r = parseResetTime('try again in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
  it('parses "wait 30 mins" as relative time', () => {
    const r = parseResetTime('wait 30 mins');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 30 * 60_000);
  });
  it('parses "resets in: 3 hours" as relative time', () => {
    const r = parseResetTime('usage limit · resets in: 3 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 3 * 3_600_000);
  });
  it('parses "resets in 2 hours" as relative time', () => {
    const r = parseResetTime('resets in 2 hours');
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
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
  it('handles relative time correctly', () => {
    const wait = calculateWaitMs({ relative: true, waitMs: 300_000 }, 60, 5);
    assert.ok(Math.abs(wait - 360_000) < 2000); // 5 min + 60s margin
  });
  it('falls back on invalid timezone', () => {
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Invalid/Zone' }, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000); // fallback
  });

  // Regression (#6): in a positive-offset tz, 10:02 AM Melbourne (UTC+10)
  // looking for "11:40pm Melbourne" should wait ~13.6h (today), not ~37.6h.
  it('targets today for a future reset in a positive-offset timezone', () => {
    const now = new Date('2026-05-03T00:02:15Z'); // 10:02 AM in Melbourne (UTC+10)
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 13 && hours < 14, `expected ~13.6h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): negative-offset tz, "resets 3am NY" at 1am NY → ~2h.
  it('targets today for a future reset in a negative-offset timezone', () => {
    const now = new Date('2026-05-03T05:00:00Z'); // 1:00 AM in New York (UTC-4 EDT)
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'America/New_York' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 1.9 && hours < 2.1, `expected ~2h, got ${hours.toFixed(2)}h`);
  });

  // Regression (#6): reset already passed today → target tomorrow (~22.6h),
  // not 48h. Symmetric case for the off-by-a-day bug.
  it('targets tomorrow when reset time already passed today', () => {
    const now = new Date('2026-05-03T15:00:00Z'); // 1:00 AM next day in Melbourne
    const wait = calculateWaitMs(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 60, 5, now
    );
    const hours = wait / 3600_000;
    assert.ok(hours > 22 && hours < 23, `expected ~22.6h, got ${hours.toFixed(2)}h`);
  });
});
