const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait)\s+(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

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
