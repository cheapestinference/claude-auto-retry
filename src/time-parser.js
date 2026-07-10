const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

export function parseResetTime(text) {
  // Try absolute time first: "resets at 3pm (UTC)"
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    let hour = parseInt(absMatch[1], 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() || null;
    const timezone = absMatch[4] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Reject an out-of-range clock (e.g. a bare "resets 30"): a bad hour/minute would make
    // calculateWaitMs build an invalid Date and throw, crashing the monitor. null → fallback.
    if (hour > 23 || hour < 0 || minute > 59) return null;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    return { hour, minute, timezone, ambiguous };
  }

  // Try relative time: "try again in 5 minutes" / "wait 2 hours"
  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const isMinutes = unit.startsWith('m');
    const ms = amount * (isMinutes ? 60_000 : 3_600_000);
    return { relative: true, waitMs: ms };
  }

  return null;
}

// Reset-boundary grace window. A live limit banner whose parsed reset time is already in
// the PAST almost always means the reset just happened: the monitor can settle on the
// banner minutes-to-an-hour after the reset (a session that kept working past it — see the
// chrome-aware anti-spam guard), and Claude's session limits reset on short cadences, so a
// past reset time is recent, not "tomorrow". Rolling a just-passed reset a full day forward
// parks the session ~24h even though the limit has effectively cleared (observed live:
// "resets 10am" detected at 10:03 → 86273s wait). rollPastReset retries promptly instead
// (diff→0, so the wait is just the margin); only a reset MORE than the grace window in the
// past plausibly means the next occurrence is tomorrow.
const RESET_GRACE_MS = 60 * 60 * 1000; // 1 hour
function rollPastReset(diffMs) {
  if (diffMs >= 0) return diffMs;
  return diffMs > -RESET_GRACE_MS ? 0 : diffMs + 86400_000;
}

export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date()) {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  // Handle relative times: "try again in 5 minutes"
  if (parsed.relative) {
    return parsed.waitMs + marginSeconds * 1000;
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validate timezone early to avoid cryptic errors later
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    // Invalid timezone (possibly garbled by TUI capture) — use fallback
    return (fallbackHours * 3600 + marginSeconds) * 1000;
  }

  // DST-safe approach: binary search for the correct UTC timestamp
  // that corresponds to the given hour:minute in the target timezone.
  function getTargetTimestamp(h, m) {
    // Get today's date in the target timezone
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const y = parseInt(parts.find(p => p.type === 'year').value);
    const mo = parseInt(parts.find(p => p.type === 'month').value) - 1;
    const d = parseInt(parts.find(p => p.type === 'day').value);

    // Construct target date string and parse as UTC as initial guess
    const targetStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const naiveUtc = new Date(targetStr + 'Z');

    // Iterative correction: format the guess in the target TZ,
    // compare with desired h:m, adjust, repeat up to 3 times for DST convergence
    let candidate = naiveUtc.getTime();
    for (let i = 0; i < 3; i++) {
      const check = new Date(candidate);
      const fp = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(check);
      const ch = parseInt(fp.find(p => p.type === 'hour').value) % 24;
      const cm = parseInt(fp.find(p => p.type === 'minute').value);

      // Normalize to [-720, +720] minutes so we take the minimum-magnitude
      // correction. Otherwise, in a UTC+10 tz looking for 23:40, the naive UTC
      // guess formats as 09:40 next day local, and a raw +14h adjustment lands
      // on tomorrow's occurrence instead of today's (the off-by-a-day bug).
      let diffMin = (h - ch) * 60 + (m - cm);
      diffMin = ((diffMin % 1440) + 1440) % 1440;
      if (diffMin > 720) diffMin -= 1440;
      if (diffMin === 0) break;
      candidate += diffMin * 60_000;
    }

    return candidate;
  }

  if (parsed.ambiguous) {
    const t1 = getTargetTimestamp(parsed.hour, parsed.minute);
    const t2 = getTargetTimestamp((parsed.hour + 12) % 24, parsed.minute);  // %24: 12→0 (midnight), never hour 24 (→ Invalid Date)
    const d1 = t1 - now.getTime();
    const d2 = t2 - now.getTime();

    let target;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else {
      // Both interpretations are past. Grace-check the MOST RECENT one (is it just-passed?);
      // but if we roll to tomorrow, roll to the EARLIEST occurrence (t1 < t2 always, so
      // Math.min), not the later pm one — otherwise we wait ~12h longer than necessary.
      const recent = Math.max(d1, d2);
      target = recent > -RESET_GRACE_MS ? 0 : Math.min(d1, d2) + 86400_000;
    }

    return Math.max(0, target) + marginSeconds * 1000;
  }

  const diff = rollPastReset(getTargetTimestamp(parsed.hour, parsed.minute) - now.getTime());

  return diff + marginSeconds * 1000;
}
