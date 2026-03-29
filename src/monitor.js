import { stripAnsi, isRateLimited, findRateLimitMessage } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, getPaneCommand } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null };
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive) {
  if (!isAlive()) return 'exit';

  const raw = await tmuxAdapter.capturePane(pane, 20);
  const stripped = stripAnsi(raw);

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

    const fg = await tmuxAdapter.getPaneCommand(pane);
    const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
    if (!fgCommands.some(c => fg.toLowerCase().includes(c))) {
      // Push waitUntil forward to avoid tight-loop polling every tick
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      state._lastForeground = fg;
      return 'skipped-not-claude';
    }

    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    state.attempts++;
    // Stay in 'waiting' with a 30s cooldown instead of going to 'monitoring'.
    // This gives Claude time to process the retry and produce enough output
    // to push the stale rate-limit message out of the recent-lines window.
    // Without this, the next tick re-detects the old message and waits 24h.
    state.waitUntil = Date.now() + 30_000;
    return 'retried';
  }

  if (isRateLimited(stripped, config.customPatterns)) {
    const message = findRateLimitMessage(stripped, config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    return 'waiting';
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

  const tmuxAdapter = { capturePane, sendKeys, getPaneCommand };
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
      if (result === 'retried') await logger.info(`Sent retry message (attempt ${state.attempts})`);
      if (result === 'user-continued') await logger.info('User already continued. Attempt counter reset.');
      if (result === 'max-retries') await logger.warn(`Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      if (result === 'skipped-not-claude') await logger.warn(`Foreground is "${state._lastForeground}", not Claude. Skipping send-keys. (Add to foregroundCommands in ~/.claude-auto-retry.json if this is wrong)`);
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
