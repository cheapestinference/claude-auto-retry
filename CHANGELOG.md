# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Safeguard/AUP false-positive auto-retry: when the model's safeguards flag a
  message ("safeguards flagged this message"), re-send a short retry up to
  `safeguard.maxRetries` times, then give up loudly once. Detection is anchored
  to the `API Error` render (mentioning the phrases in conversation can't
  trigger it), and the retry budget is kept across working ticks so a sticky
  flag stays bounded (#33).

### Fixed
- Monitor no longer stays parked on a stale wait timer once the session resumes:
  while counting down a usage wait, a pane that has resumed working (e.g. the user
  manually typed `continue` to unstick a wrong/stale wait) now drops back to
  monitoring immediately, so a second, genuine limit that follows is detected
  instead of being masked until the old timer expires (#39).
- `rate_limit` StopFailure events are no longer routed through the seconds-scale
  overload path — a session/usage limit is an hours-scale wait owned by the
  usage path, and the misroute made the two fight (futile `Continue` retries
  into a session-limited pane). The marker error type is validated at the
  consumer too, so an outdated installed hook can't reintroduce it (#31).

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
