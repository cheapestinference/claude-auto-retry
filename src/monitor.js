import { stripAnsi, isRateLimited, findRateLimitMessage, isRateLimitOptionsPrompt, menuStepsToWaitOption, detectOverload, overloadMatch, isWorking } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, sendKey, getPaneCommand, isProcessForeground } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { readStopFailureEvent, clearStopFailureEvent } from './events.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];
const SHELL_COMMANDS = ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'];

export function createMonitorState() {
  return {
    status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null,
    // Overload-retry sub-state, kept distinct from the usage-reset fields above.
    overloadAttempts: 0, overloadTotalWaitMs: 0, overloadWaitUntil: 0,
    // Event-driven overload: eventMode latches true once a StopFailure marker is ever
    // seen (proves the hook is live → stop trusting the scraper). viaEvent marks the
    // current backoff window as event-triggered (edge: one send per failure).
    eventMode: false, viaEvent: false,
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

  const raw = await tmuxAdapter.capturePane(pane, 20);
  const stripped = stripAnsi(raw);
  const overload = config.overload;

  // Handle the interactive /rate-limit-options menu before any other logic. A bare
  // Enter here confirms the highlighted default, which on some Claude Code versions
  // is "Upgrade your plan". Navigate to "Stop and wait for limit to reset" wherever
  // it sits, confirm it, then enter the normal (hours-scale) wait state.
  if (tmuxAdapter.sendKey && isRateLimitOptionsPrompt(stripped)
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

    const steps = menuStepsToWaitOption(stripped);
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
    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';

    // Always check if rate limit cleared FIRST — even when maxRetries
    // exhausted, the user (or time passing) may have resolved it.
    if (!isRateLimited(stripped, config.customPatterns)) {
      state.status = 'monitoring'; state.attempts = 0;
      return 'user-continued';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit
      // on the next tick and creating an infinite max-retries loop.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
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
      if (isRateLimited(stripped, config.customPatterns)) { resetOverload(state); return enterUsageWait(state, stripped, config); }

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
      await tmuxAdapter.sendKeys(pane, overload.retryMessage);
      return 'overload-retried';
    }

    const capMs = overload.maxTotalWaitMinutes * 60_000;

    // Usage-limit takes precedence: hand off to the (hours-scale) reset path.
    if (isRateLimited(stripped, config.customPatterns)) {
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

  // --- monitoring ---
  // Usage-limit (hours-scale reset) takes precedence over overload (seconds-scale).
  if (isRateLimited(stripped, config.customPatterns)) {
    return enterUsageWait(state, stripped, config);
  }

  // Event-driven overload (authoritative; see DESIGN-NOTES §1). A StopFailure marker for
  // this pane means the turn ended in a retryable API error — no scraping, no ambiguity.
  // Latches eventMode so the scraper path is disabled once we know the hook is live.
  if (overload && overload.enabled && tmuxAdapter.readEvent) {
    const ev = await tmuxAdapter.readEvent();
    if (ev) {
      state.eventMode = true;
      await tmuxAdapter.clearEvent();               // consume
      if (isWorking(stripped)) { resetOverload(state); return 'overload-cleared'; } // self-recovered
      const capMs = overload.maxTotalWaitMinutes * 60_000;
      if (state.overloadTotalWaitMs >= capMs) return 'overload-gave-up';
      const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
      state.overloadTotalWaitMs += w;
      state.overloadWaitUntil = Date.now() + w;
      state.status = 'overload';
      state.viaEvent = true;
      state._overloadMatch = { pattern: 'StopFailure', line: `error=${ev.error}` };
      return 'overload-detected';
    }
  }

  // Scraper fallback — only while eventMode hasn't latched (hook absent or not yet fired).
  if (!state.eventMode && overload && overload.enabled && !isWorking(stripped)) {
    const match = overloadMatch(stripped, overload.patterns);
    if (match) {
      state._overloadMatch = match;  // surfaced in the 'overload-detected' log line
      return enterOverload(state, overload, rand);
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

      if (result === 'exit') { await logger.info('Claude exited. Monitor shutting down.'); process.exit(0); }
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
    } catch (err) {
      consecutiveErrors++;
      await logger.error(`Monitor tick error: ${err.message}`).catch(() => {});
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
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
