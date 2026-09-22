#!/usr/bin/env bash
# Dev-mode entrypoint. Prepares the checkout's npm dependencies, makes sure
# the chosen data root is not silently shared with another Mia (the installed
# bundle, or a different checkout's dev mode), and then launches through
# start-local-mac.sh. Environment parity with the packaged bundle lives in
# macos/src/main.cjs (ghostBridgePaths + MIA_DEV_DATA_ROOT isolation), so a
# dev run and an installed Mia.app can genuinely be used interchangeably.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "dev_mode.sh currently supports macOS local development." >&2
  exit 1
fi

data_root="${MIA_DEV_DATA_ROOT:-$HOME/.miaos}"

read_json_field() {
  local file="$1" field="$2"
  python3 - "$file" "$field" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get(sys.argv[2], ""))
except Exception:
    print("")
PY
}

# Returns 0 for "overwrite" (keep this root), 1 for "install elsewhere".
prompt_choice() {
  local message="$1" choice=""
  if [[ ! -t 0 ]]; then
    echo "$message" >&2
    echo "Non-interactive shell: point MIA_DEV_DATA_ROOT at the data root you want and rerun." >&2
    exit 2
  fi
  while :; do
    read -r -p "$message Overwrite (share it) [o], install elsewhere [e], or quit [q]? " choice
    case "$choice" in
      o|O) return 0 ;;
      e|E) return 1 ;;
      q|Q) echo "Aborted."; exit 0 ;;
      *) echo "Please answer o, e, or q." ;;
    esac
  done
}

choose_data_root() {
  while :; do
    local marker="$data_root/dev-mode.json"
    local manifest="$data_root/install-manifest.json"
    if [[ -f "$marker" ]]; then
      local other_checkout
      other_checkout="$(read_json_field "$marker" devCheckout)"
      if [[ -z "$other_checkout" || "$other_checkout" == "$repo_root" ]]; then
        return
      fi
      if prompt_choice "We detected another Mia dev mode (checkout: $other_checkout) using $data_root."; then
        return
      fi
    elif [[ -f "$manifest" ]]; then
      local bundle
      bundle="$(read_json_field "$manifest" miaosInstall)"
      if prompt_choice "We detected a Mia bundle installation (${bundle:-unknown location}) using $data_root."; then
        return
      fi
    else
      return
    fi
    read -r -p "New data root path: " data_root
    data_root="${data_root/#\~/$HOME}"
    if [[ -z "$data_root" ]]; then
      echo "A path is required." >&2
      exit 2
    fi
  done
}

choose_data_root
mkdir -p "$data_root"

# Dev mode reuses an already-provisioned runtime; it never downloads one.
if [[ ! -x "$data_root/hermes/hermes-agent/hermes" ]]; then
  echo "No Mia runtime is provisioned at $data_root." >&2
  echo "Run scripts/install-local-mac.sh first (it provisions \$HOME/.miaos), or point" >&2
  echo "MIA_DEV_DATA_ROOT at a data root that already contains hermes/ and ghost-cli/." >&2
  exit 1
fi

# Claim the root for this checkout so the next dev launch (from any checkout)
# can tell whose state it is about to reuse.
python3 - "$data_root/dev-mode.json" "$repo_root" <<'PY'
import datetime
import json
import sys

path, checkout = sys.argv[1], sys.argv[2]
payload = {
    "devCheckout": checkout,
    "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=1)
    handle.write("\n")
PY

# start-local-mac.sh installs backend dependencies (plus the Electron rebuild
# of better-sqlite3) when they are missing; the shell's own node_modules is
# the one piece it assumes already exists.
if [[ ! -d "$repo_root/macos/node_modules" ]]; then
  echo "Installing Electron shell dependencies…"
  (cd "$repo_root/macos" && npm install --no-audit --no-fund)
fi

export MIA_DEV_DATA_ROOT="$data_root"
# Dev runs use Mia's test Clerk instance (production is the built-in
# default). Export MIAOS_CLERK_INSTANCE=production to exercise production.
export MIAOS_CLERK_INSTANCE="${MIAOS_CLERK_INSTANCE:-test}"
exec bash "$script_dir/start-local-mac.sh" "$@"
