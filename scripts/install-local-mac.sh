#!/usr/bin/env bash
# macOS port of install-local.sh: provisions the pinned Hermes runtime and
# Ghost CLI into ~/.hermes and ~/.miaos, builds the Electron bundle, and
# installs /Applications/Mia.app. BSD-tool compatible (no GNU cp --parents).
# Re-runs cleanly after scripts/clean_slate_mac.sh --apply.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=hermes-release.env
source "$script_dir/hermes-release.env"
# shellcheck source=ghost-release.env
source "$script_dir/ghost-release.env"

user_home="${HOME:?HOME is required}"
miaos_home="$user_home/.miaos"
hermes_home="$miaos_home/hermes"
local_bin="$user_home/.local/bin"
macos_root="$(cd -- "$repo_root/macos" && pwd)"
app_bundle_name="Mia.app"
packaged_app="$macos_root/dist/Mia-darwin-arm64/$app_bundle_name"
installed_app="/Applications/Mia.app"
resources="$packaged_app/Contents/Resources"

if [[ "$#" -ne 0 ]]; then
  echo "Release packaging always provisions fresh pinned runtimes; runtime reuse is not supported." >&2
  exit 2
fi

if [[ -e "$user_home/.hermes" ]]; then
  echo "Preserving existing Hermes installation: $user_home/.hermes"
fi

for command in git npm python3 node rsync; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

mkdir -p "$miaos_home/downloads" "$local_bin"

pinned_clone() {
  local url="$1" commit="$2" destination="$3"
  rm -rf -- "$destination"
  git init --quiet "$destination"
  git -C "$destination" remote add origin "$url"
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
    git -c credential.helper= -c core.askPass=/bin/false -C "$destination" \
      fetch --quiet --depth 1 origin "$commit"
  git -C "$destination" checkout --quiet --detach FETCH_HEAD
  local actual
  actual="$(git -C "$destination" rev-parse HEAD)"
  [[ "$actual" == "$commit" ]] || { echo "Commit mismatch in $destination: expected $commit, got $actual" >&2; exit 1; }
  rm -rf -- "$destination/.git"
}

echo "[1/8] Downloading pinned Hermes ${HERMES_TAG} (${HERMES_VERSION})"
  extract_root="$miaos_home/downloads/hermes-source"
  pinned_clone "$HERMES_SOURCE_URL" "$HERMES_COMMIT" "$extract_root"
  (cd "$extract_root" && git apply "$script_dir/hermes-noninteractive.patch")

  echo "[2/8] Installing the pinned Hermes runtime (no provider setup, no skills)"
  hermes_install_dir="$hermes_home/hermes-agent"
  rm -rf -- "$hermes_install_dir"
  mkdir -p "$hermes_home"
  mv "$extract_root" "$hermes_install_dir"
  printf '%s\n' "$HERMES_COMMIT" > "$hermes_install_dir/.miaos-source-commit"
  for stage in venv python-deps node-deps config complete; do
    GIT_TERMINAL_PROMPT=0 HERMES_HOME="$hermes_home" \
      bash "$hermes_install_dir/scripts/install.sh" \
        --stage "$stage" \
        --skip-setup \
        --skip-browser \
        --skip-computer-use \
        --no-skills \
        --non-interactive \
        --dir "$hermes_install_dir"
  done
  "$hermes_home/bin/uv" pip install --quiet --python "$hermes_install_dir/venv/bin/python" \
    'boto3==1.42.89' \
    'edge-tts==7.2.7'
  printf '%s\n' "miaos-bundle" > "$hermes_install_dir/.install_method"

  echo "[3/8] Downloading pinned Ghost CLI ${GHOST_VERSION}"
  ghost_extract_root="$miaos_home/downloads/ghost-cli-source"
  ghost_install_dir="$miaos_home/ghost-cli"
  pinned_clone "$GHOST_SOURCE_URL" "$GHOST_COMMIT" "$ghost_extract_root"
  [[ -f "$ghost_extract_root/in_app_browser_transport.py" ]] || {
    echo "Pinned Ghost CLI does not contain the in-app browser connector." >&2
    exit 1
  }
  rm -rf -- "$ghost_install_dir"
  mv "$ghost_extract_root" "$ghost_install_dir"
  printf '%s\n' "$GHOST_COMMIT" > "$ghost_install_dir/.miaos-source-commit"
echo "[4/8] Verifying the installation has no persisted provider credentials"
for credential_file in "$hermes_home/auth.json" "$hermes_home/profiles/miaos-agent-runtime/.env" "$hermes_home/profiles/miaos-bot-worker/.env"; do
  [[ ! -e "$credential_file" ]] ||
    [[ "$credential_file" == *.env && ! -s "$credential_file" ]] ||
    [[ "$credential_file" == *.env && -z "$(grep -Ev '^[[:space:]]*(#|$)' "$credential_file")" ]] || {
      echo "Unexpected configured credential file: $credential_file" >&2
      exit 1
    }
done

