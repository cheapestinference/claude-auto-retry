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
// …but only the SIGNAL may match the hint anywhere on the line. As FURNITURE it has to
// LEAD its line, because a banner can name the hint INLINE — "You've hit your session
// limit · resets 5:20pm · run /usage-credits to finish" is one line, not two, and the
// spend-limit render (#71) always carries it. Matched loosely, the chrome allowlist
// classified those banners as furniture: contentTail stripped them, so the only line
// naming the limit — and, for a session banner, the only line carrying the reset time —
// was invisible to every detector. The companion always renders on its own row (indented,
// or behind ONE ⎿/└/· echo marker — no render stacks them), so this is the same literal as
// the signal above with a leading anchor, composed from it rather than re-spelled.
//
// Leading indentation is admitted here and REFUSED for the same `·` in SPEND_LIMIT below.
// The two constants answer different questions about opposite failure costs: this one asks
// "is this row furniture?" about a row the TUI renders INDENTED in every observed pane, and
// over-matching costs at most a stripped line that carries no limit signal of its own.
// SPEND_LIMIT asks "is this row a live render?" about a line the TUI prints flush left, and
// over-matching there commits a multi-hour wait with no reset time to sanity-check it.
const USAGE_CREDITS_HINT = new RegExp(`^\\s*(?:[⎿└·]\\s*)?${USAGE_CREDITS.source}`, 'i');

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
  // The main thread is blocked awaiting a subagent — actively working, even though the
  // streaming footer isn't on this thread. LIVE-ONLY render (it disappears the moment the
  // agent finishes), so it's safe to treat as working: unlike the "Backgrounded agent"
  // transcript notice, it can't linger and pin isWorking on an idle, genuinely-limited pane.
  /waiting for \d+ background agents? to finish/i,
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
  USAGE_CREDITS_HINT,                                // live-limit companion ROW — anchored, so a banner
                                                     // naming the hint mid-line stays content
  /^\s*[✻✢✽✳✴✶✷]\s/,                                 // status spinner ("✻ Brewed for …")
  // Usage-meter statusline rows (#61, ccusage-style). The "⟳ resets in 1 hr 47 min"
  // countdown matches RESET_PATTERNS and renders permanently at the very bottom, BELOW
  // any live banner — so it must be furniture: it both hijacked findRateLimitMessage's
  // bottom-up scan (an unparseable "1 hr 47 min" → 5h fallback instead of the banner's
  // real time) and handed a free "resets" anchor to any limit-shaped prose near the
  // bottom. Anchored to the meter shapes: the countdown glyph, a dotted gauge with a
  // percentage, and the cost/duration row.
  /[⟳↻⌛⏳🕐-🕧]\s*resets/iu,                          // meter reset countdown — glyph varies by
                                                     // statusline layout/version ("⟳ resets in
                                                     // 1 hr 47 min", "⌛ Resets at 15:00")
  /[●○◐◓◑◒]{5,}\s*(?:ctx:)?\d+%/,                     // dotted usage gauge ("current ●●●●●●●●●● 100%")
  /^\s*\$[\d.,]+\s+⏱/,                               // cost row ("$230.61 ⏱ 59h14m │ diff:+63 -16")
  /Backgrounded agent \(|to manage · /i,             // background-agent notice — the "(" (or "to manage ·")
                                                     // is required so prose ("Backgrounded agent finished
                                                     // the lint run") isn't stripped
];
// A live working footer ("✻ Cogitating… (esc to interrupt)") matches the spinner glyph
// pattern above, so it must be excluded explicitly — it is live content, never furniture.
// The spend-limit banner (#71) needed a second exemption here for the same reason a session
// banner does: it names /usage-credits inline. Anchoring the companion entry to the hint
// LEADING its row covers every banner that mentions it, so the special case is gone — along
// with its forward reference to a const declared 100 lines further down.
const isChromeLine = (l) => !isWorkingLine(l) && CHROME_LINE.some((r) => r.test(l));

