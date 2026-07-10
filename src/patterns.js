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

// The companion line Claude Code prints directly under a LIVE session/usage-limit banner
// ("… /usage-credits to finish what you're working on."). A distinctive UI string, so it
// doubles as furniture in the chrome allowlist and as the high-confidence live-limit
// backstop signal below — one source of truth for both.
const USAGE_CREDITS = /\/usage-credits\b/i;

// Indicators that Claude is mid-flight and the pane is NOT in a terminal error state.
// Two kinds: the streaming footer, and Claude Code's OWN internal-retry indicator.
// While either is on screen the request's retries are not exhausted — acting now would
// interrupt Claude's backoff. Defined up here because isChromeLine excludes these lines
// (a live working footer must never be stripped as furniture) and isWorking scans for
// them; both need the predicate.
const WORKING_PATTERNS = [
  /esc to interrupt/i,        // the working/streaming footer ("… (esc to interrupt)")
  /\besc\b.*\binterrupt\b/i,  // tolerate reordering/spacing in the same footer
  /Retrying in\b/i,           // internal-retry suffix — retries not yet exhausted
  /\battempt\s+\d+\/\d+/i,    // "attempt 3/10" companion to the retry suffix
];
const isWorkingLine = (l) => WORKING_PATTERNS.some((p) => p.test(l));

