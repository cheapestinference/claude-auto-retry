# >>> claude-auto-retry >>>
claude() {
  if [ "${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  export CLAUDE_AUTO_RETRY_ACTIVE=1
  trap 'unset CLAUDE_AUTO_RETRY_ACTIVE' EXIT INT TERM
  node "__LAUNCHER_PATH__" "$@"
  local _car_exit=$?
  unset CLAUDE_AUTO_RETRY_ACTIVE
  trap - EXIT INT TERM
  return $_car_exit
}
# <<< claude-auto-retry <<<
