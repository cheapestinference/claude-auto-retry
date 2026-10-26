import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Transient API-error backoff (529 Overloaded / 500 / 503). Separate block from
// the usage-limit knobs above: those wait in *hours* until a reset, these wait in
// *seconds* on an exponential backoff. See README "Overload backoff".
export const DEFAULT_OVERLOAD = {
  enabled: true,
  // Anchored to Claude Code's actual TERMINAL error render — NOT bare status numbers.
  // A bare "503"/"529" matches ordinary code (res.status(503)), ports, byte counts and
  // quoted logs, which is what caused false "Continue where you left off." injections.
  // Matched as case-insensitive regexes against only the pane tail (see detectOverload).
  //
  // Claude Code (verified against the v2.1.x binary) has TWO render forms:
  //   terminal (retries exhausted):  "API Error: 529 {…}"  / "API Error: 503 no healthy upstream"
  //   transient (still retrying):     "API Error (529 …) · Retrying in 5s · attempt 3/10"
  // We REQUIRE the colon form to skip the parens form, and the retry SUFFIX
  // ("· Retrying in…" / "attempt n/m") is separately suppressed by the working gate
  // in patterns.js — together they ensure we never interrupt Claude's own backoff.
  patterns: [
    // Terminal error line. Covers the full retryable set (429+5xx) in the colon form.
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    // JSON error.type for a sustained overload (survives the collapsed non-JSON render).
    'overloaded_error',
    // API-level 429 uses a dedicated render with no 3-digit code in the generic slot:
    //   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
    'temporarily limiting requests',
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  // StopFailure event markers older than this are ignored (guards against a recycled
  // tmux pane id replaying a stale failure, or acting on a marker left while down).
  eventMaxAgeSeconds: 120,
  retryMessage: 'Continue where you left off.',
  // Gating: by default we only act when claude is alive at its prompt (the
  // foreground safety check passes). If a 500 ever drops you to the shell, the
  // send-keys is correctly blocked and nothing resumes; flip relaunchOnExit to
  // re-enter via relaunchCommand. Off by default — never type into a shell the
  // user may be using. See README "Gating decision".
  relaunchOnExit: false,
  relaunchCommand: 'claude --continue',
};

// Safeguard / AUP false-positive retry. Distinct from usage limits (hours) and overload
// (5xx, exponential): the model's safeguards flag a message — often a false positive, so
// an immediate re-send usually clears it. Bounded by maxRetries so a *sticky* flag can't
// loop forever. See README "Safeguard retry".
export const DEFAULT_SAFEGUARD = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail; a match only counts with an
  // `API Error` line nearby (see safeguardMatch) so quoting/discussing these phrases in
  // conversation can't trigger a retry. Match the stable phrases of the render, not the
  // model name (which varies).
  patterns: [
    "safeguards flagged this message",
    "can't respond to this request with",   // "Claude Code can't respond to this request with <model>"
    "legal/aup",                             // the AUP link Anthropic includes
  ],
  maxRetries: 3,          // small — if it keeps flagging, retrying won't help
  retryDelaySeconds: 8,   // brief pause between re-sends (semi-random flag; quick retry helps)
  retryMessage: 'continue',
};

// Interrupted-stream resume. A third failure family, distinct from usage limits (hours)
// and overload (5xx, exponential): Claude Code's byte watchdog aborted a stream mid-turn
// and finalized whatever had already been yielded. The turn is OVER — the prompt returns
// idle and nothing resumes it — so the session sits untouched until something is typed.
// Claude Code retries these by itself only while the response is still thinking-only; once
// real content has been yielded it declines to retry, which is precisely when this renders.
// A single "continue" picks the work back up. Bounded, because a machine that just woke may
// not have its network back yet and the resumed turn can fail the same way.
export const DEFAULT_STREAM_INTERRUPTED = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail, and only against a line that
  // BEGINS with the `API Error:` render (see streamInterruptedMatch). These phrases are
  // ordinary English about a common event, so the "anchor nearby" rule the safeguard and
  // overload families use is not enough here — a session explaining them quotes the whole
  // render, anchor included, mid-sentence.
  // The full set the stream finalizer emits, by cause:
  //   suspend      → "Your computer went to sleep {mid-response | before a response was produced}"
  //   idle timeout → "The response stopped arriving" / "The response stalled before …"
  //   connection   → "Connection lost {mid-response | before a response was produced}"
  //   server error → "Server error mid-response"
  // All seven leave the pane in the same truncated-turn state, so they share one remedy.
  patterns: [
    'went to sleep mid-response',
    'went to sleep before a response was produced',
    'response stopped arriving',
    'response stalled before a response was produced',
    'Connection lost mid-response',
    'Connection lost before a response was produced',
    'Server error mid-response',
  ],
  maxRetries: 2,          // small — if resuming keeps truncating, something else is wrong
  retryDelaySeconds: 5,   // let the network settle after a wake before typing
  retryMessage: 'continue',
};