// Last `n` lines AFTER dropping trailing chrome, so a tall widget / input box below a
// banner doesn't consume the window budget. Operates on an array of already-split lines.
// maxRaw (optional) additionally caps how far above the FULL bottom the window may reach:
// with it set, a line further than maxRaw raw lines from the bottom is excluded even if
// chrome-stripping would otherwise expose it — bounding content-distance for the overload
// path (Finding 6), where a terminal error sits just above the input box and anything
// reachable only past a tall widget is stale scrollback, not a live error.
function contentTailRange(lines, n, maxRaw = Infinity) {
  let end = lines.length;
  while (end > 0 && isChromeLine(lines[end - 1])) end--;
  const start = Math.max(0, end - n, lines.length - maxRaw);
  return { start, end };
}
function contentTail(lines, n, maxRaw = Infinity) {
  const { start, end } = contentTailRange(lines, n, maxRaw);
  return lines.slice(start, end);
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

// Declared as two named subsets rather than one list the #73 code then re-derives by
// grepping regex SOURCE text: `LIMIT_PATTERNS.filter(p => !/try again in/.test(p.source))`
// reads the implementation of a pattern to decide what it means, so rewording the retry
// hint once (`/try again (?:in|at)/`) would silently stop excluding it and let a retry hint
// vouch for a line as if it named a limit. The subsets say which is which; LIMIT_PATTERNS
// stays the union, so every existing caller is unchanged.
const LIMIT_NAME_PATTERNS = [
  // Qualifier tokens admit possessives — "hit your org's monthly spend limit" (#71).
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w'’-]+\s+){0,3}limit/i,  // "hit/exceeded/reached your [session|weekly|5-hour] limit"
  /\d+-hour limit/i,                                // "5-hour limit"
  /limit reached/i,                                  // "limit reached"
  /usage limit/i,                                    // "usage limit"
  /out of.*usage/i,                                  // "out of extra usage"
  /rate limit/i,                                     // "rate limit"
];
// A retry hint is a RESET clause in limit clothing: "⏺ I will try again in 3 minutes" is
// prose. It counts as a limit for detection (a pane saying it is rate-limited) but must
// never, on its own, vouch for a line being a render.
const RETRY_HINT_PATTERNS = [
  /try again in/i,                                   // "try again in X hours" (implies rate limiting)
];
const LIMIT_PATTERNS = [...LIMIT_NAME_PATTERNS, ...RETRY_HINT_PATTERNS];

// Month names for the date-bearing form below; shared with time-parser.js's clause regex.
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  // Weekly limits render a CALENDAR DATE: "resets Aug 21 at 3pm (Australia/Brisbane)" (a
  // real record, PR #56's fixture). The clock-only form above needs a digit right after
  // "resets", so this render was neither detected nor parsed. The clause ends at the time,
  // exactly like the clock-only form, so the run-on veto (#73) measures the same tail.
  new RegExp(`resets?\\s+(?:on\\s+)?${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:at\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?`, 'i'),
  /resets?\s+in[:\s]\s*\d/i,                                   // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,               // "try again in 5 hours"
];

