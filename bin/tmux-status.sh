#!/bin/sh
# tmux status-bar segment for claude-auto-retry. Pure POSIX (no bashisms) so it runs
# on dependency-light hosts (Alpine/busybox) too — matching the "dependency-free" claim,
# hence #!/bin/sh rather than #!/usr/bin/env bash.
#
# Usage in ~/.tmux.conf (see README "tmux status bar indicator" for the full recipe):
#   #(~/.local/lib/node_modules/claude-auto-retry/bin/tmux-status.sh '#{pane_id}' '#{socket_path}')
#
# The 2nd arg (tmux's own #{socket_path} format variable) disambiguates panes across
# independent tmux servers (`tmux -L work` vs `tmux -L personal` can each have a "%2")
# and is effectively required: the monitor keys its status files by the socket path it
# inherits from $TMUX, so a single-arg invocation looks under a "default" key the monitor
# never writes to and the segment just stays blank. Always pass '#{socket_path}'.
#
# Prints nothing if the pane has no monitor, or the monitor's status file is stale
# (monitor process died without cleaning up — e.g. `kill -9`, machine sleep during a
# tmux-server-less state). Kept dependency-free (no jq/node) so this can run every
# few seconds from every attached client without noticeable cost.

pane="$1"
socket="${2:-default}"
[ -z "$pane" ] && exit 0

safe_socket=$(printf '%s' "$socket" | tr -c 'A-Za-z0-9_-' '_')
safe_pane=$(printf '%s' "$pane" | tr -c 'A-Za-z0-9_-' '_')
file="$HOME/.claude-auto-retry/status/${safe_socket}_${safe_pane}.json"
[ -f "$file" ] || exit 0

json=$(cat "$file" 2>/dev/null) || exit 0
status=$(printf '%s' "$json" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
updated=$(printf '%s' "$json" | grep -o '"updatedAt":[0-9]*' | head -1 | grep -o '[0-9]*')
[ -z "$status" ] || [ -z "$updated" ] && exit 0

now=$(date +%s)
age=$(( now - updated ))

# Staleness scales with the monitor's own poll interval (written into every snapshot)
# instead of a fixed constant — a configurable pollIntervalSeconds far above the old
# hardcoded 30s would otherwise make a perfectly healthy monitor's segment blank out for
# a large fraction of every tick. Falls back to 15s (-> 30s stale threshold, matching the
# tool's pre-fix behavior) for older status files written before this field existed.
# Floored at 10s so very low configured intervals don't flicker on ordinary scheduling
# jitter (tmux capture-pane + a Node event-loop tick occasionally running a beat late).
interval=$(printf '%s' "$json" | grep -o '"pollIntervalSeconds":[0-9]*' | head -1 | grep -o '[0-9]*')
[ -z "$interval" ] && interval=15
staleAfter=$(( interval * 2 ))
[ "$staleAfter" -lt 10 ] && staleAfter=10
[ "$age" -gt "$staleAfter" ] && exit 0

# gaveUp overrides the normal per-status rendering: several terminal give-up paths leave
# `status` at whatever it was when the monitor stopped acting (waiting/overload/monitoring
# all keep ticking their live icon otherwise), which reads as a healthy monitor. A single
# explicit flag is a lot more honest than reverse-engineering "given up" from timestamps.
gaveUp=$(printf '%s' "$json" | grep -o '"gaveUp":true')
if [ -n "$gaveUp" ]; then
  printf '🔴AR'
  exit 0
fi

case "$status" in
  waiting)
    waitUntil=$(printf '%s' "$json" | grep -o '"waitUntil":[0-9]*' | head -1 | grep -o '[0-9]*')
    remain=$(( waitUntil - now ))
    [ "$remain" -lt 0 ] && remain=0
    if [ "$remain" -ge 3600 ]; then
      printf '⏳AR %dh%02dm' $(( remain / 3600 )) $(( (remain % 3600) / 60 ))
    else
      printf '⏳AR %dm' $(( remain / 60 ))
    fi
    ;;
  overload)
    overloadWaitUntil=$(printf '%s' "$json" | grep -o '"overloadWaitUntil":[0-9]*' | head -1 | grep -o '[0-9]*')
    remain=$(( overloadWaitUntil - now ))
    [ "$remain" -lt 0 ] && remain=0
    printf '🟠AR %ds' "$remain"
    ;;
  safeguard)
    safeguardWaitUntil=$(printf '%s' "$json" | grep -o '"safeguardWaitUntil":[0-9]*' | head -1 | grep -o '[0-9]*')
    remain=$(( safeguardWaitUntil - now ))
    [ "$remain" -lt 0 ] && remain=0
    printf '🛡AR %ds' "$remain"
    ;;
  # stale-reset (pressing Enter on native auto-continue's stale "Press enter to continue")
  # reuses the monitoring glyph rather than getting its own: the state lasts seconds (a 3s
  # delay, at most a couple of presses), so a dedicated glyph would only flicker, and its
  # give-up is already rendered by the gaveUp override above.
  monitoring|stale-reset)
    printf '🟢AR'
    ;;
  *)
    exit 0
    ;;
esac
