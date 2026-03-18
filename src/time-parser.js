const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

export function parseResetTime(text) {
  const match = text.match(RESET_TIME_REGEX);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase() || null;
  const timezone = match[4] || null;

  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // Ambiguous only when no am/pm AND hour is 1-12 (not 0, which is unambiguous 24h midnight)
  const ambiguous = !ampm && hour >= 1 && hour <= 12;

  return { hour, minute, timezone, ambiguous };
}

export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date()) {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  const tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

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

      const diffMin = (h - ch) * 60 + (m - cm);
      if (diffMin === 0) break;
      candidate += diffMin * 60_000;
    }

    return candidate;
  }

  if (parsed.ambiguous) {
    const t1 = getTargetTimestamp(parsed.hour, parsed.minute);
    const t2 = getTargetTimestamp(parsed.hour + 12, parsed.minute);
    const d1 = t1 - now.getTime();
    const d2 = t2 - now.getTime();

    let target;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else target = d1 + 86400_000; // tomorrow

    return Math.max(0, target) + marginSeconds * 1000;
  }

  let diff = getTargetTimestamp(parsed.hour, parsed.minute) - now.getTime();
  if (diff < 0) diff += 86400_000; // tomorrow

  return diff + marginSeconds * 1000;
}
