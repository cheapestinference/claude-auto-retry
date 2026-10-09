// The signed-in Claude account, as Claude Code records it in .claude.json (`oauthAccount`).
// Account switchers (claude-swap's `cswap auto`, a manual /login) rewrite it, and a running
// Claude Code picks the new credential up on its next request. A usage-limit wait that sees
// the account change can therefore retry at once: the limit belonged to the old account.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// On macOS Claude Code caches the Keychain credential for ~30s, so a retry sent the moment
// .claude.json names a new account can still leave on the old, limited one — and its fresh
// banner would then start a wait for the OLD account's reset. Hold the account-switch retry
// until the change has had time to reach the running session.
export const ACCOUNT_SETTLE_MS = 45_000;
// A limit detected this soon after an account change may still be the previous account's:
// the request that hit it can have left on the cached old credential, or the switcher (which
// at a ~100% threshold acts on the same exhaustion) can land between Claude's 429 and our
// next poll. Such a wait is attributed to the previous account so the switch still retries.
export const ACCOUNT_CHANGE_RECENT_MS = 2 * 60_000;

export function claudeConfigPath(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

// Returns a reader for "<accountUuid>/<organizationUuid>", or null when there is no
// readable signed-in account. The file holds per-project history and grows large, and the
// monitor asks every poll, so it is re-parsed only when its mtime or size changes.
export function createAccountReader(path = claudeConfigPath()) {
  let stamp = null, account = null;
  return () => {
    let st;
    try { st = statSync(path); } catch { stamp = null; return (account = null); }
    const now = `${st.mtimeMs}:${st.size}`;
    if (now === stamp) return account;
    stamp = now;
    try {
      const { accountUuid, organizationUuid } = JSON.parse(readFileSync(path, 'utf8')).oauthAccount || {};
      account = accountUuid ? `${accountUuid}/${organizationUuid || ''}` : null;
    } catch {
      account = null;
    }
    return account;
  };
}
