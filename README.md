# claude-auto-retry

> Automatically retry Claude Code sessions when you hit Anthropic subscription rate limits.

When Claude Code shows *"5-hour limit reached - resets 3pm"*, this tool waits for the reset and sends "continue" automatically. You come back to find your work done.

**No dependencies. No workflow change. Just install and forget.**

[![npm version](https://img.shields.io/npm/v/claude-auto-retry.svg)](https://www.npmjs.com/package/claude-auto-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

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
- **`--print` mode support** — buffers output, retries cleanly for piped/scripted usage
- **Configurable** — retry count, wait margin, custom patterns, retry message
- **Config validation** — bad config values fall back to safe defaults instead of crashing
- **Zero dependencies** — pure Node.js, no `node_modules`

## Rate Limit Patterns Detected

The tool detects these real-world Claude Code messages:

| Pattern | Example |
|---------|---------|
| N-hour limit reached | `5-hour limit reached - resets 3pm (UTC)` |
| Usage limit | `Claude usage limit reached. Resets at 2pm` |
| Out of extra usage | `You're out of extra usage · resets 3pm` |
| Try again | `Please try again in 5 hours` |
| Hit your limit | `You've hit your limit · resets 3pm (Europe/Dublin)` |
| Rate limit | `Rate limit hit. Resets at 4pm` |

Custom patterns can be added via config for future message format changes.

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

## CLI Commands

```bash
claude-auto-retry install     # Install shell wrapper + tmux
claude-auto-retry uninstall   # Remove shell wrapper
claude-auto-retry status      # Show monitor activity + last log entries
claude-auto-retry logs        # Tail today's log file in real-time
claude-auto-retry version     # Print version
```

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
npm test            # Run all 59 tests
npm link            # Install locally for testing
```

### Project Structure

```
claude-auto-retry/
├── bin/cli.js              # CLI: install/uninstall/status/logs/version
├── src/
│   ├── patterns.js         # Rate limit detection + ANSI stripping
│   ├── time-parser.js      # Reset time parsing with timezone support
│   ├── config.js           # Config loading + validation
│   ├── logger.js           # File-based logging with rotation
│   ├── tmux.js             # tmux command wrappers (execFile-based)
│   ├── monitor.js          # Core monitoring loop + retry logic
│   ├── launcher.js         # Process orchestration + signal forwarding
│   └── wrapper.sh          # Shell function template
├── test/                   # 59 tests across 7 test files
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
