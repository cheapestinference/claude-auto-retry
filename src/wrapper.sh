# >>> claude-auto-retry >>>
# Drop any pre-existing `claude` alias (Claude Code's own installer adds one)
# before defining the wrapper function. Without this, the shell expands the
# alias while parsing `claude() {`, producing "syntax error near unexpected
# token '('" when the rc file is sourced.
unalias claude 2>/dev/null || true
claude() {
  # Degrade to plain claude if already inside a wrapped session, or if the launcher
  # is gone (package removed via `npm uninstall -g` without `claude-auto-retry
  # uninstall` first) — an orphaned wrapper must never break the claude command.
  if [ "${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ] || [ ! -e "__LAUNCHER_PATH__" ]; then
    command claude "$@"
    return $?
  fi
  export CLAUDE_AUTO_RETRY_ACTIVE=1
  local _car_exit
  if [ -n "${ZSH_VERSION:-}" ]; then
    # zsh: localtraps restores the user's INT/TERM traps automatically on function
    # return. Capture/restore is NOT portable here — `trap -p` is a bashism (zsh
    # treats it as setting a handler), and $(trap) runs in a subshell where zsh
    # lists nothing — so the bash-style path silently wiped the user's traps.
    setopt localoptions localtraps
    trap 'unset CLAUDE_AUTO_RETRY_ACTIVE' INT TERM
    node "__LAUNCHER_PATH__" "$@"
    _car_exit=$?
  else
    # bash: function traps are global, so capture and restore around ours.
    local _car_old_int_trap _car_old_term_trap
    _car_old_int_trap=$(trap -p INT 2>/dev/null)
    _car_old_term_trap=$(trap -p TERM 2>/dev/null)
    trap 'unset CLAUDE_AUTO_RETRY_ACTIVE' INT TERM
    node "__LAUNCHER_PATH__" "$@"
    _car_exit=$?
    # Restore previous traps instead of clobbering them
    eval "${_car_old_int_trap:-trap - INT}"
    eval "${_car_old_term_trap:-trap - TERM}"
  fi
  unset CLAUDE_AUTO_RETRY_ACTIVE
  return $_car_exit
}
# <<< claude-auto-retry <<<
