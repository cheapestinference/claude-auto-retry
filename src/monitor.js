import { stripAnsi, isRateLimited, findRateLimitMessage, isRateLimitOptionsPrompt, menuStepsToWaitOption, detectOverload, overloadMatch, detectSafeguard, safeguardMatch, isWorking } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, sendKey, getPaneCommand, isProcessForeground } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { readStopFailureEvent, clearStopFailureEvent, isRetryableError } from './events.js';
import { writeStatus, clearStatus, sweepStaleStatus } from './status-file.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];
const SHELL_COMMANDS = ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'];
// Only a usage-limit banner in the live tail counts — quoted limit text in scrollback
// (a conversation about limits) or a banner the session already scrolled past is not the
// current state and must not drive a retry. Matches the overload path's tail discipline.
const RATE_LIMIT_TAIL_LINES = 12;

export function createMonitorState() {
  return {
    status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null,
    // Overload-retry sub-state, kept distinct from the usage-reset fields above.
    overloadAttempts: 0, overloadTotalWaitMs: 0, overloadWaitUntil: 0,
    // viaEvent marks the current backoff window as event-triggered (edge: one send per
    // failure). The scraper stays active alongside the event path — see the tick logic.
    viaEvent: false,
    // Safeguard/AUP false-positive retry sub-state (bounded, seconds-scale).
    safeguardAttempts: 0, safeguardWaitUntil: 0,
  };
}

// --- Overload backoff schedule (pure, testable) ---
// Wait backoffSeconds[i] for attempt i; once the array is exhausted, steadyStateSeconds.
export function overloadBaseWaitMs(attemptIndex, overload) {
  const { backoffSeconds, steadyStateSeconds } = overload;
  const secs = attemptIndex < backoffSeconds.length ? backoffSeconds[attemptIndex] : steadyStateSeconds;
  return secs * 1000;
}

export function applyJitter(ms, jitterPct, rand = Math.random) {
  if (!jitterPct) return ms;
  const factor = 1 + (rand() * 2 - 1) * (jitterPct / 100);  // ±jitterPct%
  return Math.max(0, Math.round(ms * factor));
}

export function nextOverloadWaitMs(attemptIndex, overload, rand = Math.random) {
  return applyJitter(overloadBaseWaitMs(attemptIndex, overload), overload.jitterPct, rand);
}

function resetOverload(state) {
  state.overloadAttempts = 0;
  state.overloadTotalWaitMs = 0;
  state.overloadWaitUntil = 0;
  state.viaEvent = false;
  state._gaveUp = false;
  state._eventHandledBanner = null;
}

function resetSafeguard(state) {
  state.safeguardAttempts = 0;
  state.safeguardWaitUntil = 0;
  state._safeguardGaveUp = false;
  state._gaveUp = false;
}

// Foreground safety: is claude/node the foreground process (safe to send-keys), or did
// it exit to a shell / is some other app focused? Returns { ok, fg, isShell }.
async function checkForeground(tmuxAdapter, pane, config) {
  const isFg = await tmuxAdapter.isClaudeForeground();
  if (isFg === true) return { ok: true, fg: null, isShell: false };
  const fg = await tmuxAdapter.getPaneCommand(pane);
  const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
  if (fgCommands.some(c => fg.toLowerCase().includes(c))) return { ok: true, fg, isShell: false };
  const lc = (fg || '').toLowerCase();
  const isShell = lc !== '' && SHELL_COMMANDS.some(s => lc === s || lc.includes(s));
  return { ok: false, fg, isShell };
}

function enterUsageWait(state, stripped, config) {
  const message = findRateLimitMessage(stripped, config.customPatterns);
  state.lastRateLimitMessage = message;
  const parsed = message ? parseResetTime(message) : null;
  state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  state.status = 'waiting';
  state._gaveUp = false;
  return 'waiting';
}