// --- Renders vs prose (#73) ---
// A pane line may MENTION a limit or a reset time without BEING one. `/try again in/i` is
// plain English, so "The API said to try again in 2 minutes before the window rolls" — or
// the user's own "it told me to try again in 2 minutes, is that right?" — is reset-shaped,
// and renders BELOW the banner it discusses, where a bottom-up scan finds it first.
//
// The discriminator is the SHAPE of the line, not its vocabulary, and it is stated as a
// VETO: a reset-shaped line is eligible unless something marks it as conversation. Stated
// the other way round — an allowlist of known banner shapes — every render this file does
// not recognise is demoted, including a LIVE one sitting below a stale banner, which is
// worse than the pre-#73 behavior it replaces ("Claude usage limit reached. Resets at 2pm"
// below "… resets 11:30am" would hand the monitor the stale time, and #70's latch would
// then mark it non-correctable).
//
// "A veto only demotes what it can positively identify, so an unrecognised render keeps the
// freshness ordering it had before" is the property this is FOR — but being a veto does not
// establish it, and stating it that way concealed three violations for three revisions. A
// signal that fires on a real render demotes it whichever direction the rule is phrased in.
// What actually holds the property is the ordering below: everything except the prompt glyph
// is subordinate to whether the line names a limit.
//
// Four per-line signals, no neighbour lookups:
//
//   0. NAMING A LIMIT. Checked FIRST (after the prompt glyph) and rescues the line outright:
//      signals 2-4 are evidence of prose, and prose is all they may veto. This is what the
//      first three revisions got wrong — each demoted a render that plainly named a limit.
//   1. THE PROMPT GLYPH. ❯/> introduce the user's own input, which is never a render — the
//      one signal that outranks naming a limit, since the user typing about their own limit
//      is the #73 report's second half.
//   2. SENTENCE PUNCTUATION. A render does not end in ./?/! — "· resets 3pm (UTC)" — while
//      a sentence does, including one whose WRAPPED continuation happens to begin with the
//      clause ("  try again in 2 minutes, so I'll wait."). tmux capture-pane is called
//      without -J (src/tmux.js), so a wrap arrives as its own line: a rule keyed on what
//      LEADS the line would read that continuation as a render.
//   3. WHAT FOLLOWS THE RESET CLAUSE. A render stops at the time, give or take a timezone
//      qualifier or the rest of a compound duration ("· resets 3pm (UTC)", "resets 3am NY",
//      "resets in 3 hours 15 minutes"). A sentence keeps going: "…resets 9am tomorrow
//      according to the header".
//
// WHY THE SIGNALS ARE ORDERED THE WAY THEY ARE — the two errors do not cost the same.
// Returning prose parses a SHORT wait: the monitor wakes early, finds the limit still
// live, and re-derives. Returning a stale banner parses a LONG one — and because a stale
// line parses, `_waitIsFallback` is false (monitor.js:111) and only fallbacks are
// correctable (:139), so #70's latch refuses to revisit it. Under-waiting self-corrects;
// over-waiting is unrecoverable until the wait expires. Every signal below therefore only
// ever fires where the line is unambiguously conversation, and a line that NAMES a limit
// is treated as a render — the prompt glyph excepted, since the user's own input row is
// never a render whatever it says.
//
// This is the correction to the first three cuts of this fix, all of which stated the
// invariant as "a veto only demotes what it can positively identify" and then broke it
// three ways: SENTENCE_END demoted every period-terminated render ("Rate limit exceeded.
// Please try again in 5 hours."), the tail budget demoted every render with an inline hint
// ("· resets 5:20pm · /upgrade to increase your limits"), and the bullet veto demoted the
// API-error render whose vocabulary is underscored. Each one identified a RENDER and
// demoted it. Making "names a limit" a uniform rescue is what actually holds the invariant.
//
// The message bullets are NOT a signal on their own: #63's fixture has a live banner
// rendering as "● You've hit your session limit · resets 2:10am". They mark a line only
// when nothing else on it says "render" — i.e. the bullet introduces a sentence ABOUT a
// limit rather than a limit.
const PROMPT_GLYPH = /^\s*[❯>]/;
// One class, shared with TOOL_ECHO_HEADER below, which already knew all three glyphs while
// the veto knew two — leaving "∙ It said to try again in 2 minutes" eligible when the
// identical ⏺ line was vetoed.
const MESSAGE_GLYPH = '[●⏺∙]';
const BULLET_GLYPH = new RegExp(`^\\s*${MESSAGE_GLYPH}\\s`);
// "Names a limit" is asked of the declared subset, so a phrasing the file learns anywhere
// is recognised here too. Restating the phrasings made this an ALLOWLIST once already: it
// knew "● You've hit your session limit …" but not "● Claude usage limit reached · resets
// 2pm", "● Session limit reached · resets 9pm", "⏺ Your 5-hour limit resets 3pm" or
// "● You're out of extra usage · resets 3pm" — each a phrase LIMIT_PATTERNS already carried,
// each demoted under whatever stale banner sat above it.
// Plus the API's own underscored vocabulary, which `● API Error: 429 rate_limit_error, try
// again in 15 minutes` renders and `/rate limit/i` cannot reach. It is added HERE rather
// than to LIMIT_NAME_PATTERNS deliberately: the rescue can only ever make a line eligible,
// so widening it cannot demote anything, whereas widening LIMIT_PATTERNS would widen
// isRateLimited too — and `rate_limit_error` occurs in source, JSON error bodies and grep
// output, which measurably flipped whole panes to "limited" when tried that way.
const API_LIMIT_VOCAB = /rate[_-]limit/i;            // "rate_limit_error", "rate-limited"
const NAMES_A_LIMIT = [...LIMIT_NAME_PATTERNS, API_LIMIT_VOCAB];
// The bullet may also be followed directly by the reset clause itself, with no limit named.
const BULLET_LEADS_WITH_CLAUSE = new RegExp(`^\\s*${MESSAGE_GLYPH}\\s*(?:please\\s+)?(?:resets?\\b|try again in\\b)`, 'i');
// Closers repeat: `.”)` ends "It failed (the API said “try again in 2 minutes.”)". Renders
// carry no [.?!] before a closer, so consuming a run of them costs nothing.
const SENTENCE_END = /[.?!]["'’”)\]]*\s*$/;
const RESET_TAIL_WORDS = 2;                          // "(Europe/London)" → 0, "NY" → 1
// The clause matchers stop at the first unit ("resets in 3", "try again in 4 hours"), so the
// rest of a compound duration is part of the clause, not the start of a sentence.
const DURATION_TAIL = /^(?:\s*(?:and|&|\d+|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b)+/i;
// Scanned globally: a dual-limit render ("5-hour limit resets 3pm, weekly limit resets 9am
// Monday") must be measured from its LAST clause, including when both use the same matcher.
const RESET_PATTERNS_G = RESET_PATTERNS.map((p) => new RegExp(p.source, `${p.flags}g`));

// Text after the last reset clause, or null when the line carries no reset time at all.
// The explicit lastIndex advance is a guard, not an optimisation: a `g` pattern that can
// match empty never advances, so `exec` would re-return the same zero-length match forever.
// No current RESET_PATTERN can match empty, but one gaining an optional-only branch would
// hang the monitor rather than mis-parse a line — this loop runs over untrusted pane text
// on the hot path. It does NOT cover the other way to hang this loop: a non-global `exec`
// ignores lastIndex outright and always restarts at 0, so the `g` in RESET_PATTERNS_G above
// is load-bearing for termination, not just for finding the last clause. Mutation testing
// hangs on that mutant rather than failing it; the dual-limit test is what pins the flag.
function resetClauseTail(line) {
  let end = -1;
  for (const p of RESET_PATTERNS_G) {
    p.lastIndex = 0;
    for (let m = p.exec(line); m !== null; m = p.exec(line)) {
      const next = m.index + m[0].length;
      end = Math.max(end, next);
      p.lastIndex = Math.max(next, m.index + 1);
    }
  }
  return end === -1 ? null : line.slice(end);
}

// True when the line PRESENTS a reset time rather than mentioning one — the eligibility
// test for findRateLimitMessage's first pass. Also answers "does this line carry a reset
// time at all", so the clause matchers run once per line rather than twice.
function presentsResetTime(line) {
  const tail = resetClauseTail(line);
  if (tail === null) return false;
  // Absolute: the input row is the user's, whatever it says about limits.
  if (PROMPT_GLYPH.test(line)) return false;
  // Uniform rescue, ahead of every remaining signal. Each of those signals is evidence of
  // prose, and prose is all they may veto — a line naming a limit is a render however it is
  // punctuated, glyphed, or trailed. See the cost argument above: this is the direction the
  // errors are allowed to fall.
  if (NAMES_A_LIMIT.some((p) => p.test(line))) return true;
  if (BULLET_GLYPH.test(line) && !BULLET_LEADS_WITH_CLAUSE.test(line)) return false;
  if (SENTENCE_END.test(line)) return false;
  // Parenthesised qualifiers are furniture; punctuation and box-drawing are not words.
  const words = tail.replace(DURATION_TAIL, ' ').replace(/\([^)]*\)/g, ' ')
    .split(/[^\p{L}\p{N}\/:+_-]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length <= RESET_TAIL_WORDS;
}

// The spend-limit banner (#71) is the one render allowed to skip the reset-time anchor:
// "You've hit your org's monthly spend limit · run /usage-credits …" carries NO reset,
// yet both reporters confirmed the underlying 5h block resets and waiting works. With no
// reset line to anchor on, the shape itself carries the false-positive defense: both real
// renders START the line with "You've hit …" (optionally behind an echo marker), while
// prose explaining spend limits references them mid-sentence ("when you hit your monthly
// spend limit …"). The remaining anchors are the /usage-credits companion in the live
// region, and the wait produced downstream being the bounded, correctable fallback.
//
// Four things the shape has to tolerate, none of which it did — and each a TOTAL miss,
// not a weaker match, because a banner naming /usage-credits inline that fails this pattern
// is also the banner nothing else in the file recognises:
//   - THE MARKER VARIES. ⚠ and · prefix limit renders elsewhere in this file (see the TUI
//     sketch above); admitting only ⎿/└ made "⚠ You've hit your org's monthly spend limit …"
//     invisible.
//   - ⚠ ALSO ARRIVES IN EMOJI PRESENTATION. "⚠️" is U+26A0 + U+FE0F, and the variation
//     selector is neither whitespace nor part of the phrase, so it failed the whole pattern.
//   - THE BANNER CAN BE BOXED. "│ ⚠ You've hit your limit │" is the render this suite
//     already pins for SESSION banners; those survive on the unanchored LIMIT+RESET pair,
//     but the spend banner has no reset line, so this pattern is its only path in.
//   - APOSTROPHES ARE TYPOGRAPHIC. The qualifier class already admits ’ for "org’s"; the
//     "you've" ahead of it did not, so a render in curly quotes was missed as well. The
//     apostrophe itself is REQUIRED though — every real render prints one, and without it
//     "youve hit your monthly spend limit" walks the one path into a wait that needs no
//     reset time to corroborate it.
//
// And one it has to EXCLUDE: `^\s*` is not an anchor. Model output wraps with a hanging
// indent, so a continuation line begins with whitespace and then whatever the sentence was
// up to — quoting the banner ("⏺ The team banner reads:" / "  You've hit your org's monthly
// spend limit · …") false-fired a 5h wait and then typed retries into an idle session. A
// render starts at column 0, behind a box border, or behind an echo marker; indented with
// none of those is a wrap. (A quotation that lands at column 0 still fires; the remaining
// anchors are the live-region gate and the bounded, correctable fallback the wait lands on.)
// Trailing punctuation is deliberately NOT a signal: "You've hit your monthly spend limit."
// — the individual variant from the #71 report — is a real render with a full stop.
//
// WHICH PREFIX MAY BE INDENTED IS THEREFORE PART OF THE SHAPE, and the classes differ:
//   - ⎿/└ are TOOL-ECHO markers. They render as indented children of the notice above them
//     ("● Agent \"…\" finished" / "  ⎿ You've hit …"), so they must be allowed leading space.
//     Neither is a character prose reaches for, so that costs nothing.
//   - │ is a BOX BORDER, and a box is indented or not as a whole — it carries its own
//     column-0 evidence, so leading space costs nothing there either.
//   - ⚠/· are BARE BANNER markers, and outside a box the TUI prints them flush left.
//     Indented, they are prose BULLETS: a model quoting the banner bullets it far more often
//     than it hangs it under a bare indent, so admitting them there reopens the very wrap
//     hole the paragraph above closes.
// (● / ⏺ stay out entirely: the assistant-message glyph, so "⏺ You've hit …" is likelier a
// model quoting the banner than a render — the most dangerous prefix that could be added,
// with no reset time to check it against. A leading • stays out for the mirror-image reason:
// no render uses it, and it is purely a prose bullet.)
const SPEND_LIMIT_BODY = /you['’]ve\s+(?:hit|exceeded|reached)\s+(?:your|the)\s+(?:[\w'’-]+\s+){0,3}spend limit/;
const SPEND_LIMIT = new RegExp(
  `^(?:\\s*[⎿└]\\s*|\\s*│\\s*(?:[⚠·]\\uFE0F?\\s*)?|[⚠·]\\uFE0F?\\s*)?${SPEND_LIMIT_BODY.source}`, 'i');
// The column-0 rule above is a rendering assumption, and a one-space margin ahead of ⚠ — or
// a genuine hanging wrap of a REAL banner — is a total miss when it turns out wrong. This is
// the escape hatch: same banner words, no column-0 rule, and consulted ONLY when the pane's
// companion is a STANDALONE row rather than a hint the banner names inline (see
// isRateLimited). Quoting prose reproduces the banner LINE; it essentially never also
// reproduces the separate "/usage-credits to finish…" row beneath it, so that row
// substitutes for the shape evidence the indent gave up. Prose bullet glyphs (•, -, *) stay
// out even here: no render prints them at any indent.
const SPEND_LIMIT_INDENTED = new RegExp(`^\\s*(?:[⚠·]\\uFE0F?\\s*)?${SPEND_LIMIT_BODY.source}`, 'i');

const WINDOW = 6;

function hasNearbyMatch(lines, idx, patterns, mask = null) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (mask && mask[j]) continue;
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

// --- Tool-call echo (#63) ---
// Error/limit text inside a tool-call render — a grep argument, a quoted log line in the
// result block — is text ABOUT an error, never the live state, yet it sits in the most
// recent content rows where the tail window rightly looks. Mask the `● Name(` header (the
// glyph alone doesn't discriminate — real API errors render `● API Error: …` too, but
// never as `Name(…)`) and the `⎿`/`└`/indented children UNDER such a header. Result
// markers must NOT mask on their own: a live banner interrupting a tool/agent call
// renders as a `└` child of a NON-`Name(` notice (`● Agent "…" finished` → `└ You've hit
// your session limit …` — an observed live incident this suite pins). The mask is always
// computed over the FULL pane and sliced to the detection window afterwards: a window that
// starts mid-block (tool result taller than the tail) must still know its leading lines
// are children of a header above the window. Known limits: a header wrapped (not
// truncated) across rows leaves its continuation unmasked, and "full pane" means the
// captured pane — a result block taller than the monitor's ~120-line capture leaves its
// header outside the capture entirely, and the leading children are unmasked again.
const TOOL_ECHO_HEADER = new RegExp(`^\\s*${MESSAGE_GLYPH}\\s*\\S+\\(`);   // "● Bash(grep …", "⏺ Read(file …"
const TOOL_ECHO_RESULT = /^\s*[⎿└]/;             // "  ⎿  3"
export function toolEchoMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (TOOL_ECHO_HEADER.test(l)) { inBlock = true; mask[i] = true; continue; }
    if (inBlock && (TOOL_ECHO_RESULT.test(l) || (/^\s/.test(l) && l.trim() !== ''))) { mask[i] = true; continue; }
    inBlock = false;
  }
  return mask;
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
  // Tool-echo mask (#63), TUI only: print mode scans process output where quoted error
  // shapes ARE the real signal. The window is applied first (echo lines still consume
  // tail budget, so the window can't reach past a tall tool render into stale
  // scrollback), but the mask itself is computed over the FULL pane and sliced — a
  // result block taller than the window would otherwise hide its own `● Name(` header
  // above the window and leave the quoted children unmasked.
  let lines = all, mask = null;
  if (tailLines > 0) {
    const { start, end } = contentTailRange(all, tailLines);
    lines = all.slice(start, end);
    mask = toolEchoMask(all).slice(start, end);
  }

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
    // The companion must not itself be tool echo (a grep for "/usage-credits" quoting
    // banner text would otherwise satisfy both the companion and the nearby-reset check).
    const fullMask = toolEchoMask(all);
    const companionIdx = all.findLastIndex((l, i) => !fullMask[i] && USAGE_CREDITS.test(l));
    // Require a RESET line nearby — NOT just a LIMIT line. A live limit banner always prints
    // its reset time next to the companion; a session merely *explaining* usage limits ("when
    // you hit your usage limit you can run /usage-credits …") has the companion + a loose
    // "usage limit" LIMIT match but no reset time, and would otherwise false-fire a retry.
    // The SPEND_LIMIT alternative (#71) is the one exception to the reset-anchor rule:
    // that banner never prints a reset time, so the companion + live-region gates above
    // are its whole defense, and the pattern stays banner-shaped to compensate.
    if (companionIdx !== -1 && all.slice(companionIdx + 1).every(isChromeLine)) {
      // …unless the companion we found is the STANDALONE row rather than a hint named
      // inline by the banner itself. That row is a liveness signal a quotation essentially
      // never carries, so it stands in for the banner's column-0 shape and the indent-
      // tolerant pattern is allowed in — recovering a real render printed one space too far
      // right, or wrapped. companionIdx is the LAST /usage-credits line, so "the companion
      // is its own row" is exactly USAGE_CREDITS_HINT applied to it.
      const spendShapes = USAGE_CREDITS_HINT.test(all[companionIdx])
        ? [SPEND_LIMIT, SPEND_LIMIT_INDENTED] : [SPEND_LIMIT];
      if (hasNearbyMatch(all, companionIdx, RESET_PATTERNS, fullMask)
          || hasNearbyMatch(all, companionIdx, spendShapes, fullMask)) {
        return true;
      }
    }
  }

  // Find a "limit" line with a "resets" line nearby (works for both
  // single-line messages and multi-line TUI renders)
  for (let i = 0; i < lines.length; i++) {
    if (mask && mask[i]) continue;
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS, mask)) return true;
    }
  }

  return false;
}

