#!/usr/bin/env bash
# Prints the exports that put the Linux dev app on the remote desktop session
# of the current user. Dev mode always runs where a person can see it, so there
# is no fallback: with no desktop session, or only the login screen's display,
# this fails instead of running headless or somewhere nobody can reach.
set -euo pipefail

proc_root="${MIA_DEV_PROC_ROOT:-/proc}"

session_pid="$(pgrep -n -u "$(id -u)" -x xfce4-session || true)"
if [[ -z "$session_pid" || ! -r "$proc_root/$session_pid/environ" ]]; then
  echo "No remote desktop session is running. Connect by remote desktop, then start dev mode again." >&2
  exit 1
fi

session_env() {
  tr '\0' '\n' < "$proc_root/$session_pid/environ" | sed -n "s/^$1=//p" | head -n 1
}

display="$(session_env DISPLAY)"
if [[ ! "$display" =~ ^:[1-9][0-9]*(\.[0-9]+)?$ ]]; then
  echo "The desktop session is on display '${display:-none}', not a remote desktop display." >&2
  exit 1
fi

printf 'export DISPLAY=%q\n' "$display"
for name in XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP; do
  value="$(session_env "$name")"
  if [[ -n "$value" ]]; then printf 'export %s=%q\n' "$name" "$value"; fi
done