function enterOverload(state, overload, rand) {
  const capMs = overload.maxTotalWaitMinutes * 60_000;
  resetOverload(state);
  state.status = 'overload';
  const w = nextOverloadWaitMs(0, overload, rand);
  if (w > capMs) {
    // Degenerate config (first backoff already exceeds the cap): force the cap to
    // trip on the next tick rather than entering a real retry loop.
    state.overloadTotalWaitMs = capMs;
    state.overloadWaitUntil = 0;
    return 'overload-detected';
  }
  state.overloadTotalWaitMs = w;
  state.overloadWaitUntil = Date.now() + w;
  return 'overload-detected';
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive, rand = Math.random) {
  if (!isAlive()) return 'exit';

  // Capture generously (was 20): a live banner can sit far above the bottom behind a tall
  // task widget + input box + footer. The detectors chrome-strip and tail-window this, so
  // extra lines are free headroom; 50 clears a large widget with margin.
  const raw = await tmuxAdapter.capturePane(pane, 50);
  const stripped = stripAnsi(raw);
  const overload = config.overload;

  // Handle the interactive /rate-limit-options menu before any other logic. A bare
  // Enter here confirms the highlighted default, which on some Claude Code versions
  // is "Upgrade your plan". Navigate to "Stop and wait for limit to reset" wherever
  // it sits, confirm it, then enter the normal (hours-scale) wait state.
  if (tmuxAdapter.sendKey && isRateLimitOptionsPrompt(stripped, RATE_LIMIT_TAIL_LINES)
      && Date.now() >= (state._menuCooldownUntil || 0)) {
    const cooldown = config.pollIntervalSeconds * 1000 * 2;

    // Foreground safety: never send arrow/Enter keys unless Claude/node is the
    // foreground process. Otherwise, if the user switched the pane to another app
    // while the menu was up, we'd drive that app's UI instead.
    const fgOk = await checkForeground(tmuxAdapter, pane, config);
    if (!fgOk.ok) {
      state._lastForeground = fgOk.fg;
      state._menuCooldownUntil = Date.now() + cooldown;
      return 'skipped-not-claude';
    }

    const steps = menuStepsToWaitOption(stripped, RATE_LIMIT_TAIL_LINES);
    if (steps === null) {
      // Layout unreadable — refuse to press Enter (could confirm "Upgrade").
      state._menuCooldownUntil = Date.now() + cooldown;
      return 'menu-unreadable';
    }
    const key = steps >= 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(steps); i++) {
      await tmuxAdapter.sendKey(pane, key);
      await new Promise(r => setTimeout(r, 80));
    }
    await tmuxAdapter.sendKey(pane, 'Enter');
    // Parse the reset time straight from the menu text, so the wait does not depend
    // on the limit banner still being visible afterward.
    const message = findRateLimitMessage(stripped, config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    state._menuCooldownUntil = Date.now() + cooldown;
    return 'menu-confirmed';
  }

  if (state.status === 'waiting') {
    // Keep counting down UNLESS the session has resumed working. A working pane means
    // the user manually continued (often to unstick a wrong/stale wait) — falling through
    // to the isWorking gate below returns us to monitoring, so a SECOND, genuine limit that
    // follows is detected instead of being masked until the old timer expires (issue #39).
    if (Date.now() < state.waitUntil && !isWorking(stripped)) return 'waiting';
    if (!isAlive()) return 'exit';

    // Stop driving the session if the limit cleared OR Claude has already resumed and
    // is working again. Without the isWorking gate the usage path re-sends the retry
    // message every poll (up to maxRetries) while the limit banner lingers in the
    // captured scrollback after a successful resume — spamming an actively-working
    // session (and a banner re-printed by another process keeps it "rate-limited" the
    // whole time). isWorking ⇒ the session continued; never inject into it.
    if (!isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES) || isWorking(stripped)) {
      state.status = 'monitoring'; state.attempts = 0; state._gaveUp = false;
      return 'user-continued';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit on the next tick
      // and creating an infinite max-retries loop. This IS a give-up (no further
      // retries will be sent while the banner persists) even though `status` stays
      // 'waiting' — flagged so external consumers (tmux status bar) don't render a
      // perpetually-resetting countdown for a monitor that has stopped acting.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      return 'max-retries';
    }

    // Primary check: is the Claude process in the foreground process group?
    // On macOS, pane_current_command reports "zsh" instead of the child process,
    // so we use `ps -o stat=` to check the '+' (foreground) flag directly.
    // `true` short-circuits past pane_current_command (fixes macOS).
    // `false`/`null` falls back to pane_current_command for safety.
    const isFg = await tmuxAdapter.isClaudeForeground();
    if (isFg !== true) {
      const fg = await tmuxAdapter.getPaneCommand(pane);
      const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
      if (!fgCommands.some(c => fg.toLowerCase().includes(c))) {
        state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
        state._lastForeground = fg;
        return 'skipped-not-claude';
      }
    }

    // Increment attempts and set cooldown BEFORE sendKeys so that a failure
    // (e.g. pane destroyed) still consumes a retry and avoids tight-loop errors.
    state.attempts++;
    state.waitUntil = Date.now() + 30_000;
    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    return 'retried';
  }

  if (state.status === 'overload') {
    if (Date.now() < state.overloadWaitUntil) return 'overload-waiting';
    if (!isAlive()) return 'exit';

    // Event-triggered window: a StopFailure marker put us here. Edge-triggered — send
    // exactly once per failure, then return to monitoring to await the next marker. We
    // do NOT re-check the scraper for "still overloaded" (the marker was authoritative).
    if (state.viaEvent) {
      // Self-recovery: Claude resumed during the backoff → don't interrupt it.
      if (isWorking(stripped)) { resetOverload(state); state.status = 'monitoring'; return 'overload-cleared'; }
      // A usage limit appearing mid-wait still takes precedence.
      if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) { resetOverload(state); return enterUsageWait(state, stripped, config); }

      const foregroundOk = await checkForeground(tmuxAdapter, pane, config);
      if (!foregroundOk.ok) {
        state._lastForeground = foregroundOk.fg;
        state.viaEvent = false; state.status = 'monitoring';
        if (foregroundOk.isShell && overload.relaunchOnExit) {
          state.overloadAttempts++;
          await tmuxAdapter.sendKeys(pane, overload.relaunchCommand);
          return 'overload-relaunched';
        }
        return foregroundOk.isShell ? 'overload-exited-to-shell' : 'skipped-not-claude';
      }

      state.overloadAttempts++;          // next failure backs off further
      state.viaEvent = false;
      state.status = 'monitoring';
      // Remember the banner we just retried via the event path so the always-on scraper
      // doesn't re-detect this same, uncleared render next tick and open a second backoff.
      const handled = overloadMatch(stripped, overload.patterns);
      state._eventHandledBanner = handled ? `${handled.pattern} ${handled.line}` : null;
      await tmuxAdapter.sendKeys(pane, overload.retryMessage);
      return 'overload-retried';
    }

    const capMs = overload.maxTotalWaitMinutes * 60_000;

    // Usage-limit takes precedence: hand off to the (hours-scale) reset path.
    if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
      resetOverload(state);
      return enterUsageWait(state, stripped, config);
    }

    // Overload text gone → recovered. Back to plain monitoring.
    if (!detectOverload(stripped, overload.patterns)) {
      state.status = 'monitoring';
      resetOverload(state);
      return 'overload-cleared';
    }

    // Terminal-state gate: if Claude is actively working (its own internal retry
    // or a fresh response is streaming), the error is NOT terminal. Defer without
    // consuming an attempt so we never double-drive a live session.
    if (isWorking(stripped)) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'overload-working';
    }

    // Mandatory cap: give up loudly rather than hammer a genuinely-down endpoint
    // or mask a real outage. Long cooldown to avoid re-detecting the stale error.
    if (state.overloadTotalWaitMs >= capMs) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      return 'overload-gave-up';
    }

    // Foreground safety, reused from the usage path: only act when claude/node is
    // the foreground process. (See the gating decision in the README.)
    const isFg = await tmuxAdapter.isClaudeForeground();
    let foregroundOk = isFg === true;
    let fg = null;
    if (!foregroundOk) {
      fg = await tmuxAdapter.getPaneCommand(pane);
      const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
      foregroundOk = fgCommands.some(c => fg.toLowerCase().includes(c));
    }

    if (!foregroundOk) {
      // Distinguish "claude exited to the shell" (error visible above a shell
      // prompt) from "some other foreground app", for diagnostics + opt-in relaunch.
      const lc = (fg || '').toLowerCase();
      const isShell = lc !== '' && SHELL_COMMANDS.some(s => lc === s || lc.includes(s));
      state._lastForeground = fg;
      if (isShell && overload.relaunchOnExit) {
        state.overloadAttempts++;
        const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
        state.overloadTotalWaitMs += w;
        state.overloadWaitUntil = Date.now() + w;
        await tmuxAdapter.sendKeys(pane, overload.relaunchCommand);
        return 'overload-relaunched';
      }
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return isShell ? 'overload-exited-to-shell' : 'skipped-not-claude';
    }

    // Alive at the prompt → send the retry, then schedule the next backoff window.
    // Increment + schedule BEFORE sendKeys so a send failure still consumes the slot.
    state.overloadAttempts++;
    const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
    state.overloadTotalWaitMs += w;
    state.overloadWaitUntil = Date.now() + w;
    await tmuxAdapter.sendKeys(pane, overload.retryMessage);
    return 'overload-retried';
  }

  if (state.status === 'safeguard') {
    if (Date.now() < state.safeguardWaitUntil) return 'safeguard-waiting';
    if (!isAlive()) return 'exit';
    const safeguard = config.safeguard;

    // A usage limit or Claude resuming takes precedence / means recovery.
    if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
      resetSafeguard(state); return enterUsageWait(state, stripped, config);
    }
    // In flight (our retry, or the user typing continued things). Defer WITHOUT consuming
    // or resetting — a tick landing mid-retry must not zero the counter, or a sticky flag
    // re-enters with a fresh budget and the maxRetries bound never trips (verified: it
    // retried indefinitely). Mirrors the overload branch. Recovery is decided at the next
    // idle tick: flag gone -> cleared; flag still there -> the count stands.
    if (isWorking(stripped)) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'safeguard-working';
    }

    // Flag gone → recovered.
    if (!detectSafeguard(stripped, safeguard.patterns)) {
      resetSafeguard(state); state.status = 'monitoring'; return 'safeguard-cleared';
    }

    // Sticky flag: give up loudly rather than loop. Long cooldown so we don't re-detect
    // the stale error every tick.
    if (state.safeguardAttempts >= safeguard.maxRetries) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      // Give up LOUDLY — once. Subsequent holds are silent or the warn re-logs ~1/min
      // for as long as the sticky banner sits at the prompt.
      if (state._safeguardGaveUp) return 'safeguard-holding';
      state._safeguardGaveUp = true;
      return 'safeguard-gave-up';
    }

    // Foreground safety: only send when claude/node is foreground.
    const fg = await checkForeground(tmuxAdapter, pane, config);
    if (!fg.ok) {
      state._lastForeground = fg.fg;
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return 'skipped-not-claude';
    }

    // Increment + schedule BEFORE send so a send failure still consumes the slot.
    state.safeguardAttempts++;
    state.safeguardWaitUntil = Date.now() + (safeguard.retryDelaySeconds * 1000);
    await tmuxAdapter.sendKeys(pane, safeguard.retryMessage);
    return 'safeguard-retried';
  }

  // --- monitoring ---
  // Usage-limit (hours-scale reset) takes precedence over overload (seconds-scale). No
  // !isWorking gate here: it would widen every WORKING_PATTERN from "skip one injection" to
  // "never detect the limit at all", and those patterns are NOT all live-only — `Retrying
  // in …`/`attempt N/M` match transcript text (a flaky deploy/test log), so a stuck session
  // with such a line lingering would never be retried. The waiting branch's `|| isWorking`
  // guard already stops injection into a working session, which is enough to prevent the
  // background-agent spam; the cost of dropping the gate is only a cosmetic re-detection
  // cycle (detect → wait → user-continued) that never actually injects.
  if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
    return enterUsageWait(state, stripped, config);
  }

  // Event-driven overload (authoritative and faster; see DESIGN-NOTES §1). A StopFailure
  // marker for this pane means the turn ended in a retryable API error — no scraping, no
  // ambiguity. It runs first, but does NOT replace the scraper below: the event path only
  // covers overloaded/server_error, so a transient render the hook can't emit (an API 429,
  // "temporarily limiting requests") is still caught by the scraper.
  if (overload && overload.enabled && tmuxAdapter.readEvent) {
    const ev = await tmuxAdapter.readEvent();
    if (ev) {
      // Consume-side guard: trust no writer. The hook entry in settings.json freezes the
      // cli.js path + matcher at install time, so an OLDER hook binary (whose matcher and
      // RETRYABLE set still include rate_limit) can keep writing markers after an upgrade.
      // Consume-and-ignore anything non-retryable — a misclassified marker must not start a
      // backoff (the scraper below still gets its normal shot on the next tick).
      if (!isRetryableError(ev.error)) {
        await tmuxAdapter.clearEvent();             // consume so it can't re-fire
        state._ignoredEventError = ev.error;
        return 'event-ignored';
      }
      await tmuxAdapter.clearEvent();               // consume
      if (isWorking(stripped)) { resetOverload(state); return 'overload-cleared'; } // self-recovered
      const capMs = overload.maxTotalWaitMinutes * 60_000;
      if (state.overloadTotalWaitMs >= capMs) { state._gaveUp = true; return 'overload-gave-up'; }
      const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
      state.overloadTotalWaitMs += w;
      state.overloadWaitUntil = Date.now() + w;
      state.status = 'overload';
      state.viaEvent = true;
      state._overloadMatch = { pattern: 'StopFailure', line: `error=${ev.error}` };
      return 'overload-detected';
    }
  }

  // Scraper safety net. Runs on every monitoring tick, even when the hook is live: the
  // event path can't emit some terminal renders (an API 429, "temporarily limiting
  // requests"), and the anchored overload patterns can't misfire on a session/usage limit
  // (no "API Error" line). Already isWorking-gated + raw-distance-bounded, so it won't
  // re-fire on a recovered/scrolled overload; and while a backoff is active (status ===
  // 'overload') the tick returns above before reaching here.
  if (overload && overload.enabled && !isWorking(stripped)) {
    const match = overloadMatch(stripped, overload.patterns);
    if (match) {
      // Don't re-fire on the same banner the event path just retried and that hasn't
      // cleared — that incident is owned by the (edge-triggered) event path until the render
      // changes or a fresh marker arrives. Otherwise the always-on scraper opens a second
      // backoff (extra injection + resetOverload defeats the give-up cap).
      if (state._eventHandledBanner === `${match.pattern} ${match.line}`) return 'monitoring';
      state._overloadMatch = match;  // surfaced in the 'overload-detected' log line
      return enterOverload(state, overload, rand);
    }
    state._eventHandledBanner = null;  // banner gone → a future match is a fresh incident
  }

  // Safeguard/AUP false-positive: enter a bounded, seconds-scale retry loop. Independent
  // of the overload path (different render, different recovery). Only when Claude is idle.
  const safeguard = config.safeguard;
  if (safeguard && safeguard.enabled && !isWorking(stripped)) {
    const match = safeguardMatch(stripped, safeguard.patterns);
    if (match) {
      resetSafeguard(state);
      state.status = 'safeguard';
      state.safeguardWaitUntil = Date.now() + (safeguard.retryDelaySeconds * 1000);
      state._safeguardMatch = match;
      return 'safeguard-detected';
    }
  }

  return 'monitoring';
}

