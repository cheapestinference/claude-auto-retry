import { stripAnsi, isRateLimited, findRateLimitMessage, findSpendLimitMenuAction } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, sendKeySequence, getPaneCommand, isProcessForeground } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];
const MENU_ACTION_COOLDOWN_MS = 15_000;

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, menuActionCooldownUntil: 0 };
}

async function isClaudeReadyForInput(state, tmuxAdapter, pane, config) {
  const isFg = await tmuxAdapter.isClaudeForeground();
  if (isFg === true) return true;

  const fg = await tmuxAdapter.getPaneCommand(pane);
  const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
  if (fgCommands.some(c => fg.toLowerCase().includes(c))) return true;

  state._lastForeground = fg;
  return false;
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive) {
  if (!isAlive()) return 'exit';

  const raw = await tmuxAdapter.capturePane(pane, 20);
  const stripped = stripAnsi(raw);
  const spendLimitMenuAction = findSpendLimitMenuAction(stripped);
  const rateLimited = isRateLimited(stripped, config.customPatterns) || spendLimitMenuAction !== null;

  if (state.status === 'waiting') {
    if (spendLimitMenuAction && Date.now() >= state.menuActionCooldownUntil) {
      if (!isAlive()) return 'exit';
      if (!await isClaudeReadyForInput(state, tmuxAdapter, pane, config)) {
        state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
        return 'skipped-not-claude';
      }
      state.menuActionCooldownUntil = Date.now() + MENU_ACTION_COOLDOWN_MS;
      await tmuxAdapter.sendKeySequence(pane, spendLimitMenuAction.keys);
      return 'selected-wait-for-reset';
    }

    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';

    // Always check if rate limit cleared FIRST — even when maxRetries
    // exhausted, the user (or time passing) may have resolved it.
    if (!rateLimited) {
      state.status = 'monitoring'; state.attempts = 0;
      return 'user-continued';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit
      // on the next tick and creating an infinite max-retries loop.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      return 'max-retries';
    }

    if (!await isClaudeReadyForInput(state, tmuxAdapter, pane, config)) {
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return 'skipped-not-claude';
    }

    // Increment attempts and set cooldown BEFORE sendKeys so that a failure
    // (e.g. pane destroyed) still consumes a retry and avoids tight-loop errors.
    state.attempts++;
    state.waitUntil = Date.now() + 30_000;
    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    return 'retried';
  }

  if (rateLimited) {
    const message = findRateLimitMessage(stripped, config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    if (spendLimitMenuAction && Date.now() >= state.menuActionCooldownUntil) {
      if (!await isClaudeReadyForInput(state, tmuxAdapter, pane, config)) {
        state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
        return 'skipped-not-claude';
      }
      state.menuActionCooldownUntil = Date.now() + MENU_ACTION_COOLDOWN_MS;
      await tmuxAdapter.sendKeySequence(pane, spendLimitMenuAction.keys);
      return 'selected-wait-for-reset';
    }
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

  const tmuxAdapter = { capturePane, sendKeys, sendKeySequence, getPaneCommand, isClaudeForeground: () => isProcessForeground(pid) };
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const loop = async () => {
    try {
      const result = await processOneTick(state, tmuxAdapter, pane, config, isAlive);
      consecutiveErrors = 0;

      if (result === 'exit') { await logger.info('Claude exited. Monitor shutting down.'); process.exit(0); }
      if ((result === 'waiting' || result === 'selected-wait-for-reset') && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'selected-wait-for-reset') await logger.info('Detected Claude spend-limit menu and selected "Wait for limit to reset".');
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
