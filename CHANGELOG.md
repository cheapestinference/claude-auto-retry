# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Chrome-aware detection.** Limit/overload/menu detectors now skip trailing UI
  furniture (input box, footer, key hints, todo/task widget, status spinner,
  `/usage-credits` hint) before reading the live tail, so a genuine banner behind a tall
  task widget is still detected (fixes a ~54-min stall) while a banner merely quoted in
  scrollback is not (#34).
- **`reconcile` / `install-timer` / `exclude-self`** for self-healing monitor coverage: a
  monitor killed (or a `claude` started outside the wrapper) is re-armed from live tmux +
  process state, on demand or via a `systemd --user` timer (#32).
- **macOS support for `reconcile` / `install-timer`**: the running-monitor probe now uses
  `pgrep -lf` on Darwin (BSD pgrep prints full args with `-l`, not procps' `-a`, so
  reconcile previously always aborted with "cannot verify coverage" on macOS), claude
  detection falls back to the basename of argv[0] from ps `args=` (macOS `comm=` prints
  the executable's full path truncated to 16 chars — never "claude" — so the strict
  compare saw zero claude sessions), and
  `install-timer` installs a launchd LaunchAgent
  (`~/Library/LaunchAgents/com.claude-auto-retry.reconcile.plist`, `RunAtLoad` +
  `StartInterval` 300s, `AbandonProcessGroup` so the freshly-armed detached monitors
  survive the short-lived job, and an explicit `PATH` covering both Homebrew prefixes —
  launchd does not inherit the login shell's PATH, so `spawn tmux` would otherwise
  ENOENT) instead of requiring systemd. The reconcile lock's `ps -o lstart=` start token
  is now pinned to `LC_ALL=C` so the timer (C locale) and an interactive shell (user
  locale) always agree on lock-holder identity.
- Safeguard/AUP false-positive auto-retry: when the model's safeguards flag a
  message ("safeguards flagged this message"), re-send a short retry up to
  `safeguard.maxRetries` times, then give up loudly once. Detection is anchored
  to the `API Error` render (mentioning the phrases in conversation can't
  trigger it), and the retry budget is kept across working ticks so a sticky
  flag stays bounded (#33).
- tmux status bar indicator: the monitor now writes a per-pane status snapshot to
  `~/.claude-auto-retry/status/<pane>.json` on every poll tick, and a new
  `claude-auto-retry-tmux-status` script renders it as a status-bar segment
  (`🟢AR` monitoring, `⏳AR 1h30m` waiting on a reset, `🟠AR 45s` overload backoff,
  `🔴AR` gave up). Dependency-free POSIX shell; hides itself if a pane has no
  monitor or its status file is stale (staleness is derived from the monitor's
  actual poll interval, not a fixed constant).

### Fixed
- `reconcile` now also re-arms claude sessions whose process command isn't `claude`
  (Finding 6): a claude CLI run under `node` with its process.title unset (shows comm
  `node`), and a session our own launcher wraps in an agent harness that embeds claude
  (e.g. `happier claude`) — both were invisible to the `comm === 'claude'` match, so the
  self-healing timer never re-armed them once their monitor died. Detection stays
  conservative: only a node process that IS the claude CLI (script basename `claude` or
  the `claude-code` cli entry) or a pane our `launcher.js` wraps — never a bare node
  process. `exclude-self` recognizes these sessions too.
- Overload scraper stays a live safety net once the StopFailure hook is active. It was
  disabled permanently the first time any `overloaded`/`server_error` event latched, so a
  transient API 429 the event path can't emit (`API Error: Server is temporarily limiting
  requests …`) went undetected and the session sat stuck until resumed by hand. The
  anchored overload patterns can't misfire on a session/usage limit (no `API Error` line).
  The scraper also skips the exact banner the event path just retried until it clears or
  changes, so a render lingering after an edge-triggered retry can't open a second backoff
  (a double injection that would also reset the give-up budget).
- Monitor no longer stays parked on a stale wait timer once the session resumes:
  while counting down a usage wait, a pane that has resumed working (e.g. the user
  manually typed `continue` to unstick a wrong/stale wait) now drops back to
  monitoring immediately, so a second, genuine limit that follows is detected
  instead of being masked until the old timer expires (#39).
- The `/usage-credits` backstop no longer reopens the scrollback false positive: it only
  fires when the companion sits in the live region (nothing but chrome below it), so a
  resumed session's stale banner+companion can't drive spurious retries or a ~24h wait (#34).
- `isWorking` is chrome-aware, matching `isRateLimited`: a live "esc to interrupt" footer
  pushed up by a chrome stack is no longer missed, so retry text can't land in a
  mid-flight session (#34).
- The `/rate-limit-options` menu detectors are chrome-aware too, so a live menu behind a
  widget is driven to "Stop and wait" instead of skipped (which risked confirming
  "Upgrade your plan") (#34).
- Overload detection is bounded to a max raw distance from the prompt, so the deeper
  50-line capture can't reach an old quoted `API Error` buried behind a tall widget (#34).
- Chrome classifiers are anchored to real footer/widget renders (pipe-anchored version,
  indented task items, `⏵⏵` mode footer), so ordinary content — `Press ctrl+c…`, a
  `→` rename, a flush-left `✓ …` summary, `Released v0.5.1` — is no longer stripped (#34).
- `install-timer` no longer crashes on npm installs — `systemd/` is shipped in the package
  and the template reads fail with a clear message instead of ENOENT (#32).
- `reconcile` distinguishes a real `pgrep` failure (ENOENT, busybox without `-a`, macOS
  PID-only output) from "no monitors running", and aborts loudly rather than arming a
  duplicate monitor per pane every run (#32).
- Monitor coverage is keyed per-pane, so a stopped `claude` keeping its monitor can't lead
  to a second monitor on the same pane (#32).
- A single-instance lock (pid + start-token identity) stops an overlapping manual + timer
  run from double-spawning, and can't wedge on PID reuse (#32).
- Exclude-file PID entries are pruned when dead, so kernel PID reuse can't permanently mute
  a future session (the self-expiring behavior the docs promised) (#32).
- Print-mode panes (`claude -p` / `--print`) are no longer given a send-keys monitor (#32).
- The generated systemd unit quotes the node/CLI paths (spaces no longer break it), drops
  the no-op `Persistent=true`, and `install-timer` prints an nvm re-run caveat (#32).
- `rate_limit` StopFailure events are no longer routed through the seconds-scale
  overload path — a session/usage limit is an hours-scale wait owned by the
  usage path, and the misroute made the two fight (futile `Continue` retries
  into a session-limited pane). The marker error type is validated at the
  consumer too, so an outdated installed hook can't reintroduce it (#31).

### Changed
- `customPatterns` are matched against the raw last-N lines (unchanged from pre-#34
  semantics), not the chrome-skipped view — the user owns their own tradeoff (#34).
- Removed the dead `CLAUDE_COMMANDS` constant (#32). Reconcile's session detection was
  since extended beyond `comm === 'claude'` to also cover node-launched and launcher-wrapped
  claude — see the Finding 6 entry under Fixed.

## [0.5.1] - 2026-06-30

**Upgrade if you installed `0.5.0` from npm.** The `0.5.0` npm artifact was built
before #29 was merged and shipped without the usage-retry anti-spam fix. `0.5.1`
includes it. (The git tag `v0.5.0` already contained #29; only the npm tarball was
behind.)

### Fixed
- Stop the usage-retry path from spamming an already-resumed session: a lingering
  limit banner in scrollback no longer re-injects `Continue…` every poll. Detection
  is now anchored to the live tail, and an `isWorking` gate stops the moment Claude
  resumes (#29).

## [0.5.0] - 2026-06-30

This release rolls up everything merged since `0.2.2`, including the API
overload backoff engine and interactive `/rate-limit-options` menu navigation.

### Added
- Detect sustained API overload (`529`/`500`/`503`) and retry with exponential
  backoff, including an event-driven (`StopFailure`) mode (#20, hardened).
- Interactive navigation of the `/rate-limit-options` menu, driving it to
  "Stop and wait" across any menu layout (#19, #26).
- Enable mouse scroll and vi copy-mode in tmux sessions created by the tool (#25).

### Fixed
- Require Claude to be in the foreground before driving the
  `/rate-limit-options` menu, preventing keystrokes from leaking into the wrong
  pane (#28).
- Reliable retry submission plus session/weekly rate-limit detection (#7, #15, #22).
- Correct an off-by-a-day wait when parsing reset times in offset timezones (#6, #23).
- Unalias `claude` before defining the wrapper, fixing a zsh/bash `source` error (#10, #24).
- Skip send-keys correctly when the foreground process is the shell, not Claude (#1).

## [0.2.2] - 2026-03-31

- Last published baseline release.
