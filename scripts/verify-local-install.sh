#!/usr/bin/env bash
set -euo pipefail

user_home="${HOME:?HOME is required}"
miaos_home="${MIAOS_HOME:-$user_home/.miaos}"
local_share="${XDG_DATA_HOME:-$user_home/.local/share}"
hermes_home="$local_share/miaos/hermes"
hermes_bin="$local_share/miaos/bin/hermes"
ghost_bin="${XDG_BIN_HOME:-$user_home/.local/bin}/ghost-cli"
desktop_bin="${XDG_BIN_HOME:-$user_home/.local/bin}/miaos-desktop"
bot_bin="${XDG_BIN_HOME:-$user_home/.local/bin}/miaos-bot"
desktop_entry="$local_share/applications/miaos.desktop"
linux_icon="$local_share/icons/hicolor/512x512/apps/miaos.png"
app_install_dir="$local_share/miaos/app"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hermes-release.env
source "$script_dir/hermes-release.env"
# shellcheck source=ghost-release.env
source "$script_dir/ghost-release.env"

[[ -x "$hermes_bin" ]] || { echo "Hermes launcher is missing" >&2; exit 1; }
[[ -x "$bot_bin" ]] || { echo "Mia bot launcher is missing" >&2; exit 1; }
[[ -x "$ghost_bin" ]] || { echo "Ghost CLI launcher is missing" >&2; exit 1; }
[[ -x "$desktop_bin" ]] || { echo "Mia desktop launcher is missing" >&2; exit 1; }
[[ -f "$desktop_entry" ]] || { echo "Mia Linux desktop entry is missing" >&2; exit 1; }
[[ -f "$linux_icon" ]] || { echo "Mia Linux application icon is missing" >&2; exit 1; }
grep -qx 'Icon=miaos' "$desktop_entry" || { echo "Mia desktop entry has the wrong icon" >&2; exit 1; }
[[ -f "$miaos_home/install-manifest.json" ]] || { echo "Mia install manifest is missing" >&2; exit 1; }
[[ -f "$hermes_home/.no-bundled-skills" ]] || { echo "Blank-slate skills marker is missing" >&2; exit 1; }
[[ ! -e "$hermes_home/auth.json" ]] || { echo "Hermes provider credentials are present" >&2; exit 1; }
for profile_env in "$hermes_home/profiles/miaos-agent-runtime/.env" "$hermes_home/profiles/miaos-bot-worker/.env"; do
  [[ ! -e "$profile_env" ]] || [[ ! -s "$profile_env" ]] ||
    [[ -z "$(grep -Ev '^[[:space:]]*(#|$)' "$profile_env")" ]] || {
      echo "Hermes profile credentials are present: $profile_env" >&2
      exit 1
    }
done
[[ ! -e "$hermes_home/hermes-agent/.git" ]] || { echo "Hermes bundle still has self-update metadata" >&2; exit 1; }
[[ "$(cat "$hermes_home/hermes-agent/.miaos-source-commit")" == "$HERMES_COMMIT" ]] || {
  echo "Hermes source commit does not match the Mia tested release" >&2
  exit 1
}
[[ -f "$miaos_home/ghost-cli/in_app_browser_transport.py" ]] || { echo "Ghost in-app browser connector is missing" >&2; exit 1; }
[[ ! -e "$miaos_home/ghost-cli/.git" ]] || { echo "Ghost bundle still has self-update metadata" >&2; exit 1; }
[[ "$(cat "$miaos_home/ghost-cli/.miaos-source-commit")" == "$GHOST_COMMIT" ]] || {
  echo "Ghost source commit does not match the Mia tested release" >&2
  exit 1
}
"$hermes_bin" --version
"$ghost_bin" list-tools >/dev/null
[[ -x "$app_install_dir/macos/node_modules/.bin/electron" ]] || { echo "Mia Electron runtime is missing" >&2; exit 1; }
grep -Fq "$app_install_dir/macos/node_modules/.bin/electron" "$desktop_bin" || { echo "Mia launcher is not using the installed runtime" >&2; exit 1; }
if grep -Fq "$script_dir/.." "$desktop_bin"; then
  echo "Mia launcher still references the source checkout" >&2
  exit 1
fi
echo "Local Mia/Hermes/Ghost installation verified."
