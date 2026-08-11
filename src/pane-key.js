// Shared filename-sanitizer for pane-keyed marker/status files.
//
// tmux pane ids (e.g. "%2") and other free-form keys derived from them need to become
// safe filename components. Previously this one-line rule was copy-pasted into
// events.js, status-file.js, and the `tr` call in bin/tmux-status.sh — three places
// that all had to be kept in sync by hand. Centralizing the JS-side copies here so
// there is exactly one definition to update.
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, '_');
}

// The tmux server identity for pane-keyed files. Pane ids ("%2") are only unique per
// server, so every pane-keyed channel (status files, StopFailure markers) prefixes its
// filenames with this. CLAUDE_AUTO_RETRY_SOCKET is stamped by reconcile onto monitors it
// arms (timer runs have no $TMUX); processes inside a pane inherit $TMUX, whose first
// comma-field is exactly what tmux's #{socket_path} resolves to for that server.
export function socketIdFromEnv(env = process.env) {
  if (env.CLAUDE_AUTO_RETRY_SOCKET) return env.CLAUDE_AUTO_RETRY_SOCKET;
  const tmuxEnv = env.TMUX || '';
  return tmuxEnv.split(',')[0] || 'default';
}
