// Resolves the reset-time message for a rate_limit StopFailure marker by reading the
// session transcript Claude Code writes at $CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<id>.jsonl
// — used only as a fallback when the live pane scrape at marker time didn't already catch
// the banner (see monitor.js). Best-effort and defensive throughout: the JSONL shape is a
// Claude Code internal that can shift between versions, so any failure here just means
// "couldn't resolve" (null), never a thrown error.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Claude Code slugs a project's cwd into its transcript directory name by mapping every
// non-alphanumeric character to a "-" — one-for-one, not collapsing runs (verified
// locally: "/home/ubuntu/x" -> "-home-ubuntu-x", "/home/u/.claude" -> "-home-u--claude",
// where the adjacent "/" + "." each becomes its own "-").
export function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPathFor(cwd, sessionId, configDir = DEFAULT_CONFIG_DIR) {
  return join(configDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

// Returns the raw text of the LAST isApiErrorMessage record in the transcript, or null.
// Matches on the flag substring rather than parsing the full JSON shape, so a renamed or
// restructured field elsewhere in the record can't break this — only the flag name itself.
export async function readLatestUsageLimitLine(cwd, sessionId, configDir = DEFAULT_CONFIG_DIR) {
  if (!cwd || !sessionId) return null;
  try {
    const text = await readFile(transcriptPathFor(cwd, sessionId, configDir), 'utf-8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/"isApiErrorMessage"\s*:\s*true/.test(lines[i])) return lines[i];
    }
    return null;
  } catch {
    return null;
  }
}