// --- Chrome-aware tail ---
// Claude Code renders UI chrome BELOW the meaningful content: the input box, the footer
// (model/usage/version), key hints, the todo/task widget, the status spinner
// ("✻ Brewed for …"), background-agent notices, and the "/usage-credits" hint. A live
// error/limit banner sits ABOVE this chrome, so when there's a lot of it — e.g. a tall
// task list — the banner is pushed well up the pane. A fixed last-N-lines tail then
// scrolls right past a genuine banner (observed: a session-limit banner ~16 lines up
// behind a task widget went undetected for ~54 min). Stripping trailing chrome first
// makes the tail measure distance-in-CONTENT, not raw lines — which also keeps the
// scrollback false-positive fixed (real work below a quoted banner is NOT chrome, so it
// isn't stripped and the stale banner stays out of the window).
//
// Each entry must be ANCHORED to how Claude Code actually renders the furniture — a
// full-line shape, leading indentation, or a footer position — not just "the line
// contains this glyph." The miss cost here is a false retry (stripping content lets a
// stale banner re-enter the window), so a loose glyph match (a bare "ctrl+", a stray
// arrow, any semver) is unacceptable. See Finding 2 in the PR review.
const CHROME_LINE = [
  /^\s*$/,                                          // blank
  /^[\s─│╭╮╰╯┌┐└┘├┤┬┴┼▏▕|]+$/,                       // box-drawing / rules
  /^\s*│\s*[>❯][^│]*│\s*$/,                          // boxed input row ("│ > … │"): anchored to
                                                     // the PROMPT GLYPH, not "anything between two
                                                     // bars" — a bare │…│ rule matches unicode-
                                                     // border tool output (psql/duf tables) and
                                                     // would strip it as chrome, pulling a stale
                                                     // banner back in. The glyph is the discriminator.
  /^\s*[❯>]\s*$/,                                    // empty input prompt (bare, unboxed)
  /^\s*⏵⏵/,                                          // mode footer ("⏵⏵ auto mode on…", "⏵⏵ accept edits…")
  /Allowed by auto mode/i,                          // "Allowed by auto mode" permission notice (anchored to
                                                     // the full phrase — bare /auto mode/ matched prose like
                                                     // "auto mode is enabled in your settings"; the footer
                                                     // itself is already covered by /^\s*⏵⏵/ above)
  /shift\+tab to (?:cycle|select)/i,                // tab-cycle footer hint (anchored to the phrase)
  /^\s*\?\s+for shortcuts\b/i,                       // "? for shortcuts" footer hint
  /\|\s*v\d+\.\d+\.\d+\b/,                           // footer version segment ("… | v2.1.201"), pipe-anchored
  /^\s+[□◻■◼▢▪◽◾✓✔☐☑]\s+\S/,                          // INDENTED todo/task items (leading ws required — a
                                                     // flush-left "✓ Fixed the bug" summary is content)
  /^\s*\d+\s+tasks?\s+\(/i,                           // task widget header ("8 tasks (…)") — the "(" count is
                                                     // required so prose ("3 tasks remain in the backlog")
                                                     // isn't stripped
  /^\s*…\s*\+\d+\b/,                                 // "… +N completed"
  /\/clear to save/i,                               // "new task? /clear to save …k tokens" — anchored to the
                                                     // save hint; bare /new task\?/ matched prose questions
                                                     // ("Should I start the new task?")
  USAGE_CREDITS,                                     // live-limit companion hint (shared w/ the backstop)
  /^\s*[✻✢✽✳✴✶✷]\s/,                                 // status spinner ("✻ Brewed for …")
  /Backgrounded agent \(|to manage · /i,             // background-agent notice — the "(" (or "to manage ·")
                                                     // is required so prose ("Backgrounded agent finished
                                                     // the lint run") isn't stripped
];
// A live working footer ("✻ Cogitating… (esc to interrupt)") matches the spinner glyph
// pattern above, so it must be excluded explicitly — it is live content, never furniture.
const isChromeLine = (l) => !isWorkingLine(l) && CHROME_LINE.some((r) => r.test(l));

// Last `n` lines AFTER dropping trailing chrome, so a tall widget / input box below a
// banner doesn't consume the window budget. Operates on an array of already-split lines.
// maxRaw (optional) additionally caps how far above the FULL bottom the window may reach:
// with it set, a line further than maxRaw raw lines from the bottom is excluded even if
// chrome-stripping would otherwise expose it — bounding content-distance for the overload
// path (Finding 6), where a terminal error sits just above the input box and anything
// reachable only past a tall widget is stale scrollback, not a live error.
function contentTail(lines, n, maxRaw = Infinity) {
  let end = lines.length;
  while (end > 0 && isChromeLine(lines[end - 1])) end--;
  const start = Math.max(0, end - n, lines.length - maxRaw);
  return lines.slice(start, end);
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
// the input is captured process output, not a scrolling TUI). The USAGE_CREDITS companion
// (defined above) backstops a banner buried behind a widget the chrome allowlist doesn't
// recognize — trusted only when it sits in the live region (nothing but chrome below it).
export function isRateLimited(text, customPatterns = [], tailLines = 0) {
  const all = stripAnsi(text).split('\n');
  // Chrome-aware window: trailing UI furniture doesn't consume the tail budget.
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all;

  // Custom patterns test the RAW tail, not the chrome-stripped window (Finding 4). The
  // user owns their own false-positive tradeoff, so a pattern keyed on footer text (a
  // usage percentage, a model name) must still fire even though the footer is furniture
  // the built-in path strips — and it stays bounded to the same tailLines so it can't
  // reach deeper into scrollback than before. Matches master's semantics.
  if (customPatterns.length > 0) {
    const raw = tailLines > 0 ? all.slice(-tailLines) : all;
    const full = raw.join('\n');
    const custom = customPatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (custom.some(p => p.test(full))) return true;
  }

  // Backstop for the modern render: a live limit prints "/usage-credits to finish…" right
  // by the banner, so finding that companion next to a reset/limit line catches a banner
  // buried behind a widget the chrome allowlist doesn't recognize. But it needs the SAME
  // liveness discipline as the main path: only trust the companion when it sits in the
  // live region — nothing but chrome below it. A resumed session's scrollback always
  // contains the stale banner+companion with real work rendered below; without this gate
  // the backstop fires on that (up to maxRetries injections + a ~24h wait). (Only when
  // tail-scoped; print mode uses the full scan below.)
  if (tailLines > 0) {
    const companionIdx = all.findLastIndex((l) => USAGE_CREDITS.test(l));
    // Require a RESET line nearby — NOT just a LIMIT line. A live limit banner always prints
    // its reset time next to the companion; a session merely *explaining* usage limits ("when
    // you hit your usage limit you can run /usage-credits …") has the companion + a loose
    // "usage limit" LIMIT match but no reset time, and would otherwise false-fire a retry.
    if (companionIdx !== -1
        && all.slice(companionIdx + 1).every(isChromeLine)
        && hasNearbyMatch(all, companionIdx, RESET_PATTERNS)) {
      return true;
    }
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
  const all = stripAnsi(text).split('\n');
  // Chrome-aware, like the banner detectors (Finding 5): a live menu pushed up by a tall
  // widget below it must still be seen, or the menu branch is skipped and a later sendKeys
  // types into the open menu (Enter confirms the default "Upgrade your plan"). Menu lines
  // are not chrome, so contentTail keeps them.
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all;
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
  const all = stripAnsi(text).split('\n');
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all;  // chrome-aware, matches isRateLimitOptionsPrompt (Finding 5)
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
//      are not an error. Scanning the whole capture is what drove the false positives —
//      a 503 far up the buffer kept re-triggering during unrelated work.

// A real terminal error sits just above the input box (~5-6 variable lines: box
// borders + input row(s) + footer). A multi-line JSON error body adds a few more, so
// its anchor line can land ~10 rows from the bottom. 12 content lines cover that with
// margin; the monitor captures 50 raw lines, so trailing chrome is stripped and this
// keeps only the live error region (bounded further by OVERLOAD_MAX_RAW_LINES below).
const OVERLOAD_TAIL_LINES = 12;
// Hard raw-distance cap for the overload path. A terminal API error renders just above
// the input box; an error only reachable by chrome-stripping past a tall widget is stale
// scrollback, not live. Bounds the deeper (50-line) capture so overload — seconds-scale
// and more false-positive-prone than the reset-anchored limit path — can't reach an old
// quoted error. 20 matches master's original capture depth. (Finding 6.)
const OVERLOAD_MAX_RAW_LINES = 20;

// Chrome-aware tail for the overload detectors: a terminal error can be pushed up by the
// same widgets that pushed the limit banner, so strip trailing chrome first — but bound
// the reach so a widget-buried stale error stays out.
function tail(text) {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES, OVERLOAD_MAX_RAW_LINES);
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

// --- Safeguard / AUP false-positive detection ---
// A distinct failure mode from usage limits and 5xx overloads: the model's safeguards
// flag the message (often a false positive — the error itself says it "may flag safe,
// normal content"). It renders like:
//   ● API Error: Fable 5's safeguards flagged this message (…/legal/aup). … Claude Code
//     can't respond to this request with Fable 5.
//     Double press esc to edit your last message, or try a different model with /model.
// Because the flag is semi-random, an immediate re-send frequently clears it — but it
// must be capped so a *sticky* flag doesn't loop forever. Tail-anchored like the others.
// Anchor: a REAL flag always renders as an `API Error:` line. Requiring it nearby (same
// wrap-tolerant window isRateLimited uses for limit/resets pairing) keeps the phrases
// from firing on ordinary conversation — Claude quoting the AUP link or discussing
// safeguard errors at an idle prompt must not trigger a retry. (DEFAULT_OVERLOAD learned
// this the hard way; see its comment about bare status numbers.)
const SAFEGUARD_ANCHOR = [/\bAPI Error\b/i];

export function safeguardMatch(text, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  const lines = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, SAFEGUARD_ANCHOR)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) };
      }
    }
  }
  return null;
}

export function detectSafeguard(text, patterns = []) {
  return safeguardMatch(text, patterns) !== null;
}

// Chrome-aware, so isWorking measures the SAME bottom as isRateLimited/detectOverload. A
// live working footer pushed up by a tall chrome stack below it (task widget + input box
// + footer) would be invisible to a raw last-N tail while the chrome-aware detectors still
// saw a lingering banner — the asymmetry that let retry text land in a mid-flight session
// (Finding 3). isChromeLine excludes working lines, so contentTail never strips the footer.
export function isWorking(text) {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES).some(isWorkingLine);
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