export async function startMonitor(pane, pid) {
  const config = await loadConfig();
  const logger = createLogger();
  const state = createMonitorState();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  await logger.info(`Monitor started for pane ${pane} (claude PID: ${pid})`);

  // Best-effort GC of status files left behind by monitors that died without cleaning up
  // (SIGKILL, host sleep/crash). Runs once per monitor start, not per tick.
  sweepStaleStatus().catch(() => {});

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Best-effort: fire the unlink and exit without waiting on the promise. Signal
    // handlers are not the place to await — a hung filesystem must not block the
    // process from actually terminating on SIGTERM/SIGINT.
    clearStatus(pane).catch(() => {}).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const eventMaxAgeMs = (config.overload?.eventMaxAgeSeconds || 120) * 1000;
  const tmuxAdapter = {
    capturePane, sendKeys, sendKey, getPaneCommand,
    isClaudeForeground: () => isProcessForeground(pid),
    // Pane-keyed StopFailure markers (written by the hook). The daemon owns the pane,
    // so this is a direct read — no session-id resolution needed.
    readEvent: () => readStopFailureEvent(pane, eventMaxAgeMs),
    clearEvent: () => clearStopFailureEvent(pane),
  };
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const loop = async () => {
    try {
      const result = await processOneTick(state, tmuxAdapter, pane, config, isAlive);
      consecutiveErrors = 0;

      if (result === 'exit') {
        await clearStatus(pane).catch(() => {});
        await logger.info('Claude exited. Monitor shutting down.');
        process.exit(0);
      }

      // Published for external consumers (e.g. a tmux status-bar segment) — best-effort,
      // never let a write failure interrupt the monitor loop. pollIntervalSeconds travels
      // with every snapshot so the reader can derive its own staleness threshold instead
      // of assuming a fixed interval (a configured pollIntervalSeconds far above the old
      // hardcoded 30s stale-check would otherwise make a healthy monitor's segment blank
      // out for a large fraction of every tick). gaveUp flags the terminal states where
      // `status` alone doesn't tell a reader the monitor has stopped acting.
      await writeStatus(pane, {
        status: state.status,
        waitUntil: Math.floor(state.waitUntil / 1000),
        overloadWaitUntil: Math.floor(state.overloadWaitUntil / 1000),
        safeguardWaitUntil: Math.floor(state.safeguardWaitUntil / 1000),
        attempts: state.attempts,
        overloadAttempts: state.overloadAttempts,
        safeguardAttempts: state.safeguardAttempts,
        pollIntervalSeconds: config.pollIntervalSeconds,
        gaveUp: !!state._gaveUp,
      }).catch(() => {});
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'menu-confirmed') {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate-limit options menu: selected "Stop and wait for limit to reset". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'menu-unreadable') await logger.warn('Rate-limit options menu detected but its layout could not be read; not pressing Enter (would risk confirming "Upgrade your plan"). Will recheck.');
      if (result === 'retried') await logger.info(`Sent retry message (attempt ${state.attempts})`);
      if (result === 'user-continued') await logger.info('User already continued. Attempt counter reset.');
      if (result === 'max-retries') await logger.warn(`Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      if (result === 'skipped-not-claude') await logger.warn(`Foreground is "${state._lastForeground}", not Claude. Skipping send-keys. (Add to foregroundCommands in ~/.claude-auto-retry.json if this is wrong)`);
      if (result === 'event-ignored') await logger.warn(`Ignored StopFailure marker with non-retryable error="${state._ignoredEventError}". If this is "rate_limit", an outdated hook is installed — re-run "claude-auto-retry install-hook".`);
      if (result === 'overload-detected') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        const m = state._overloadMatch;
        const why = m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : '';
        await logger.warn(`Overload/transient API error detected (sustained)${why}. Backing off ${secs}s before retry. NOTE: Claude Code retries 5xx/529 internally — this only fires on terminal overload.`);
      }
      if (result === 'overload-retried') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        await logger.info(`Overload retry sent (attempt ${state.overloadAttempts}). Next backoff ${secs}s. Cumulative wait ${Math.round(state.overloadTotalWaitMs / 1000)}s.`);
      }
      if (result === 'overload-working') await logger.info('Overload text present but Claude is working (internal retry/streaming). Deferring — not terminal.');
      if (result === 'overload-cleared') await logger.info('Overload cleared. Resuming normal monitoring.');
      if (result === 'overload-relaunched') await logger.warn(`Claude exited to shell on overload; relaunched via "${config.overload.relaunchCommand}" (relaunchOnExit on, attempt ${state.overloadAttempts}).`);
      if (result === 'overload-exited-to-shell') await logger.warn(`Overload error left claude exited to the shell ("${state._lastForeground}"). Not auto-relaunching (relaunchOnExit off). Re-run "claude --continue" to resume, or set overload.relaunchOnExit:true.`);
      if (result === 'overload-gave-up') await logger.warn(`Overload backoff cap reached (maxTotalWaitMinutes=${config.overload.maxTotalWaitMinutes}). Giving up — endpoint may be genuinely down (check status.claude.com). Will not retry until the error clears.`);
      if (result === 'safeguard-detected') {
        const m = state._safeguardMatch;
        await logger.warn(`Safeguard/AUP flag detected${m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : ''} — often a false positive. Will retry up to ${config.safeguard.maxRetries}x every ${config.safeguard.retryDelaySeconds}s.`);
      }
      if (result === 'safeguard-retried') await logger.info(`Safeguard retry sent (attempt ${state.safeguardAttempts}/${config.safeguard.maxRetries}).`);
      if (result === 'safeguard-cleared') await logger.info('Safeguard flag cleared. Resuming normal monitoring.');
      if (result === 'safeguard-gave-up') await logger.warn(`Safeguard flag persisted after ${config.safeguard.maxRetries} retries. Giving up — the flag is likely sticky for this content/model; try /model to switch models or rephrase. Will not retry until it clears.`);
    } catch (err) {
      consecutiveErrors++;
      await logger.error(`Monitor tick error: ${err.message}`).catch(() => {});
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await clearStatus(pane).catch(() => {});
        await logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors. Pane likely destroyed. Exiting.`).catch(() => {});
        process.exit(1);
      }
    }
  };

  // Use recursive setTimeout instead of setInterval to prevent concurrent
  // tick execution when a tick takes longer than the poll interval.
  const scheduleNext = () => {
    setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };
  loop().then(scheduleNext);
}

// Direct execution: node monitor.js <pane> <pid>
const isDirectRun = process.argv[1]?.endsWith('monitor.js') && process.argv.length >= 4;
if (isDirectRun) {
  startMonitor(process.argv[2], parseInt(process.argv[3], 10));
}
