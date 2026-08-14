# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-08-14

### Fixed
- **The org/monthly spend-limit banner is now detected (#71).** Team/org accounts (and
  individual accounts whose extra-usage budget is exhausted) get "You've hit your org's
  monthly spend limit · run /usage-credits …" — undetected for two independent reasons:
  the render carries no reset time (and detection deliberately anchors on one), and the
  `org's` possessive defeated the limit-pattern shape. Both reporters confirmed the
  underlying 5-hour block resets and waiting works, so the banner now routes into the
  usage wait as a limit with unknown reset: the bounded `fallbackWaitHours` default,
  latched correctable — if a real "resets <time>" banner appears mid-wait, the wake-up
  shortens to the true instant, and genuine budget exhaustion ends in the normal
  max-retries give-up. With no reset line to anchor on, the false-positive defense moves
  into the shape: only the banner phrasing (line starts "You've hit …"), only next to its
  `/usage-credits` companion, and only in the live region — prose *explaining* spend
  limits, and stale banners with real work below, stay inert. The banner also had to be
  exempted from chrome classification: it carries "/usage-credits" inline, so the
  companion furniture rule would otherwise classify the banner itself as chrome and hide
  it from the reset-message scan.
- **A fallback wait is now corrected once the real reset time appears on screen.** The
  `/rate-limit-options` menu does not always render a reset line, so confirming "Stop and
  wait" could commit the `fallbackWaitHours` default (5h) — and the waiting branch returned
  early on every tick and never looked at the pane again, so the banner Claude Code prints
  immediately after confirming, which *does* carry the time, was ignored for the whole
  fallback. Observed live: a session whose limit reset at 18:20 sat parked until 22:27 with
  `attempts: 0`, ~4 idle hours, while the banner naming 18:20 was on screen the entire time.
  A wait derived from an unreadable screen is now latched as a fallback and re-derived from
  the live banner each tick until a real reset time is found; waits that already came from a
  real reset time are never re-parsed. Confirming the menu starts a fresh retry episode, so
  the correction still applies when the menu re-renders after a retry has been sent.

## [0.7.0] - 2026-08-13