// Near-limit wrap-up (#78). At ~95% of the 5-hour window Claude Code injects a checkpoint
// instruction into the model's context and prints "⏺ Approaching your 5-hour usage limit —
// Claude will wrap up the current step." The model finishes the step, lists what's left and
// ENDS THE TURN: no limit banner, an idle prompt, and nothing resumes the session — the
// window resets hours later with the session still parked. One nudge picks the work back
// up; the session then either finishes or hits the real limit, which the usage-wait
// handles. Not a bounded-retry machine like the families above: the nudge renders as a
// user row under the notice, which is the dedup — one nudge per notice, by construction.
// maxRetries only bounds the pathological case where the nudge never renders.
export const DEFAULT_NEAR_LIMIT_WRAP_UP = {
  enabled: true,
  maxRetries: 3,
  retryMessage: 'continue',
};

// Native auto-continue gone stale (Claude Code v2.1.234+). Native waits out a usage limit
// by itself, but if the host slept more than ~30 min past the reset it does NOT continue:
// its two status lines turn into "Your usage limit has reset" / "Press enter to continue"
// and it waits for a human Enter, indefinitely. Our own wait stood down on that screen
// (the banner is gone), so nobody pressed it. The remedy is the keypress the UI asks for —
// a bare Enter, no message — so there are no patterns (the render is fixed and
// shape-anchored, see staleResetMatch) and no retryMessage. Bounded: if two Enters don't
// clear it, something other than staleness is holding the session.
export const DEFAULT_NATIVE_STALE_RESET = {
  enabled: true,
  maxRetries: 2,
  retryDelaySeconds: 3,   // let the wake settle (and native's own UI finish redrawing) first
};

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
  streamInterrupted: DEFAULT_STREAM_INTERRUPTED,
  nearLimitWrapUp: DEFAULT_NEAR_LIMIT_WRAP_UP,
  nativeStaleReset: DEFAULT_NATIVE_STALE_RESET,
  // Extra seconds added to a usage wait when native auto-continue (Claude Code v2.1.234+)
  // is visibly armed on the same screen. Native fires at reset + 30–90 s; ours at reset +
  // marginSeconds — so without this the two race, and when ours wins its typed "continue"
  // cancels the native wait. Deferring lets native continue first; ours becomes the
  // backstop for when it didn't (the recheck then stands down on a resumed session).
  // 0 = no defer.
  nativeDeferSeconds: 180,
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function clamp(val, lo, hi, fallback) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(hi, Math.max(lo, val));
}

