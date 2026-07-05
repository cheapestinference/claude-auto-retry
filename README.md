# claude-auto-retry

> Automatically retry Claude Code sessions when you hit Anthropic subscription rate limits.

When Claude Code shows *"5-hour limit reached - resets 3pm"*, this tool waits for the reset and sends "continue" automatically. You come back to find your work done.

**No dependencies. No workflow change. Just install and forget.**

[![npm version](https://img.shields.io/npm/v/claude-auto-retry.svg)](https://www.npmjs.com/package/claude-auto-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

> 💡 **Why wait out the limit at all?** This tool auto-resumes Claude Code the moment you're rate-limited — but if you run overnight jobs or always-on agents, there's a way to stop hitting the wall in the first place. **[See how it's done →](https://cheapestinference.com/blog/claude-code-usage-limit-auto-retry/)**

## The Problem

You're in the middle of a complex task with Claude Code. After a while, you see:

```
You've hit your limit · resets 3pm (Europe/Dublin)
```

Claude stops. You have to wait hours, come back, and type "continue". If you're running long tasks overnight or while AFK, this kills your productivity.

## The Solution

```bash
npm i -g claude-auto-retry
claude-auto-retry install
```

That's it. Type `claude` as you always do. When the rate limit hits, the tool:

1. Detects the rate limit message in the terminal
2. Parses the reset time (timezone-aware)
3. Waits until the limit resets + 60s margin
4. Verifies Claude is still the foreground process
5. Sends "continue" automatically

You come back to find your task completed.

## How it Works

```
You type "claude"
       │
       ▼
  Shell function (injected in .bashrc/.zshrc)
       │
       ├─ Already in tmux? ──▶ Start background monitor
       │                        Launch claude with full TUI
       │
       └─ Not in tmux? ──▶ Create tmux session transparently
                             Launch claude + monitor inside
                             Attach (looks the same to you)

  MONITOR (background, ~0% CPU):
       │
       ├─ Polls tmux pane every 5 seconds
       ├─ Detects rate limit text
       ├─ Parses reset time from message
       ├─ Waits until reset + safety margin
       ├─ Verifies Claude is still the foreground process
       └─ Sends "continue" via tmux send-keys
```

### Why tmux?

When you disconnect (SSH drops, close terminal, laptop sleeps), **tmux keeps running**. The monitor keeps waiting. When you reconnect with `tmux attach`, you find Claude working on your task. This is the key advantage over wrapper scripts.

## Features

- **Zero workflow change** — same `claude` command, same TUI, same everything
- **Works with and without tmux** — auto-creates tmux session if you're not already in one
- **Auto-installs tmux** if missing (apt, dnf, brew, pacman, apk)
- **Timezone-aware** — parses reset times with full IANA timezone support (including half-hour offsets)
- **DST-safe** — iterative offset correction handles daylight saving transitions
- **Safe send-keys** — verifies Claude is still the foreground process before injecting text
- **Self-healing coverage** — `reconcile` re-arms monitors for any live `claude` session that lost one; an optional `systemd --user` timer runs it automatically ([details](#keeping-monitors-alive))
- **Overload backoff** — detects sustained API overload (`429/500/502/503/504/529`) and retries on a configurable exponential backoff with jitter and a cumulative-wait cap, distinct from the usage-reset path ([details](#overload-backoff))
- **Safeguard retry** — auto-continues past an AUP-safeguard false-positive (often transient), capped at a few tries so a sticky flag can't loop ([details](#safeguard-retry))
- **tmux status bar indicator** — see at a glance whether a pane is being monitored, waiting on a reset, backing off from overload, or has given up ([details](#tmux-status-bar-indicator))
- **`--print` mode support** — buffers output, retries cleanly for piped/scripted usage
- **Configurable** — retry count, wait margin, custom patterns, retry message
- **Config validation** — bad config values fall back to safe defaults instead of crashing
- **Zero dependencies** — pure Node.js, no `node_modules`

## Messages Detected (verbatim)

The tool acts on these real-world Claude Code renders — if you landed here after
pasting one of these errors into a search engine or an AI assistant: yes, this tool
automates the wait-and-retry for all of them.

### Usage / session limits — waits until the printed reset, then continues

| Render | Example |
|--------|---------|
| N-hour limit | `5-hour limit reached - resets 3pm (UTC)` |
| Session limit | `You've hit your session limit · resets 2am (Europe/Zurich)` |
| Weekly limit | `You've hit your weekly limit · resets Oct 9, 10am` |
| Usage limit | `Claude usage limit reached. Resets at 2pm` |
| Out of extra usage | `You're out of extra usage · resets 3pm` |
| Try again | `Please try again in 5 hours` |
| Hit your limit | `You've hit your limit · resets 3pm (Europe/Dublin)` |
| Rate limit | `Rate limit hit. Resets at 4pm` |
| Live-limit companion hint | `/usage-credits to finish what you're working on.` |

### The `/rate-limit-options` menu — driven to "Stop and wait", never "Upgrade"

```
What do you want to do?
❯ 1. Upgrade your plan
  2. Stop and wait for limit to reset (3pm)
```

Handled across any menu layout (the option order varies by Claude Code version); the
tool locates the cursor and the "Stop and wait" option, and refuses to press Enter if
the layout is unreadable.

### API overload / transient errors — exponential backoff with jitter

| Render | Example |
|--------|---------|
| Terminal API error (colon form) | `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` |
| 5xx family | `API Error: 500 / 502 / 503 / 504 …` (including bodyless renders like `503 no healthy upstream`) |
| API-level 429 | `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited` |

### Safeguard false positives — bounded immediate re-send

```
API Error: <model>'s safeguards flagged this message (https://www.anthropic.com/legal/aup).
They may flag safe, normal content as well. … Claude Code can't respond to this request with <model>.
```

Custom patterns can be added via config for future message format changes.

Detection is **chrome-aware**: it looks at the live bottom of the pane, but first skips
past Claude Code's UI furniture — the input box, footer, key hints, the todo/task widget,
the status spinner, and the `/usage-credits` hint. So a genuine limit banner still
registers even when a tall task list or background-agent status pushes it well above the
prompt, while a banner merely *quoted* in scrollback (with real output below it) does not
trigger a retry.

Your own `customPatterns` are the exception: they are matched against the **raw** last-N
lines (not the chrome-skipped view), so a pattern keyed on footer text — a usage
percentage, a model name — keeps firing. You own the false-positive tradeoff for your
regexes; the built-in detection keeps the chrome-aware discipline.

## Configuration

Optional. Create `~/.claude-auto-retry.json`:

```json
{
  "maxRetries": 5,
  "pollIntervalSeconds": 5,
  "marginSeconds": 60,
  "fallbackWaitHours": 5,
  "retryMessage": "Continue where you left off. The previous attempt was rate limited.",
  "customPatterns": ["my custom pattern"]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | `5` | Max retry attempts per rate-limit event |
| `pollIntervalSeconds` | `5` | How often to check the terminal (seconds) |
| `marginSeconds` | `60` | Extra wait after reset time (seconds) |
| `fallbackWaitHours` | `5` | Wait time if reset time can't be parsed |
| `retryMessage` | `"Continue where..."` | Message sent to Claude on retry |
| `customPatterns` | `[]` | Additional regex patterns to detect rate limits |

All fields optional. Invalid values fall back to defaults automatically.

## Overload backoff

Separate from subscription rate limits, this fork also detects **sustained API
overload** — Claude Code's own terminal `API Error: <code>` line for the retryable
set (`429 / 500 / 502 / 503 / 504 / 529`, or an `overloaded_error` JSON body) — and
retries on an **exponential backoff** instead of waiting for a usage reset. The two
paths never collide; usage limits always take precedence.

> **Sustained only.** Claude Code already retries transient 5xx/529 internally
> with its own backoff. This feature fires only when those internal retries are
> exhausted and a *terminal* error is left in the pane. It should rarely trigger.

> **Terminal vs. transient.** Claude Code renders an in-progress retry as the
> *parens* form `API Error (529 …) · Retrying in 5s · attempt 3/10`, and the final
> exhausted error as the *colon* form `API Error: 529 …`. Detection requires the
> colon form **and** suppresses the `· Retrying…` / `attempt n/m` suffix, so the tool
> never interrupts Claude's own backoff.

> **Anchored, tail-only matching (why it won't fire on your code).** Patterns are
> case-insensitive **regexes** matched against only the **last 12 lines** of the
> pane — never the full scrollback. They are anchored to Claude Code's `API Error:
> <code>` render, so a bare `503` in code you're editing (`res.status(503)`), a
> port number, a quoted log, or a `status.claude.com` link in a comment will **not**
> trip detection. The one residual: a live tail that literally contains
> `API Error: 529` (e.g. editing this tool, or docs about Claude errors) will match —
> set `"enabled": false` while doing that. (Earlier versions matched bare status
> numbers across the whole capture, which injected spurious retries during ordinary
> web-dev sessions.) For a structured, ambiguity-free trigger see `DESIGN-NOTES.md`.

Configured under an `overload` block (shown with its defaults):

```json
{
  "overload": {
    "enabled": true,
    "patterns": ["API Error:\\s*(429|500|502|503|504|529)\\b", "overloaded_error", "temporarily limiting requests"],
    "backoffSeconds": [30, 60, 120, 240, 300],
    "steadyStateSeconds": 300,
    "jitterPct": 15,
    "maxTotalWaitMinutes": 120,
    "retryMessage": "Continue where you left off.",
    "relaunchOnExit": false,
    "relaunchCommand": "claude --continue"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the overload path on/off |
| `patterns` | (see above) | Case-insensitive **regexes** matching a terminal overload error in the pane tail (last 12 lines) |
| `backoffSeconds` | `[30,60,120,240,300]` | Wait before each retry; index `i` for attempt `i` |
| `steadyStateSeconds` | `300` | Wait once the `backoffSeconds` array is exhausted |
| `jitterPct` | `15` | ±% jitter applied to every wait (clamped 0–100) |
| `maxTotalWaitMinutes` | `120` | Cumulative-wait cap — give up loudly past this |
| `retryMessage` | `"Continue where you left off."` | Sent to Claude on each retry |
| `relaunchOnExit` | `false` | See the gating decision below |
| `relaunchCommand` | `"claude --continue"` | Command used by `relaunchOnExit` |

The waits go `30 → 60 → 120 → 240 → 300 → 300 …`, each with ±15% jitter, until the
error clears (success) or the cumulative wait reaches `maxTotalWaitMinutes` (give
up — the cap guards against hammering a genuinely-down endpoint or masking a real
outage; check [status.claude.com](https://status.claude.com)).

### Event-driven detection (recommended — no scraping)

The scraper above is a heuristic over terminal output. For an exact, ambiguity-free
trigger, install the **`StopFailure` hook** — Claude Code fires it precisely when a
turn ends in an API error, with a typed error class:

```sh
claude-auto-retry install-hook                  # into $CLAUDE_CONFIG_DIR or ~/.claude
claude-auto-retry install-hook /path/to/config  # repeat per CLAUDE_CONFIG_DIR you use
```

This adds a `StopFailure` hook (matcher `overloaded|server_error`) that writes a
pane-keyed marker the monitor consumes — no terminal scraping, so it cannot
false-positive on code or scrollback. Sessions launched via the wrapper **after**
installing the hook use it automatically; the first marker latches event mode and
disables the scraper for that session. Sessions without the hook (or pre-install) fall
back to the anchored scraper. Remove with `uninstall-hook`. See `DESIGN-NOTES.md` for
the architecture.

> **Why not `rate_limit`?** The event path handles only *transient overloads*
> (seconds-scale backoff). A `rate_limit` is the subscription **session/usage limit** —
> an hours-scale wait until a printed reset time — so it's handled by the usage-wait
> path above, not the overload path. Routing it through the hook would fire premature
> retries against a session that's simply out of quota.

### Gating decision (alive-at-prompt vs exited-to-shell)

A transient API error in interactive Claude Code surfaces inline and leaves the
process **alive at its prompt** — it does not exit to the shell. So the default,
robust behavior reuses the existing usage-limit mechanism: only retry when the
foreground process is `claude`/`node` and the session is **idle, not working**
(the `esc to interrupt` footer is absent). Retrying mid-internal-retry would
double-drive the session, so that case is deferred, never sent.

If a `500` ever *does* drop you to the shell, `send-keys` is correctly blocked by
the foreground check (it never types into bash), and the tool logs
`overload-exited-to-shell` rather than masking it. Auto-relaunch is **off by
default** — blindly typing `claude --continue` into a shell the user may be using
is worse than surfacing the stall. Set `relaunchOnExit: true` (and adjust
`relaunchCommand`) only if you actually observe shell-exits on overload.

## Safeguard retry

A third failure mode, separate from usage limits and 5xx overloads: the model's
**safeguards flag your message** and Claude Code can't respond. It renders like:

```
● API Error: Fable 5's safeguards flagged this message (…/legal/aup). They may flag
  safe, normal content as well. … Claude Code can't respond to this request with Fable 5.
  Double press esc to edit your last message, or try a different model with /model.
```

These flags are **often false positives** (the message says so) and semi-random, so an
immediate re-send frequently clears them. When the tool sees this render at an idle
prompt, it sends a short retry message (`continue` by default), waits a few seconds, and
repeats — but only up to `maxRetries` times, then **gives up loudly** (logged) rather
than looping. A sticky flag means the content/model combination is genuinely blocked;
switch models with `/model` or rephrase.

Detection is tail-anchored (last 12 pane lines) like the overload path, and a match
additionally requires the `API Error` render line nearby — so the phrases appearing in
scrollback or in a conversation *about* safeguards won't trigger it.

Configured under a `safeguard` block (defaults shown):

```json
{
  "safeguard": {
    "enabled": true,
    "patterns": ["safeguards flagged this message", "can't respond to this request with", "legal/aup"],
    "maxRetries": 3,
    "retryDelaySeconds": 8,
    "retryMessage": "continue"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the safeguard-retry path on/off |
| `patterns` | (see above) | Case-insensitive regexes marking the safeguard render (matched in the pane tail, near an `API Error` line) |
| `maxRetries` | `3` | Re-send attempts before giving up — kept small; retrying a sticky flag won't help |
| `retryDelaySeconds` | `8` | Wait between re-sends |
| `retryMessage` | `"continue"` | Message sent to nudge past the flag |

Usage limits always take precedence; the safeguard path only acts when Claude is idle
(no `esc to interrupt` footer) and the foreground process is `claude`/`node`.
## tmux status bar indicator

The monitor writes a small JSON snapshot per pane on every poll tick, so you can tell
at a glance — without checking logs — whether a pane is being watched, waiting out a
usage-limit reset, backing off from overload or a safeguard flag, or has given up.

Add a segment to `status-right` (or `status-left`) in `~/.tmux.conf` that shells out to
the bundled reader script, passing the current pane id **and** the server's socket path:

```tmux
set -g status-interval 5
set -g status-right "#(~/.local/lib/node_modules/claude-auto-retry/bin/tmux-status.sh '#{pane_id}' '#{socket_path}') | %Y-%m-%d %H:%M"
```

**Use an absolute path, not the bare command name.** `#()` commands run inside the tmux
*server's* own environment, not the environment of whichever shell you attached from —
if the server was started before your shell rc added `npm`/`nvm`'s bin directory to
`PATH` (e.g. tmux auto-started at login, or by another program), the bare command name
resolves to nothing and the segment stays permanently blank with no error anywhere.
Find your actual install path with `which claude-auto-retry-tmux-status` (run it in a
normal shell, then hardcode that path in `.tmux.conf`) if it differs from the example
above. If you use nvm and switch Node versions, re-check the path.

`tmux` substitutes `#{pane_id}` and `#{socket_path}` itself before running the command
(these are tmux format variables, resolved at expansion time — not environment
variables the script has to go looking for), so the segment always reflects whichever
pane you're looking at, correctly scoped to the tmux server it belongs to. The
`socket_path` argument matters if you ever run more than one tmux server on the same
machine (e.g. `tmux -L work`, `tmux -L personal`, or two users' default servers on a
shared host): pane ids like `%2` are only unique *within* a server, so without it two
different servers' `%2` panes would render each other's status. Always pass it: the
monitor keys each status file by the socket path it inherits from `$TMUX`, so a
single-argument config looks under a shared `default` key the monitor never writes to,
and the segment simply stays blank.

It prints:

| Pane state | Indicator |
|------------|-----------|
| Actively monitoring | `🟢AR` |
| Waiting on a usage-limit reset | `⏳AR 1h30m` |
| Backing off from overload | `🟠AR 45s` |
| Retrying past a safeguard/AUP false-positive | `🛡AR 8s` |
| Given up — max retries/backoff cap reached; no further automatic action on this pane | `🔴AR` |
| No monitor for this pane, or the status file is stale (monitor process died without cleaning up) | *(nothing)* |

`🔴AR` overrides whatever the underlying status would otherwise render. Several
give-up paths intentionally leave the monitor's internal status at whatever it was
when it stopped acting (so the scraper/event logic doesn't re-detect its own stale
error next tick) — without an explicit `gaveUp` flag in the snapshot, the status bar
would keep showing a live `🟢`/`⏳`/`🟠` indicator for a monitor that will not act
again on this pane until the underlying condition clears on its own.

Staleness is derived from each snapshot's own `pollIntervalSeconds` (age > 2× the
monitor's configured poll interval) rather than a fixed constant, so a healthy monitor
running with a longer `pollIntervalSeconds` doesn't have its segment blank out for a
large fraction of every tick.

The script (`bin/tmux-status.sh`) is pure POSIX shell with no dependencies (no `jq`,
no `node`), so it's cheap to run every few seconds from every attached client.
`status-interval` defaults to 15s in tmux; dropping it to `5` (matching the monitor's
default `pollIntervalSeconds`) keeps the overload countdown responsive.

## CLI Commands

```bash
claude-auto-retry install          # Install shell wrapper + tmux
claude-auto-retry uninstall        # Remove shell wrapper
claude-auto-retry status           # Show monitor activity + last log entries
claude-auto-retry logs             # Tail today's log file in real-time
claude-auto-retry version          # Print version

# Event-driven overload detection (optional; see "Overload backoff")
claude-auto-retry install-hook [dir]    # Install the StopFailure hook into a config dir
claude-auto-retry uninstall-hook [dir]  # Remove it

# Monitor coverage (see "Keeping monitors alive")
claude-auto-retry reconcile        # Re-arm a monitor for every live claude pane not covered
claude-auto-retry reconcile --dry-run   # Preview without arming
claude-auto-retry install-timer    # systemd --user timer: run reconcile every 5 min
claude-auto-retry uninstall-timer  # Remove the timer
claude-auto-retry exclude-self     # Keep THIS session unmonitored (durable, self-expiring)
```

## For AI Agents

If you are an AI agent (Claude Code, Codex, etc.) installing this for your user, the
full setup is non-interactive:

```bash
npm install -g claude-auto-retry
claude-auto-retry install        # shell wrapper (+ tmux if missing)
claude-auto-retry install-hook   # recommended: event-driven, scrape-free overload detection
```

Notes for agents:

- The wrapper takes effect in **new** shells — have the user `source` their shell rc or
  open a new terminal. Sessions launched via the wrapper run inside tmux (required by
  the monitor).
- Verify with `claude-auto-retry status` (monitor activity) and `claude-auto-retry logs`.
- Configuration is optional and defaults are safe. To change it, write
  `~/.claude-auto-retry.json` (see [Configuration](#configuration)); invalid values fall
  back to defaults instead of crashing.
- If the user runs multiple `CLAUDE_CONFIG_DIR`s, repeat `claude-auto-retry install-hook <path>` per dir.
- Clean removal: `claude-auto-retry uninstall` and `claude-auto-retry uninstall-hook`.

## Keeping monitors alive

Each `claude` you launch through the wrapper gets its own background monitor. Monitors
are detached processes with no supervising service, so if one is killed — or a `claude`
is started outside the wrapper — that session ends up unmonitored, and only *new*
sessions get a monitor. Two commands restore and maintain full coverage:

- **`reconcile`** re-arms a monitor for every live tmux pane running `claude` that isn't
  already covered. It maps each `claude` to its pane from live process state, keeps one
  monitor per pane (idempotent — safe to run anytime, and a single-instance lock stops an
  overlapping manual+timer run from double-arming), and handles tmux pane-id reuse. Print-
  mode sessions (`claude -p`) are skipped, and a `claude` that doesn't set its process
  title to `claude` (a bare `node` shebang) isn't detected — use the wrapper for those.
  Run it after a crash, or use `--dry-run` to see what it would do.
- **`install-timer`** wires `reconcile` to a `systemd --user` timer that runs every 5
  minutes, so a monitor that dies is re-armed within one interval — coverage self-heals
  with no manual step. (Enable `loginctl enable-linger $USER` once if you want it to run
  while logged out.)

**Excluding a session.** To keep a specific session *unmonitored* (e.g. one where you're
pasting rate-limit text and don't want any auto-retry), run `claude-auto-retry
exclude-self` from inside it. This records the session's `claude` PID in
`~/.claude-auto-retry/reconcile-exclude`; both `reconcile` and the timer skip it. Keying
on the PID makes the entry **self-expiring**: dead PIDs are pruned when the file is read,
so once that `claude` exits its entry is dropped and can never accidentally mute a later
session (tmux reuses pane ids, so a hand-added `%pane` exclude could — pane ids are not
pruned, since staleness can't be detected). Prefer the PID form; you can also hand-add a
`%pane` id or a PID to that file.

## Platform Support

### Operating Systems

| OS | tmux auto-install | Status |
|----|-------------------|--------|
| Ubuntu / Debian | `apt-get` | Fully supported |
| CentOS / RHEL / Fedora | `dnf` | Fully supported |
| Rocky Linux / Amazon Linux | `dnf` | Fully supported |
| macOS | `brew` | Fully supported |
| Arch Linux | `pacman` | Fully supported |
| Alpine | `apk` | Fully supported |

### Requirements

- **Node.js** >= 18
- **tmux** >= 2.1 (auto-installed if missing)

### Shell Support

| Shell | Status |
|-------|--------|
| bash | Full (auto-install to `~/.bashrc`) |
| zsh | Full (auto-install to `~/.zshrc`) |
| fish | Manual setup (instructions printed on `install`) |

## `--print` Mode

For scripted/piped usage (`claude -p "..." | jq`), the tool:

1. Buffers all output (nothing goes to stdout until done)
2. If rate-limited: discards partial output, waits, re-executes with same args
3. Consumer receives a single clean response

```bash
# This just works — retries transparently if rate-limited
claude -p "Generate a JSON schema" | jq .
```

## Logging

Logs are written to `~/.claude-auto-retry/logs/YYYY-MM-DD.log`:

```
[2026-03-18 15:00:05] [INFO] Monitor started for pane %3 (claude PID: 12345)
[2026-03-18 15:32:10] [INFO] Rate limit detected: "5-hour limit reached - resets 3pm". Waiting 3547s...
[2026-03-18 16:01:10] [INFO] Sent retry message (attempt 1)
```

Logs rotate daily. Files older than 7 days are cleaned automatically.

## Uninstall

```bash
claude-auto-retry uninstall
npm uninstall -g claude-auto-retry
```

This removes the shell function from your rc files. tmux is left installed.

## Known Limitations

1. **Retry message context** — The retry message is sent as plain text. If Claude was mid-confirmation or in a special input state, it may not interpret it as a continuation. You can customize the message via config.

2. **Node version lock** — The launcher path is resolved at install time. If you switch Node versions with nvm, re-run `claude-auto-retry install`.

3. **tmux required** — The tool needs tmux to monitor terminal output and inject keystrokes. It auto-installs if missing, but requires sudo for system package managers.

## Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
git clone https://github.com/cheapestinference/claude-auto-retry.git
cd claude-auto-retry
npm test            # Run all 128 tests
npm link            # Install locally for testing
```

### Project Structure

```
claude-auto-retry/
├── bin/cli.js              # CLI: install, hook, reconcile, timer, status, logs, ...
├── src/
│   ├── patterns.js         # Rate limit + overload detection + ANSI stripping
│   ├── time-parser.js      # Reset time parsing with timezone support
│   ├── config.js           # Config loading + validation
│   ├── logger.js           # File-based logging with rotation
│   ├── tmux.js             # tmux command wrappers (execFile-based)
│   ├── monitor.js          # Core monitoring loop + retry logic (usage + overload paths)
│   ├── events.js           # StopFailure hook event channel (scrape-free overload trigger)
│   ├── reconcile.js        # Re-arm monitors for all live claude panes + exclusion
│   ├── launcher.js         # Process orchestration + signal forwarding
│   └── wrapper.sh          # Shell function template
├── systemd/                # systemd --user units for the reconcile timer
├── test/                   # tests across the src modules
├── package.json
├── LICENSE
└── README.md
```

### Architecture Decisions

- **Zero dependencies** — only Node.js built-ins. Reduces supply chain risk and install size.
- **`execFile` over `exec`** — all child process calls use array-based args to prevent shell injection.
- **`stdio: 'inherit'`** — Claude gets the real TTY for full TUI support. The monitor reads pane content independently via `tmux capture-pane`.
- **Iterative DST correction** — timezone offset is computed via 3-iteration convergence loop, not a single-shot formula that breaks at DST boundaries.
- **Config validation** — invalid user config values fall back to safe defaults instead of producing NaN/undefined behavior.

### Running Tests

```bash
npm test                              # All tests
node --test test/patterns.test.js     # Single file
node --test --watch test/             # Watch mode
```

### Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests first (TDD)
4. Make your changes
5. Ensure all tests pass (`npm test`)
6. Submit a Pull Request

### Areas for Contribution

- **New rate limit patterns** — If you see a Claude Code rate limit message that isn't detected, open an issue with the exact text.
- **Fish shell support** — Auto-install for fish shell (currently manual).
- **Windows support** — WSL works, but native Windows would need a different approach.
- **Notification integration** — Desktop/Slack notification when rate limit detected or when Claude resumes.

## Related Projects

- [claude-code-queue](https://github.com/JCSnap/claude-code-queue) — Queue-based task system for Claude Code with rate limit handling
- [opencode-claude-quota](https://github.com/nguyenngothuong/opencode-claude-quota) — Rate limit quota monitoring (display only)

## FAQ

**Q: Does this work with Claude Max/Pro/Team?**
A: Yes. It works with any Anthropic subscription that has usage-based rate limits.

**Q: Does it work outside of tmux?**
A: Yes. If you're not in tmux, it creates a tmux session transparently. You won't notice a difference.

**Q: What if I continue manually before the retry fires?**
A: The monitor checks if the rate limit is still visible before sending keys. If you already continued, it resets and keeps watching.

**Q: What if Claude exits while the monitor is waiting?**
A: The monitor checks the Claude process every 30 seconds during the wait. If Claude exits, the monitor shuts down cleanly.

**Q: Does it consume a lot of resources?**
A: No. `tmux capture-pane` is extremely lightweight. The monitor uses ~0% CPU at a 5-second polling interval.

**Q: Can it accidentally type into the wrong program?**
A: The monitor verifies the foreground process is `node` or `claude` before sending keys. If you've switched to vim, bash, or anything else, it skips the retry.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Made with care by [CheapestInference](https://github.com/cheapestinference).