### Security
- **Secrets no longer ride any tmux argv (#68).** The environment used to cross into the
  auto-created session as `new-session -e KEY=VALUE` pairs (and, below tmux 3.2, as
  inline `export`s in the pane command) — and when that invocation is the one that
  starts the tmux server, the server keeps the whole argv in `/proc/<pid>/cmdline`,
  world-readable, for its entire multi-day lifetime. API keys, tokens and connection
  strings were retrievable with a plain `ps`. The environment now crosses via a `0600`
  JSON snapshot in a `0700` dir (`~/.claude-auto-retry/tmp/`); only the file *path*
  appears on the command line, and the inner launcher loads it into `process.env` and
  unlinks it (with a 24h sweep for launches that died before consuming). Loading in
  Node rather than `source` round-trips names a POSIX shell can't — `BASH_FUNC_name%%`
  exported functions, Windows `ProgramFiles(x86)` — which also retires the entire
  "tmux rejects this env name" launch-failure class (#58) and the lenient/strict retry
  machinery with it. Environment fidelity is *higher* than before: names the argv
  filter had to drop now cross intact.

### Changed
- **Clean exits reap their tmux session (#69).** The pane tail was an unconditional
  `; exec $SHELL`, so no session was ever destroyed — a clean `/exit` left an idle
  login shell pinning the session and its whole process tree forever (measured by the
  reporter: 66 sessions holding 16.4 GB after 3 days). The shell fallback is now
  reserved for **non-zero** launcher exits, where the crash scrollback is genuinely
  useful; on a clean exit the pane command ends and tmux reaps the session itself.
  `CLAUDE_AUTO_RETRY_KEEP_SHELL=1` restores the old behavior.
- **`CLAUDE_AUTO_RETRY_NO_TMUX=1`** skips tmux session creation entirely, for users
  already inside a non-tmux multiplexer (Zellij, screen) who don't want a nested
  session per launch (#69). Explicit opt-out — the nested session is what the monitor
  drives, so this disables auto-retry for the run, and that trade belongs to the user.
- The pane command now invokes the launching Node binary by absolute path instead of
  relying on `node` being resolvable through a possibly-stale tmux server `PATH`.

### Fixed
- **Launch no longer fails with `server exited unexpectedly` when it races a
  dying tmux server (#69 follow-up).** Session reaping means the tmux server now
  exits once the last claude session ends (`exit-empty` defaults on) — and a
  `new-session` landing in the teardown window (socket still on disk, server
  draining) connects, sees EOF mid-handshake, and aborted the whole launch. This
  window could not exist before reaping, because the server never exited.
  Session creation now retries up to twice (250 ms apart) when the failure is
  `server exited unexpectedly` / `lost server`; the next attempt finds the
  socket gone or stale and cold-starts a fresh server. Real failures (duplicate
  session, tmux missing, bad option) still fail immediately. Reproduced and
  verified against real tmux 3.4: 23 forced race hits, 23 recovered, 0 residual
  failures across 250 timed attempts.
- **A usage-meter statusline no longer hijacks the reset-time parse (#61).** ccusage-style
  statuslines render a permanent countdown row at the very bottom of the pane
  ("current ●●●●●●●●●● 100%  ⟳ resets in 1 hr 47 min"). That row matches the reset
  patterns and sits below any live banner, so the bottom-up scan in
  `findRateLimitMessage` returned it instead of the banner — and its wording isn't
  parseable, so a banner with a perfectly good "resets 6:20am (Europe/Brussels)" fell
  back to the 5-hour default wait. Meter rows (countdown glyph variants, dotted gauges
  with a percentage, the cost row) are now classified as chrome, and
  `findRateLimitMessage` skips chrome the same way the detectors already do. This also
  removes a standing false-positive anchor: the meter's "resets" line no longer
  validates limit-shaped prose near the bottom of the pane.
- **A failed env-snapshot write now warns instead of degrading silently** (PR #72
  review follow-up). If `~/.claude-auto-retry/tmp` is unwritable (read-only or
  over-quota `$HOME` — NFS-mounted HPC homes especially), the launch still proceeds,
  but the pane runs with the tmux **server's** startup environment: on a pre-existing
  server that can be days stale, so a rotated `ANTHROPIC_API_KEY` or fresh proxy var
  quietly never reached `claude` with zero diagnostic. The degrade stays; the silence
  goes — a stderr warning now names the cause.

## [0.6.2] - 2026-07-29

### Fixed
- **Adversarial review of this release's own fixes caught and closed seven follow-ups:**
  the stdin buffer now mirrors claude's 3-second no-data grace instead of hanging on a
  held-open pipe (`ssh` without `-n`, CI harnesses); DST-transition wall times that
  don't exist (spring-forward) or repeat (fall-back) resolve deterministically to the
  late side on every host; the overload recovery reset no longer counts Claude's own
  in-flight `Retrying in …` render as recovery (escalation and the give-up cap survive
  sustained outages) and no longer drops the same-banner memo (no scraper re-fire into
  a recovered session); exported bash functions (`BASH_FUNC_name%%`) are forwarded
  again, with a strict-POSIX retry if a tmux build rejects them; the tmux < 3.2 inline
  branch no longer clobbers the pane's TERM; socket paths with consecutive spaces
  survive `parsePanes` verbatim.
- **StopFailure markers are socket-keyed** (like status files): with two tmux servers,
  a marker for one server's `%2` could be consumed by the monitor watching the other
  server's `%2`. Readers fall back to the legacy filename so an older installed hook's
  markers aren't dropped mid-upgrade.
- **`claude` now launches on tmux 3.0–3.1c (Ubuntu 20.04, Debian 11).** `new-session -e`
  only exists from tmux 3.2; gating it at 3.0 made session creation fail outright with
  `unknown option -- e` on those distros. Below 3.2 the critical env vars are exported
  inline in the command instead.
- **A tool result taller than the detection window can no longer revive the #63 false
  positive.** The tool-echo mask is now computed over the full pane and sliced to the
  window, so quoted banner/error lines stay masked even when their `● Name(` header sits
  above the window. Applies to the limit, overload, and safeguard matchers.
- **DST-safe roll-to-tomorrow.** A stale reset time was rolled forward by a flat 24h of
  milliseconds — one hour short across a fall-back night (the monitor woke early with the
  banner still live, burned its retries, and gave up before the real reset) and one hour
  long across spring-forward. Tomorrow's occurrence is now computed on the actual
  calendar day.
- **A stale `Retrying in …` / `attempt N/M` transcript line no longer suppresses the
  retry forever.** The waiting branch treated any working-pattern match as "user
  continued", churning without ever sending. Resumed now means working signal rendered
  *below* the last banner line; work above it is history.
- **Event-path overload incidents close on recovery.** Backoff counters leaked across
  fully-recovered incidents (escalating 30s → 300s waits for unrelated failures days
  apart) until the total-wait cap silently disabled the hook path for the session.
  Counters reset when the pane is seen working again or when a fresh marker arrives well
  after the last retry.
- **Print-mode retries keep a piped prompt.** `cat doc.md | claude -p` had its stdin
  consumed by the first attempt; retries ran with an empty prompt. Piped stdin is now
  buffered once and re-fed to every attempt.
- **The shell wrapper no longer wipes user INT/TERM traps in zsh** (macOS default
  shell). `trap -p` is a bashism; zsh now uses native `localtraps` scoping.
- **Timer-armed monitors show up in the tmux status bar.** They wrote status files under
  a `default` socket key the `#{socket_path}`-driven reader never looks up; reconcile now
  passes the real socket path through.
- **A monitor on another tmux server's pane no longer masks this server's same-numbered
  pane in `reconcile`** (pane ids are only unique per server).
- **tmux session creation no longer fails on Windows (Git Bash / MSYS2) environments.**
  `tmux new-session -e` rejects non-POSIX variable names that Windows shells always
  carry (`ProgramFiles(x86)`, `=C:` drive pseudo-vars, `!ExitCode`) with
  `invalid environment variable name`, which aborted the whole launch. Environment
  forwarding now filters names to POSIX `[A-Za-z_][A-Za-z0-9_]*`; everything else is
  passed through unchanged (#58).

## [0.6.1] - 2026-07-23

### Fixed
- **Quoted banner text in a tool-call render no longer triggers a bogus wait.** A pane
  line like `● Bash(grep "5-hour limit reached - resets 3pm" …)` — or quoted log lines
  in its result block — matched the limit patterns and parked the monitor for the
  parsed hours (a real 22.5h incident). Tool-call renders (`● Name(…)` headers and
  their `⎿`/indented children) are now masked out of the built-in limit, overload, and
  safeguard matching. TUI path only: print mode still scans quoted/JSON error shapes,
  a live banner rendered as a `└` child of an agent-finished notice is still detected,
  and `customPatterns` keep their scan-everything semantics (#63).
- **Orphaned shell wrapper no longer breaks `claude`.** Removing the package with
  `npm uninstall -g` (without running `claude-auto-retry uninstall` first) left the
  rc-file wrapper pointing at a deleted `launcher.js`, so every `claude` invocation
  died with `MODULE_NOT_FOUND`. The wrapper now falls back to `command claude` when
  the launcher no longer exists. Existing installs pick this up on the next
  `claude-auto-retry install` (re-run it once after updating) (#65).
- **Timezone off-by-a-day in reset-time waits.** A reset timezone beyond UTC±12
  (e.g. `Pacific/Auckland` in summer, UTC+13) — or a host whose offset differs from the
  banner's by more than 12h — made the wait land on the wrong day (~24h too long:
  "resets 11:40pm" seen at 10pm waited 25.7h instead of 1.7h). The convergence
  correction is now anchored to the target date, not a minimum-magnitude ±12h
  adjustment, and the initial guess parses in host-local time (#60).
- After the in-tmux session's own process exits, the pane now falls through to the
  user's login shell (`$SHELL`, bash fallback) instead of a hardcoded `bash` (#54).
- `reconcile` claude detection follow-ups (#49 review): (1) node flags that take a
  separate-token value (`-r`/`--require`, `--import`, `--loader`, `-e`) are skipped when
  finding the executed script, so a preload-instrumented `node -r x …/claude` is detected
  and a `node -r /opt/claude server.js` no longer false-matches; (2) a launcher wrapping a
  print-mode session (`node …/wrap claude -p`) is skipped — print mode is now read from the
  args after the `claude` subcommand token, not the wrapper's first positional; (3) a
  launcher child is verified claude-shaped before arming, instead of trusting that the
  launcher only ever spawns claude.

## [0.6.0] - 2026-07-11

### Added
- `CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER` env var: a prefix command prepended to each interactive
  session (e.g. `caffeinate -i` to keep macOS awake while Claude works). Generic and opt-in —
  unset spawns `claude` directly, unchanged (#47).
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
- Rate-limit banner detection now captures a taller pane (120 lines, was 50): a session-limit
  banner pushed far up by a big task widget + input box + footer (~90 lines seen in the wild)
  was beyond the capture window entirely and never detected, leaving the session idle past its
  reset. The chrome-aware tail still strips furniture and a stale banner with real output below
  it stays out, so the wider capture doesn't add false positives (#38).
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
