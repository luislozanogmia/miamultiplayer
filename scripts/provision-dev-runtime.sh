#!/usr/bin/env bash
# Installs dev mode's own Hermes and Ghost CLI programs (default
# ~/.miaos-dev-runtime), the same pinned, patched versions the release
# installer uses. Dev mode never runs the installed Mia's programs, so
# updating or reinstalling one never changes the other.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hermes-release.env
source "$script_dir/hermes-release.env"
# shellcheck source=ghost-release.env
source "$script_dir/ghost-release.env"
# shellcheck source=pinned-runtime.sh
source "$script_dir/pinned-runtime.sh"

user_home="${HOME:?HOME is required}"
runtime_root="${1:-$user_home/.miaos-dev-runtime}"
runtime_root="${runtime_root%/}"

# Never install over the installed Mia's programs.
case "$runtime_root" in
  ""|"$user_home"|"$user_home/.miaos"|"$user_home/Library/Application Support/Mia"*)
    echo "Refusing to install the dev runtime at $runtime_root." >&2
    exit 2 ;;
esac

for command in git python3 node npm; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

mkdir -p "$runtime_root/downloads"
echo "[1/2] Installing Hermes ${HERMES_TAG} (${HERMES_VERSION}) into $runtime_root/hermes"
provision_hermes "$runtime_root/hermes" "$runtime_root/downloads" "$script_dir"
echo "[2/2] Installing Ghost CLI ${GHOST_VERSION} into $runtime_root/ghost-cli"
provision_ghost "$runtime_root/ghost-cli" "$runtime_root/downloads"
python3 - "$runtime_root/dev-runtime.json" "$HERMES_COMMIT" "$GHOST_COMMIT" <<'PY'
import datetime, json, sys
path, hermes, ghost = sys.argv[1:4]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"hermesCommit": hermes, "ghostCommit": ghost,
               "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}, handle, indent=1)
    handle.write("\n")
PY
echo "Dev runtime ready: $runtime_root"
