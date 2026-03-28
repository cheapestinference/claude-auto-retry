// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e)
// Covers standard, private-mode (\x1b[?25h), and extended sequences
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
// OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
// Covers hyperlinks (\x1b]8;;url\x1b\\), window titles (\x1b]0;title\x07), etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS sequences: \x1bP ... ST
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
// APC, SOS, PM sequences: \x1b[_X^] ... ST
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

const LIMIT_PATTERNS = [
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:\d+-hour\s+)?limit/i,  // "hit/exceeded/reached your limit"
  /\d+-hour limit/i,                                // "5-hour limit"
  /limit reached/i,                                  // "limit reached"
  /usage limit/i,                                    // "usage limit"
  /out of.*usage/i,                                  // "out of extra usage"
  /rate limit/i,                                     // "rate limit"
  /try again in/i,                                   // "try again in X hours" (implies rate limiting)
];

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                   // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,               // "try again in 5 hours"
];

const WINDOW = 6;

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Custom patterns: check full text (user controls their own regex)
  if (customPatterns.length > 0) {
    const full = lines.join('\n');
    const custom = customPatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (custom.some(p => p.test(full))) return true;
  }

  // Find a "limit" line with a "resets" line nearby (works for both
  // single-line messages and multi-line TUI renders)
  for (let i = 0; i < lines.length; i++) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Return the "resets" line — that's what parseResetTime needs
  for (const line of lines) {
    if (RESET_PATTERNS.some(p => p.test(line))) return line.trim();
  }

  // Fallback: any "limit" line
  for (const line of lines) {
    if (LIMIT_PATTERNS.some(p => p.test(line))) return line.trim();
  }

  return null;
}
