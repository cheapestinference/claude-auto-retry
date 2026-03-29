import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (!Array.isArray(cfg.customPatterns)) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  }
  if (cfg.foregroundCommands !== undefined) {
    if (!Array.isArray(cfg.foregroundCommands) || cfg.foregroundCommands.length === 0) {
      delete cfg.foregroundCommands;
    }
  }
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