// Has the session RESUMED past its limit banner? Used by the monitor's waiting branch,
// where plain isWorking() was too loose: `Retrying in …`/`attempt N/M` match transcript
// text, so a flaky-deploy log line lingering ABOVE a live banner made every expiry tick
// look like "user continued" — the monitor churned waiting↔user-continued forever and
// never sent the retry. Ordering is the discriminator: a session that actually resumed
// renders its new work BELOW the banner; working lines above it are history. When no
// banner is in the window (scrolled away after a real resume, or entered via custom
// patterns), fall back to plain isWorking — same behavior as before.
export function resumedAfterLimit(text, tailLines = 0) {
  const all = stripAnsi(text).split('\n');
  const { start, end } = tailLines > 0 ? contentTailRange(all, tailLines)
    : { start: 0, end: all.length };
  const lines = all.slice(start, end);
  const mask = toolEchoMask(all).slice(start, end);
  let lastLimit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) lastLimit = i;
  }
  if (lastLimit === -1) return isWorking(text);
  return lines.slice(lastLimit + 1).some(isWorkingLine);
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
// Windowed lines PLUS their tool-echo mask (#63). The mask is computed on the full pane
// and sliced to the window, so a result block taller than the window keeps its children
// masked even when the `● Name(` header sits above the window.
function tail(text) {
  const all = stripAnsi(text).split('\n');
  const { start, end } = contentTailRange(all, OVERLOAD_TAIL_LINES, OVERLOAD_MAX_RAW_LINES);
  return { lines: all.slice(start, end), mask: toolEchoMask(all).slice(start, end) };
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

// A REAL overload always renders as an `API Error:` line ("API Error: 529 …", "API Error:
// Server is temporarily limiting requests …", or "API Error: …" one line above a JSON
// `overloaded_error` body). Requiring that line nearby — the same discipline safeguardMatch
// uses — keeps the phrase patterns ("temporarily limiting requests", "overloaded_error")
// from firing when they're merely quoted/discussed in the pane (e.g. a session explaining
// this tool, or a chat about API errors). Mirrors SAFEGUARD_ANCHOR.
const OVERLOAD_ANCHOR = [/\bAPI Error\b/i];

// Returns { pattern, line } for the first overload pattern matching a tail line (with an
// `API Error` line nearby), else null. Per-line (not whole-tail) so we can report WHICH
// line tripped it — invaluable for diagnosing a future false positive (the original bug
// logged no reason at all).
export function overloadMatch(text, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  // Tool-echo mask (#63): a quoted "API Error: 529 overloaded" in a Bash() render carries
  // its own anchor on the same line, so the anchor discipline alone can't reject it.
  const { lines, mask } = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, OVERLOAD_ANCHOR, mask)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) };
      }
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
  // Same tool-echo discipline as overloadMatch (#63): a quoted safeguard line in a tool
  // render can sit next to a quoted API Error anchor.
  const { lines, mask } = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, SAFEGUARD_ANCHOR, mask)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) };
      }
    }
  }
  return null;
}

