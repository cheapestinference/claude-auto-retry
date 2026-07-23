import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// calculateWaitMs must be right regardless of the HOST timezone. Node fixes TZ at
// startup, so each case runs in a subprocess with TZ set. Regression for the
// off-by-a-day family: a banner timezone beyond UTC±12 (or a host/banner offset
// split >12h) used to make the convergence correction land on the wrong day and
// wait ~24h too long (#60 fixed the host==banner case; the date-anchored
// correction covers the rest).
function waitHoursIn(hostTz, banner, nowIso) {
  const snippet = `
    import { parseResetTime, calculateWaitMs } from './src/time-parser.js';
    const parsed = parseResetTime(${JSON.stringify(banner)});
    const ms = calculateWaitMs(parsed, 60, 5, new Date(${JSON.stringify(nowIso)}));
    process.stdout.write(String(ms));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', snippet], {
    cwd: REPO_ROOT, env: { ...process.env, TZ: hostTz },
  });
  return Number(out.toString()) / 3600e3;
}

// Banner: resets 11:40pm Auckland (NZDT, UTC+13). Now: 2027-01-15T09:00Z = 22:00 NZDT.
// Correct wait: 1h40m + 60s margin ≈ 1.68h. The bug waited ~25.7h.
const AKL_BANNER = "You've hit your session limit · resets 11:40pm (Pacific/Auckland)";
const AKL_NOW = '2027-01-15T09:00:00Z';

describe('calculateWaitMs is host-timezone independent (date-anchored correction)', () => {
  it('banner tz beyond UTC+12, host == banner tz (the #60 case)', () => {
    assert.ok(Math.abs(waitHoursIn('Pacific/Auckland', AKL_BANNER, AKL_NOW) - 1.68) < 0.02);
  });

  it('banner tz beyond UTC+12, host UTC (CI/server monitoring a remote-tz session)', () => {
    assert.ok(Math.abs(waitHoursIn('UTC', AKL_BANNER, AKL_NOW) - 1.68) < 0.02);
  });

  it('banner tz beyond UTC+12, host on the other side of the planet', () => {
    assert.ok(Math.abs(waitHoursIn('America/New_York', AKL_BANNER, AKL_NOW) - 1.68) < 0.02);
  });

  it('UTC+14 banner (Pacific/Kiritimati), host UTC', () => {
    // resets 0:30am Kiritimati; now = 2027-01-15T10:00Z = 00:00 Jan 16 in +14.
    const h = waitHoursIn('UTC', "resets 12:30am (Pacific/Kiritimati)", '2027-01-15T10:00:00Z');
    assert.ok(Math.abs(h - 0.52) < 0.02, `got ${h}h`);
  });

  it('sanity: normal-offset banner unaffected across hosts', () => {
    const berlin = "You've hit your session limit · resets 3:30pm (Europe/Berlin)";
    const now = '2026-07-19T11:33:00Z'; // 13:33 CEST → 1h57m + margin ≈ 1.97h
    for (const host of ['UTC', 'Pacific/Auckland', 'America/New_York']) {
      const h = waitHoursIn(host, berlin, now);
      assert.ok(Math.abs(h - 1.97) < 0.02, `host ${host}: got ${h}h`);
    }
  });
});
