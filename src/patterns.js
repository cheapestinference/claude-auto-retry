// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e)
// Covers standard, private-mode (\x1b[?25h), and extended sequences
const ANSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_REGEX, '');
}

const DEFAULT_PATTERNS = [
  /\d+-hour limit reached/i,
  /limit reached.*resets?\s/i,
  /usage limit.*resets?\s/i,
  /out of.*usage.*resets?\s/i,
  /try again in \d+\s*(hours?|minutes?|h|m)/i,
  /rate limit.*resets?\s/i,
  /hit.*(?:your|the)?\s*limit.*resets?\s/i,
  /\blimit\b.*resets?\s+(?:at\s+|in[:\s])\s*\d/i,
];

export function isRateLimited(text, customPatterns = []) {
  const stripped = stripAnsi(text);
  const patterns = [...DEFAULT_PATTERNS, ...customPatterns.map(p =>
    typeof p === 'string' ? new RegExp(p, 'i') : p
  )];
  return patterns.some(pattern => pattern.test(stripped));
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');
  const patterns = [...DEFAULT_PATTERNS, ...customPatterns.map(p =>
    typeof p === 'string' ? new RegExp(p, 'i') : p
  )];
  for (const line of lines) {
    if (patterns.some(pattern => pattern.test(line))) return line.trim();
  }
  return null;
}