export function detectSafeguard(text, patterns = []) {
  return safeguardMatch(text, patterns) !== null;
}

// --- Interrupted-stream detection (truncated turn) ---
// Claude Code wraps the response body in a byte watchdog. When bytes stop arriving it
// aborts the stream and finalizes whatever was already yielded, tagging the cause on an
// `API Error:` line: a suspended machine, a dropped connection, a stalled stream, a server
// error. The turn then ENDS at an idle prompt — Claude Code retries by itself only while
// the response is still thinking-only, so by the time this render exists it has already
// declined to retry. Nothing resumes the work until something is typed. That's the gap
// this closes; see DEFAULT_STREAM_INTERRUPTED for the full render set.
//
// Anchor: "an API Error line nearby" — the rule the safeguard and overload families use —
// is NOT enough here. Those phrases are jargon; these are ordinary English about a common
// event ("your computer went to sleep"), so a session that merely EXPLAINS them quotes the
// whole render, anchor included, mid-sentence. The discriminator is therefore the SHAPE of
// the line (#73): a real render BEGINS with `API Error:`, behind at most Claude's message
// glyph. Prose carries it mid-line; the user's own line carries ❯ instead of ⏺.
//
// The glyph and the indentation are ONE rule, not two independent ones: a glyphed head may
// sit anywhere (the TUI indents blocks), but a BARE head must start at column 0. Allowing
// arbitrary indentation on a glyph-less head admits the hanging-indent shape of a quotation
// — "⏺ The error I saw was:" / "  API Error: Your computer went to sleep…" — which is the
// same wrap/quotation class #75 closed for SPEND_LIMIT. A real head is never indented: it
// STARTS its line, and a narrow pane wraps the head's tail downward, never the head itself.
const RENDER_HEAD = /^(?:\s*[⏺●]\s+)?API Error:/i;
// A render head fills a terminal row, so the cause clause can wrap onto the next
// (indented) row. Two lines covers the wrap without reaching into whatever follows.
const RENDER_WRAP_LINES = 2;

