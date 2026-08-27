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
async function readLatestUsageLimitLineFrom(path) {
  try {
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/"isApiErrorMessage"\s*:\s*true/.test(lines[i])) return lines[i];
    }
    return null;
  } catch {
    return null;
  }
}

// marker is the StopFailure event ({ cwd, session_id, transcript_path }). transcript_path
// is the standard hook envelope field (see DESIGN-NOTES.md) and is preferred outright: it
// is Claude Code's own resolved path for the session that raised the marker, so it can't
// diverge the way a cwd-slug reconstruction can (cwd changing mid-session, or a
// CLAUDE_CONFIG_DIR mismatch between claude's env and the monitor's). cwd/session_id is
// kept only as a fallback for older Claude Code builds whose envelope omits the field.
export async function readLatestUsageLimitLine(marker, configDir = DEFAULT_CONFIG_DIR) {
  const path = marker?.transcript_path
    || (marker?.cwd && marker?.session_id ? transcriptPathFor(marker.cwd, marker.session_id, configDir) : null);
  if (!path) return null;
  return readLatestUsageLimitLineFrom(path);
}
