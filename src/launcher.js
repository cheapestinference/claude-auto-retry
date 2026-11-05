/**
 * Terminal environment variables that should be excluded from snapshots
 * to prevent overriding native tmux / terminal settings.
 */
const EXCLUDED_ENV_VARS = ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'];

/**
 * Filters out excluded terminal variables from an environment object.
 * @param {Object} env
 * @returns {Object}
 */
function filterEnv(env) {
  if (!env) return {};
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!EXCLUDED_ENV_VARS.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create a snapshot of environment variables excluding terminal-specific variables.
 * @param {Object} [env=process.env]
 * @returns {Object}
 */
function createEnvSnapshot(env = process.env) {
  return filterEnv(env);
}

/**
 * Apply environment snapshot, filtering out terminal-specific variables.
 * @param {Object} snapshot
 * @param {Object} [target=process.env]
 * @returns {Object}
 */
function applyEnvSnapshot(snapshot, target = process.env) {
  if (!snapshot || !target) return target;
  const filtered = filterEnv(snapshot);
  for (const [key, value] of Object.entries(filtered)) {
    target[key] = value;
  }
  return target;
}

module.exports = {
  EXCLUDED_ENV_VARS,
  filterEnv,
  createEnvSnapshot,
  applyEnvSnapshot,
};