export function streamInterruptedMatch(text, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  // Same windowing and tool-echo discipline as the overload/safeguard matchers (#63): the
  // render quoted inside a Bash result is scrollback, not a live truncated turn.
  const { lines, mask } = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || !RENDER_HEAD.test(lines[i])) continue;
    const last = Math.min(i + RENDER_WRAP_LINES, lines.length - 1);
    for (let j = i; j <= last; j++) {
      // Past the head, the render continues only while the lines stay indented. The first
      // flush-left line STARTS THE NEXT BLOCK, so it ends the window — skipping past it let
      // the scan reach a later block's continuation and attribute its phrase to this head.
      if (j > i && !/^\s/.test(lines[j])) break;
      if (mask[j]) continue;
      for (const r of regexes) {
        if (r.test(lines[j])) return { pattern: r.source, line: lines[j].trim().slice(0, 200) };
      }
    }
  }
  return null;
}

export function detectStreamInterrupted(text, patterns = []) {
  return streamInterruptedMatch(text, patterns) !== null;
}

// --- Near-limit wrap-up notice (#78) ---
// "⏺ Approaching your 5-hour usage limit — Claude will wrap up the current step." At ~95%
// of the window Claude Code prints this and injects a checkpoint instruction; the model
// finishes the step, lists what's left and ends the turn at an idle prompt with NO limit
// banner. Unlike every other render this file matches, the notice is NOT the last content
// line — the model's wrap-up output follows it — so the window is wider than the banner
// tail, and "still live" is decided by what sits BELOW the notice rather than by where it
// sits: a user row (❯/> plus text) below it means the turn it introduced has already been
// answered — by the user, or by our own nudge, which renders exactly that way. Bottom-up,
// the first user row met above any notice ends the search. That row is the dedup.
//
// Shape-anchored like the #77 render head: the notice BEGINS its line, behind at most a
// message glyph — a glyphed head may be indented (the TUI indents blocks), a bare head must
// start at column 0 — so prose quoting it mid-line and a user-typed copy never match.
const WRAP_UP_TAIL_LINES = 40;
const WRAP_UP_HEAD = new RegExp(`^(?:\\s*${MESSAGE_GLYPH}\\s+)?Approaching your [\\w-]+(?: usage)? limit\\s+[—–-]+\\s+Claude will wrap up`, 'i');
const USER_ROW = /^\s*[❯>]\s+\S/;
export function nearLimitWrapUpMatch(text) {
  const all = stripAnsi(text).split('\n');
  const { start, end } = contentTailRange(all, WRAP_UP_TAIL_LINES);
  const lines = all.slice(start, end);
  const mask = toolEchoMask(all).slice(start, end);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (mask[i]) continue;
    if (USER_ROW.test(lines[i])) return null;
    if (WRAP_UP_HEAD.test(lines[i])) return lines[i].trim();
  }
  return null;
}

