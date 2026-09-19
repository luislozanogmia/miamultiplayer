#!/usr/bin/env bash
# Canonical launcher for testing the current Mia checkout against the locally
# installed, bundled runtimes. Keep runtime discovery here so developers and
# agents never hand-build HERMES_BIN paths.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
engineering_root="$(cd -- "$script_dir/.." && pwd)"
macos_root="$engineering_root/macos"
user_home="${HOME:?HOME is required}"
mia_data_root="${MIA_DEV_DATA_ROOT:-$user_home/Library/Application Support/Mia}"
# The Electron main process keys dev-mode isolation off this variable: with it
# set, the dev app keeps its userData (renderer state, cookies, the browser
# bridge) under <data root>/desktop instead of sharing the installed bundle's
# profile. Export it even when the caller relied on the default.
export MIA_DEV_DATA_ROOT="$mia_data_root"
hermes_home="$mia_data_root/hermes"
hermes_install="$hermes_home/hermes-agent"
hermes_bin="$hermes_install/hermes"
hermes_python="$hermes_install/venv/bin/python"
# install-local-mac.sh provisions Ghost at <data root>/ghost-cli; older dev
# setups used <data root>/runtime/ghost-cli. Accept either.
ghost_home="$mia_data_root/ghost-cli"
[[ -d "$ghost_home" ]] || ghost_home="$mia_data_root/runtime/ghost-cli"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This launcher is for macOS local testing." >&2
  exit 1
fi

for required in \
  "$hermes_bin" \
  "$hermes_python" \
  "$ghost_home/in_app_browser_transport.py" \
  "$macos_root/package.json"; do
  [[ -e "$required" ]] || {
    echo "Mia local-test runtime is incomplete: $required" >&2
    echo "Install the current Mia build before starting the development app." >&2
    exit 1
  }
done

[[ -x "$hermes_bin" ]] || { echo "Hermes launcher is not executable: $hermes_bin" >&2; exit 1; }
[[ -x "$hermes_python" ]] || { echo "Hermes Python is not executable: $hermes_python" >&2; exit 1; }
[[ -x "$macos_root/node_modules/.bin/electron" ]] || {
  echo "Electron dependencies are missing. Run npm install in $macos_root first." >&2
  exit 1
}

backend_root="$engineering_root/backend"
if [[ ! -d "$backend_root/node_modules" ]]; then
  echo "Installing backend dependencies…"
  (cd "$backend_root" && npm install --no-audit --no-fund)
  echo "Rebuilding native modules for Electron…"
  (cd "$macos_root" && npx electron-rebuild -m "$backend_root" --only better-sqlite3)
fi

gws_bin="${MIA_DEV_GWS_BIN:-}"
if [[ -z "$gws_bin" ]] && command -v gws >/dev/null 2>&1; then
  gws_bin="$(command -v gws)"
fi
if [[ -z "$gws_bin" && -x "$user_home/.npm-global/bin/gws" ]]; then
  gws_bin="$user_home/.npm-global/bin/gws"
fi
[[ -n "$gws_bin" && -x "$gws_bin" ]] || {
  echo "Google Workspace CLI is missing; set MIA_DEV_GWS_BIN to its executable." >&2
  exit 1
}

# Make the source launcher use its own venv. This is the critical distinction
# from venv/bin/hermes, whose generated entrypoint cannot resolve hermes_cli in
# the bundled source layout.
export HERMES_HOME="$hermes_home"
export HERMES_BIN="$hermes_bin"
export MIAOS_HERMES_BIN="$hermes_bin"
export HERMES_PYTHON="$hermes_python"
export HERMES_GWS_BIN="$gws_bin"
# The native keyring backend can hand different keys to short-lived gws
# processes launched by Electron during development. gws officially supports
# this persistent encrypted-file backend for headless/embedded runtimes.
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND="${GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:-file}"
export GHOST_CLI_HOME="$ghost_home"
export VIRTUAL_ENV="$hermes_install/venv"
export PATH="$hermes_install/venv/bin:$PATH"
export PYTHONPATH="$hermes_install"

"$hermes_bin" auth add --help >/dev/null
"$gws_bin" --version >/dev/null

echo "Mia local-test runtime ready."
echo "Hermes launcher: $hermes_bin"
echo "Google Workspace CLI: $gws_bin"

if [[ "${1:-}" == "--check" ]]; then
  [[ "$#" -eq 1 ]] || { echo "Usage: $0 [--check]" >&2; exit 2; }
  exit 0
fi
[[ "$#" -eq 0 ]] || { echo "Usage: $0 [--check]" >&2; exit 2; }

cd "$macos_root"
exec npm run dev