echo "[5/8] Packaging the Electron shell"
# package-mac.cjs bundles only the runtimes provisioned by steps 1-3. Do not
# honor caller-supplied bundle roots in release packaging: those directories
# could contain state from a different or previously configured installation.
python_bin_home="$(awk -F' = ' '$1 == "home" { print $2 }' "$hermes_install_dir/venv/pyvenv.cfg")"
[[ -n "$python_bin_home" ]] || { echo "Cannot determine Python runtime from venv/pyvenv.cfg" >&2; exit 1; }
# Resolve to the physical directory: uv keeps a minor-version symlink
# (cpython-3.11 -> cpython-3.11.x) and the packager rejects bundle
# symlinks that escape their source root.
HERMES_PYTHON_RUNTIME_DIR="$(cd -P -- "${python_bin_home%/bin}" && pwd)"
export HERMES_BUNDLE_DIR="$hermes_install_dir"
export GHOST_BUNDLE_DIR="$ghost_install_dir"
export HERMES_PYTHON_RUNTIME_DIR
(cd "$macos_root" && npm ci --no-audit --no-fund && npm run package:mac)
[[ -d "$packaged_app" ]] || { echo "Packaged app missing: $packaged_app" >&2; exit 1; }

echo "[6/8] Verifying the packaged app is complete"
# package-mac.cjs already stages backend/frontend/modules and the pinned
# runtimes into Resources and rebuilds better-sqlite3 for Electron's ABI,
# all BEFORE code signing. Never modify the bundle after packaging: it
# invalidates the signature and a system-node rebuild breaks the ABI.
for required in \
  "$resources/backend/server.js" \
  "$resources/backend/node_modules/better-sqlite3/package.json" \
  "$resources/frontend/index.html" \
  "$resources/modules" \
  "$resources/runtime/bin/hermes"; do
  [[ -e "$required" ]] || { echo "Packaged app is incomplete: $required" >&2; exit 1; }
done

echo "[7/8] Installing $installed_app"
osascript -e 'quit app "Mia"' >/dev/null 2>&1 || true
pkill -9 -f "Mia.app/Contents/MacOS" >/dev/null 2>&1 || true
# The Electron shell spawns the backend detached; killing the shell alone
# leaves an orphan node holding the Mia ports.
pkill -9 -f "Resources/backend/server.js" >/dev/null 2>&1 || true
sleep 1
rm -rf -- "$installed_app"
ditto "$packaged_app" "$installed_app"

# Same launcher the Linux installer writes: without it, `ghost-cli` is not on
# PATH and callers fall back to the checkout's own script, which wants a
# .venv this bundle never provisions. The adapter only exposes the in-app
# browser bridge commands.
cat > "$local_bin/ghost-cli" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export GHOST_CLI_HOME="$miaos_home/ghost-cli"
export GHOST_MIA_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_MIA_TOKEN_FILE="$miaos_home/ghost-bridge.token"
export GHOST_IN_APP_BROWSER_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="$miaos_home/ghost-bridge.token"
exec python3 "$installed_app/Contents/Resources/backend/miaos-ghost-cli.py" "\$@"
EOF
chmod 755 "$local_bin/ghost-cli"

echo "[8/8] Verifying the installed backend boots with the bundled runtime"
# Run server.js exactly the way the shell does: the app's own Electron binary
# as Node (ELECTRON_RUN_AS_NODE), the bundled runtime, and a throwaway state
# dir — the installed app must not depend on ~/.hermes or a system node.
bundle_runtime="$installed_app/Contents/Resources/runtime"
electron_node="$installed_app/Contents/MacOS/Mia"
verify_port=4897
verify_state="$(mktemp -d "${TMPDIR:-/tmp}/miaos-verify-state.XXXXXX")"
verify_log="$(mktemp "${TMPDIR:-/tmp}/miaos-verify.XXXXXX")"
(
  cd "$installed_app/Contents/Resources/backend"
  ELECTRON_RUN_AS_NODE=1 \
  HERMES_HOME="$verify_state/hermes" HERMES_BIN="$bundle_runtime/bin/hermes" \
  MIAOS_HERMES_BIN="$bundle_runtime/bin/hermes" \
  HERMES_PYTHON="$bundle_runtime/python/bin/python3.11" \
  DB_PATH="$verify_state/mia-os.db" DATA_DIR="$verify_state/data" \
  GHOST_CLI_HOME="$bundle_runtime/ghost-cli" \
  PORT="$verify_port" MIAOS_NO_AUTH=1 STATIC_DIR=../frontend \
  "$electron_node" server.js > "$verify_log" 2>&1 &
  echo $! > "$verify_log.pid"
)
verify_ok=0
for _ in $(seq 1 40); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$verify_port/api/instance")" == "200" ]]; then
    verify_ok=1
    break
  fi
  sleep 0.5
done
kill "$(cat "$verify_log.pid")" >/dev/null 2>&1 || true
if [[ "$verify_ok" != 1 ]]; then
  echo "Installed backend did not become ready; last output:" >&2
  tail -20 "$verify_log" >&2
  exit 1
fi
if grep -q "HERMES_BIN" "$verify_log"; then
  echo "Backend still reports a Hermes configuration problem:" >&2
  grep "HERMES" "$verify_log" >&2
  exit 1
fi
rm -f "$verify_log" "$verify_log.pid"
rm -rf -- "$verify_state"

cat > "$miaos_home/install-manifest.json" <<EOF
{"miaosInstall":"$installed_app","hermesVersion":"$HERMES_VERSION","hermesTag":"$HERMES_TAG","hermesCommit":"$HERMES_COMMIT","ghostVersion":"$GHOST_VERSION","ghostCommit":"$GHOST_COMMIT","providerCredentials":"none"}
EOF

echo "Installation complete. Launch with: open $installed_app"
echo "Hermes: $HERMES_COMMIT (no provider credentials configured)"
echo "Ghost CLI: $GHOST_COMMIT"
