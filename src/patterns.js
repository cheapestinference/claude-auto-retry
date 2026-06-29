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
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/i,  // "hit/exceeded/reached your [session|weekly|5-hour] limit"
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

// tailLines > 0 restricts detection to the last N lines of the pane. A live usage-limit
// banner sits at the prompt (the last thing printed); the same words quoted in scrollback
// — a conversation discussing limits, a stale banner the session already moved past — are
// NOT the current state and must not drive a retry. 0 = scan everything (print mode, where
// the input is captured process output, not a scrolling TUI).
export function isRateLimited(text, customPatterns = [], tailLines = 0) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);

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

// --- Interactive /rate-limit-options menu ---
// Newer Claude Code shows a selectable menu when a session/weekly limit is hit:
//   What do you want to do?
//   ❯ 1. Upgrade your plan
//     2. Stop and wait for limit to reset
// A bare Enter confirms the highlighted default — which is "Upgrade your plan"
// on some versions. The option ORDER varies between versions, so we never assume
// a position: we locate the cursor (❯) and the "Stop and wait" option and compute
// the cursor moves needed to land on it.

const MENU_CURSOR = '❯';
const WAIT_OPTION_REGEX = /stop and wait for limit to reset/i;
const MENU_OPTION_REGEX = /^\s*❯?\s*\d+\.\s/;

// tailLines > 0 restricts to the last N lines: a LIVE menu sits at the prompt, so the
// same menu text quoted in scrollback (a conversation about limits) must not make us
// drive arrow keys + Enter into whatever is actually on screen.
export function isRateLimitOptionsPrompt(text, tailLines = 0) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);
  const t = lines.join('\n');
  return /what do you want to do\?/i.test(t)
    && WAIT_OPTION_REGEX.test(t)
    && (/enter to confirm/i.test(t) || /esc to cancel/i.test(t) || t.includes(MENU_CURSOR));
}

// Cursor moves to reach the "Stop and wait for limit to reset" option, counted in
// option steps: positive => press Down N times, negative => Up, 0 => already there.
// Returns null when the layout can't be read (no cursor or option not found); the
// caller MUST NOT press Enter in that case, to avoid confirming the wrong option.
// tailLines mirrors isRateLimitOptionsPrompt so option counting ignores quoted menus.
export function menuStepsToWaitOption(text, tailLines = 0) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);
  const optionLines = lines.filter(l => MENU_OPTION_REGEX.test(l));
  if (optionLines.length === 0) return null;
  const cursorPos = optionLines.findIndex(l => l.includes(MENU_CURSOR));
  const waitPos = optionLines.findIndex(l => WAIT_OPTION_REGEX.test(l));
  if (cursorPos === -1 || waitPos === -1) return null;
  return waitPos - cursorPos;
}

// --- Overload / transient API error detection (distinct from usage limits) ---
// Claude Code already retries 5xx/529 internally; this only fires on a *sustained*
// terminal error left in the pane. Patterns are case-insensitive regexes (same as
// the usage-limit customPatterns), config-driven via `overload.patterns`. Kept
// entirely separate from the usage-limit path above so the two never collide.
//
// Two guards keep this from firing on ordinary content (the historical bug: a bare
// "503"/"529" in code under edit, an HTTP status in a quoted log, or "status.claude.com"
// in a comment all looked identical to a live error):
//   1. Patterns are ANCHORED to Claude Code's actual error render ("API Error: <code>"
//      or the "overloaded_error" JSON type) — never a bare status number.
//   2. Only the TAIL of the pane is inspected. A *terminal* error is the last thing
//      Claude printed; the same digits sitting in scrollback the user scrolled past
//      are not an error. Matching the full 20-line capture is what drove the false
//      positives — a 503 far up the buffer kept re-triggering during unrelated work.

// A real terminal error sits just above the input box (~5-6 variable lines: box
// borders + input row(s) + footer). A multi-line JSON error body adds a few more, so
// its anchor line can land ~10 rows from the bottom. 12 covers that with margin while
// still trimming the top ~8 lines of the 20-line capture (where stale scrollback lives).
const OVERLOAD_TAIL_LINES = 12;

// Indicators that Claude is mid-flight and the pane is NOT in a terminal error state.
// Two kinds: the streaming footer, and Claude Code's OWN internal-retry indicator.
// While either is on screen the request's retries are not exhausted — acting now would
// interrupt Claude's backoff. The transient error render is "API Error (529 …) ·
// Retrying in 5s · attempt 3/10"; the colon form can also carry the "· Retrying" suffix
// until exhausted, so we gate on the suffix itself, not just the parens form.
const WORKING_PATTERNS = [
  /esc to interrupt/i,        // the working/streaming footer ("… (esc to interrupt)")
  /\besc\b.*\binterrupt\b/i,  // tolerate reordering/spacing in the same footer
  /Retrying in\b/i,           // internal-retry suffix — retries not yet exhausted
  /\battempt\s+\d+\/\d+/i,    // "attempt 3/10" companion to the retry suffix
];

function tail(text) {
  return stripAnsi(text).split('\n').slice(-OVERLOAD_TAIL_LINES);
}

// Compile a config pattern (string → case-insensitive RegExp) once per call. Invalid
// regexes are dropped rather than thrown (matches the usage-limit customPatterns path).
function toRegexes(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p instanceof RegExp) { out.push(p); continue; }
    if (typeof p !== 'string' || !p) continue;
    try { out.push(new RegExp(p, 'i')); } catch { /* skip invalid */ }
  }
  return out;
}

// Returns { pattern, line } for the first overload pattern matching a tail line, else
// null. Per-line (not whole-tail) so we can report WHICH line tripped it — invaluable
// for diagnosing a future false positive (the original bug logged no reason at all).
export function overloadMatch(text, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  const lines = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (const line of lines) {
    for (const r of regexes) {
      if (r.test(line)) return { pattern: r.source, line: line.trim().slice(0, 200) };
    }
  }
  return null;
}

export function detectOverload(text, patterns = []) {
  return overloadMatch(text, patterns) !== null;
}

export function isWorking(text) {
  const lines = tail(text);
  return lines.some(line => WORKING_PATTERNS.some(p => p.test(line)));
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Scan from the bottom up — the most recent "resets" line is the one to
  // parse. The Claude TUI never clears earlier rate-limit messages from
  // scrollback, so a forward scan would lock onto a stale line (e.g. an old
  // "resets 11:30am" lingering above a fresh "resets 4:30pm").
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  // Fallback: any "limit" line, also scanned from the bottom.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}