// Chrome-aware, so isWorking measures the SAME bottom as isRateLimited/detectOverload. A
// live working footer pushed up by a tall chrome stack below it (task widget + input box
// + footer) would be invisible to a raw last-N tail while the chrome-aware detectors still
// saw a lingering banner — the asymmetry that let retry text land in a mid-flight session
// (Finding 3). isChromeLine excludes working lines, so contentTail never strips the footer.
export function isWorking(text) {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES).some(isWorkingLine);
}

// Claude Code's OWN internal-retry render ("… · Retrying in 5s · attempt 3/10"). It
// satisfies isWorking (the turn is open and must not be interrupted), but it is the
// opposite of RECOVERY — the turn is still failing. Consumers inferring "the incident
// ended well" from a working pane (the event-path overload budget reset) must exclude it,
// or a sustained outage's in-flight retries zero the backoff budget every cycle and the
// give-up cap never trips.
const INTERNAL_RETRY_PATTERNS = [/Retrying in\b/i, /\battempt\s+\d+\/\d+/i];
export function isInternalRetry(text) {
  return contentTail(stripAnsi(text).split('\n'), OVERLOAD_TAIL_LINES)
    .some((l) => INTERNAL_RETRY_PATTERNS.some((p) => p.test(l)));
}

// tailLines > 0 bounds the scan to the same chrome-aware window isRateLimited uses. The
// unbounded scan reaches the FULL capture, so any non-chrome, non-echo line anywhere in
// ~120 lines that merely *looks* like a reset ("…try again in 2 minutes…" in model prose,
// user-typed text, a wrapped tool result past the mask's continuation gap) wins the
// bottom-up scan over the real banner. That was survivable while this ran once at
// detection; the monitor now re-derives during the wait, where shorten-only means the
// earliest bogus time wins and a *correct* multi-hour wait can collapse to minutes — the
// monitor then wakes into the still-live limit and burns its retries before the real
// reset. Callers that gate on isRateLimited must pass the same window it read. 0 keeps the
// full scan for print mode, where the input is process output rather than a scrolling TUI.
export function findRateLimitMessage(text, customPatterns = [], tailLines = 0) {
  const all = stripAnsi(text).split('\n');
  // Tool-echo mask (#63): without it, a quoted "resets 9am" in a fresh grep line below a
  // real banner would win the bottom-up scan and be parsed instead of the banner.
  // Chrome is skipped for the same reason (#61): a usage-meter statusline row
  // ("⟳ resets in 1 hr 47 min") always renders below the banner, so it won the scan —
  // and parseResetTime can't read it, turning a known reset time into the 5h fallback.
  // The mask is computed over the FULL pane and sliced, so a block whose `● Name(` header
  // sits above the window keeps its children masked (same discipline as isRateLimited).
  const { start, end } = tailLines > 0 ? contentTailRange(all, tailLines)
    : { start: 0, end: all.length };
  const lines = all.slice(start, end);
  const fullMask = toolEchoMask(all).slice(start, end);
  const skip = (i) => fullMask[i] || isChromeLine(lines[i]);
  const isReset = (i) => RESET_PATTERNS.some(p => p.test(lines[i]));
  const presentsReset = (i) => presentsResetTime(lines[i]);

  // Scan from the bottom up — the most recent line is the live one. The Claude TUI never
  // clears earlier rate-limit messages from scrollback, so a forward scan would lock onto
  // a stale line (an old "resets 11:30am" lingering above a fresh "resets 4:30pm").
  //
  // Freshness stays the outer rule; what #73 changes is which lines are eligible. Prose
  // ABOUT a limit is vetoed, so it can no longer outrank the banner above it — but
  // eligibility is decided per line, never by looking at a neighbour. An earlier fix
  // attempt qualified a candidate by searching for a limit line nearby, which inverted
  // freshness (every reset it could return lay at or above the candidate), let prose that
  // merely contained "usage limit" act as the qualifier, and chained two WINDOWs into a
  // 12-line reach. Per-line eligibility has none of those failure modes.
  //
  // This pass can still reach past a lower line — that is the point — so every line it
  // passes over had better be conversation. The failure mode is asymmetric: skipping a real
  // render costs a stale, LATCHED wait (see presentsResetTime), while stopping on prose
  // costs a short one that #70 revisits. So the prose signals are kept subordinate to the
  // limit name rather than being tuned to recognise banners — "does this look like a banner
  // I know" is what inverts freshness, one unrecognised render at a time.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (skip(i)) continue;
    if (presentsReset(i)) return lines[i].trim();
  }

  // Every reset-shaped line on screen was vetoed. Everything below is the pre-#73 behavior
  // unchanged, so a pane made only of talk about a limit degrades to exactly what the scan
  // returned before rather than to null.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (skip(i)) continue;
    if (isReset(i)) return lines[i].trim();
  }

  // Fallback: any "limit" line, also scanned from the bottom. Renders carrying no reset at
  // all land here — the spend-limit banner (#71).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (skip(i)) continue;
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}
