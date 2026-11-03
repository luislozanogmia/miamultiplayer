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

bus_has_keyring() {
  DBUS_SESSION_BUS_ADDRESS="$1" dbus-send --session --print-reply --dest=org.freedesktop.DBus / \
    org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep -q 'boolean true'
}

# A desktop can run on a private session bus while the keyring stays on the
# user's bus. Sign-in needs the keyring, so it decides which bus the app gets.
session_bus="$(session_env DBUS_SESSION_BUS_ADDRESS)"
runtime_dir="$(session_env XDG_RUNTIME_DIR)"
user_bus="unix:path=${runtime_dir:-/run/user/$(id -u)}/bus"
if ! bus_has_keyring "$session_bus" && bus_has_keyring "$user_bus"; then
  session_bus="$user_bus"
fi

printf 'export DISPLAY=%q\n' "$display"
if [[ -n "$session_bus" ]]; then printf 'export DBUS_SESSION_BUS_ADDRESS=%q\n' "$session_bus"; fi
for name in XAUTHORITY XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP; do
  value="$(session_env "$name")"
  if [[ -n "$value" ]]; then printf 'export %s=%q\n' "$name" "$value"; fi
done
