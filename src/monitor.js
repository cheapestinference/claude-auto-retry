import { stripAnsi, isRateLimited, findRateLimitMessage } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, getPaneCommand } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const CLAUDE_COMMANDS = ['node', 'claude'];

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null };
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive) {
  if (!isAlive()) return 'exit';

  const raw = await tmuxAdapter.capturePane(pane);
  const stripped = stripAnsi(raw);

  if (state.status === 'waiting') {
    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';
    if (state.attempts >= config.maxRetries) {
      state.status = 'monitoring';
      return 'max-retries';
    }

    // Use same window size for detection and recovery check to avoid asymmetry
    if (!isRateLimited(stripped, config.customPatterns)) {
      state.status = 'monitoring'; state.attempts = 0;
      return 'user-continued';
    }

    const fg = await tmuxAdapter.getPaneCommand(pane);
    if (!CLAUDE_COMMANDS.some(c => fg.toLowerCase().includes(c))) {
      // Push waitUntil forward to avoid tight-loop polling every tick
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return 'skipped-not-claude';
    }

    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    state.attempts++;
    state.status = 'monitoring';
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

  await logger.info(`Monitor started for pane ${pane} (claude PID: ${pid})`);

  const tmuxAdapter = { capturePane, sendKeys, getPaneCommand };
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const loop = async () => {
    try {
      const result = await processOneTick(state, tmuxAdapter, pane, config, isAlive);

      if (result === 'exit') { await logger.info('Claude exited. Monitor shutting down.'); process.exit(0); }
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'retried') await logger.info(`Sent retry message (attempt ${state.attempts})`);
      if (result === 'user-continued') await logger.info('User already continued. Attempt counter reset.');
      if (result === 'max-retries') await logger.warn(`Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      if (result === 'skipped-not-claude') await logger.warn('Foreground is not Claude. Skipping send-keys.');
    } catch (err) {
      await logger.error(`Monitor tick error: ${err.message}`).catch(() => {});
    }
  };

  setInterval(loop, config.pollIntervalSeconds * 1000);
  loop();
}

// Direct execution: node monitor.js <pane> <pid>
const isDirectRun = process.argv[1]?.endsWith('monitor.js') && process.argv.length >= 4;
if (isDirectRun) {
  startMonitor(process.argv[2], parseInt(process.argv[3], 10));
}
