# >>> claude-auto-retry >>>
# Drop any pre-existing `claude` alias (Claude Code's own installer adds one)
# before defining the wrapper function. Without this, the shell expands the
# alias while parsing `claude() {`, producing "syntax error near unexpected
# token '('" when the rc file is sourced.
unalias claude 2>/dev/null || true
claude() {
  if [ "${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  export CLAUDE_AUTO_RETRY_ACTIVE=1
  local _car_old_int_trap _car_old_term_trap
  _car_old_int_trap=$(trap -p INT)
  _car_old_term_trap=$(trap -p TERM)
  trap 'unset CLAUDE_AUTO_RETRY_ACTIVE' INT TERM
  node "__LAUNCHER_PATH__" "$@"
  local _car_exit=$?
  unset CLAUDE_AUTO_RETRY_ACTIVE
  # Restore previous traps instead of clobbering them
  eval "${_car_old_int_trap:-trap - INT}"
  eval "${_car_old_term_trap:-trap - TERM}"
  return $_car_exit
}
# <<< claude-auto-retry <<<