function validateOverload(raw) {
  // Shallow-merge so a partial user block keeps the documented defaults for the
  // keys it omits (JSON.parse's spread would otherwise replace the whole block).
  const o = { ...DEFAULT_OVERLOAD, ...(raw && typeof raw === 'object' ? raw : {}) };

  o.enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_OVERLOAD.enabled;

  // Patterns are case-insensitive regexes (see detectOverload).
  o.patterns = validPatterns(o.patterns, DEFAULT_OVERLOAD.patterns);

  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  o.backoffSeconds = backoff.length > 0 ? backoff : [...DEFAULT_OVERLOAD.backoffSeconds];

  o.steadyStateSeconds = validNumber(o.steadyStateSeconds, 1, DEFAULT_OVERLOAD.steadyStateSeconds);
  o.jitterPct = clamp(o.jitterPct, 0, 100, DEFAULT_OVERLOAD.jitterPct);
  o.maxTotalWaitMinutes = validNumber(o.maxTotalWaitMinutes, 0.1, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  o.eventMaxAgeSeconds = validNumber(o.eventMaxAgeSeconds, 1, DEFAULT_OVERLOAD.eventMaxAgeSeconds);

  if (typeof o.retryMessage !== 'string' || !o.retryMessage) {
    o.retryMessage = DEFAULT_OVERLOAD.retryMessage;
  }
  o.relaunchOnExit = typeof o.relaunchOnExit === 'boolean' ? o.relaunchOnExit : DEFAULT_OVERLOAD.relaunchOnExit;
  if (typeof o.relaunchCommand !== 'string' || !o.relaunchCommand) {
    o.relaunchCommand = DEFAULT_OVERLOAD.relaunchCommand;
  }
  return o;
}

// Keep only non-empty strings that actually compile, so a typo'd user pattern can't crash
// the monitor tick. Shared by every pattern-carrying block.
function validPatterns(raw, defaults) {
  const pats = Array.isArray(raw)
    ? raw.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  return pats.length > 0 ? pats : [...defaults];
}

// Per-field validators for the bounded-family blocks below. Each takes the merged value and
// the block's default for that field and returns the value to keep.
const BLOCK_FIELD_VALIDATORS = {
  // Case-insensitive regexes; see validPatterns.
  patterns: (v, d) => validPatterns(v, d),
  maxRetries: (v, d) => validNumber(v, 1, d),
  retryDelaySeconds: (v, d) => validNumber(v, 1, d),
  retryMessage: (v, d) => (typeof v === 'string' && v ? v : d),
};

// ONE validator for every bounded-family block, parameterized by the fields that block
// carries. There used to be three near-copies (bounded retry, message nudge, key nudge) that
// differed only in which of these fields they checked — the third copy is where the next
// drift would have landed. Shallow-merged onto the defaults so a partial user block keeps
// the documented defaults for the keys it omits; `enabled` is common to every block.
// Overload keeps its own validator: a backoff schedule and relaunch knobs don't fit here.
function validateBlock(raw, defaults, fields) {
  const b = { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.enabled = typeof b.enabled === 'boolean' ? b.enabled : defaults.enabled;
  for (const f of fields) b[f] = BLOCK_FIELD_VALIDATORS[f](b[f], defaults[f]);
  return b;
}

// The block shapes, by what each family needs:
//   bounded retry (safeguard, streamInterrupted) — patterns + cap + delay + message.
//   message nudge (nearLimitWrapUp) — the render is fixed and shape-anchored (no patterns)
//     and it fires at the idle prompt (no delay).
//   key nudge (nativeStaleReset) — a bare Enter, not a message, on a fixed render: no
//     patterns and no retryMessage, but a delay.
const BOUNDED_RETRY_FIELDS = ['patterns', 'maxRetries', 'retryDelaySeconds', 'retryMessage'];
const MESSAGE_NUDGE_FIELDS = ['maxRetries', 'retryMessage'];
const KEY_NUDGE_FIELDS = ['maxRetries', 'retryDelaySeconds'];

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.nativeDeferSeconds = validNumber(cfg.nativeDeferSeconds, 0, DEFAULT_CONFIG.nativeDeferSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (!Array.isArray(cfg.customPatterns)) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  } else {
    cfg.customPatterns = cfg.customPatterns.filter(p => {
      if (typeof p !== 'string') return false;
      try { new RegExp(p); return true; } catch { return false; }
    });
  }
  if (cfg.foregroundCommands !== undefined) {
    if (!Array.isArray(cfg.foregroundCommands) || cfg.foregroundCommands.length === 0) {
      delete cfg.foregroundCommands;
    }
  }
  cfg.overload = validateOverload(cfg.overload);
  cfg.safeguard = validateBlock(cfg.safeguard, DEFAULT_SAFEGUARD, BOUNDED_RETRY_FIELDS);
  cfg.streamInterrupted = validateBlock(cfg.streamInterrupted, DEFAULT_STREAM_INTERRUPTED, BOUNDED_RETRY_FIELDS);
  cfg.nearLimitWrapUp = validateBlock(cfg.nearLimitWrapUp, DEFAULT_NEAR_LIMIT_WRAP_UP, MESSAGE_NUDGE_FIELDS);
  cfg.nativeStaleReset = validateBlock(cfg.nativeStaleReset, DEFAULT_NATIVE_STALE_RESET, KEY_NUDGE_FIELDS);
  return cfg;
}

export async function loadConfig(path = CONFIG_PATH) {
  try {
    const raw = await readFile(path, 'utf-8');
    return validate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
