#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=hermes-release.env
source "$script_dir/hermes-release.env"
# shellcheck source=ghost-release.env
source "$script_dir/ghost-release.env"

user_home="${HOME:?HOME is required}"
miaos_home="${MIAOS_HOME:-$user_home/.miaos}"
local_bin="${XDG_BIN_HOME:-$user_home/.local/bin}"
local_share="${XDG_DATA_HOME:-$user_home/.local/share}"
hermes_home="$local_share/miaos/hermes"
mia_runtime_bin="$local_share/miaos/bin"
applications_dir="$local_share/applications"
linux_icon_dir="$local_share/icons/hicolor/512x512/apps"
app_install_dir="$local_share/miaos/app"

if [[ "$user_home" == "/" || "$miaos_home" != "$user_home/.miaos" ]]; then
  echo "This installer only writes to Mia-owned state for the current user." >&2
  exit 1
fi

if [[ -e "$user_home/.hermes" ]]; then
  echo "Preserving existing Hermes installation: $user_home/.hermes"
fi

for command in git npm python3; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

mkdir -p "$miaos_home/downloads" "$local_bin" "$mia_runtime_bin" "$applications_dir" "$linux_icon_dir"
extract_root="$miaos_home/downloads/hermes-source"
ghost_extract_root="$miaos_home/downloads/ghost-cli-source"
ghost_install_dir="$miaos_home/ghost-cli"

echo "[1/7] Downloading pinned Hermes ${HERMES_TAG} (${HERMES_VERSION}) without authentication"
rm -rf -- "$extract_root"
git init --quiet "$extract_root"
git -C "$extract_root" remote add origin "$HERMES_SOURCE_URL"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
  git -c credential.helper= -c core.askPass=/bin/false -C "$extract_root" \
    fetch --quiet --depth 1 origin "$HERMES_COMMIT"
git -C "$extract_root" checkout --quiet --detach FETCH_HEAD
actual_commit="$(git -C "$extract_root" rev-parse HEAD)"
[[ "$actual_commit" == "$HERMES_COMMIT" ]] || {
  echo "Hermes commit mismatch: expected $HERMES_COMMIT, got $actual_commit" >&2
  exit 1
}
git -C "$extract_root" apply "$script_dir/hermes-noninteractive.patch"
rm -rf -- "$extract_root/.git"

echo "[2/7] Installing the pinned Hermes runtime with no provider setup or seeded skills"
hermes_install_dir="$hermes_home/hermes-agent"
rm -rf -- "$hermes_install_dir"
mkdir -p "$hermes_home"
mv "$extract_root" "$hermes_install_dir"
printf '%s\n' "$actual_commit" > "$hermes_install_dir/.miaos-source-commit"

# The verified public source archive is the bundle. Run only local installer
# stages, deliberately omitting its repository, provider-setup, and gateway
# stages so neither Git nor an account credential is used to obtain Hermes.
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
# Hermes otherwise downloads these optional dependencies while building the
# first Mia agent, adding roughly nine seconds before the first prompt reaches
# the selected model. Keep the tested versions inside the shipped venv.
"$hermes_home/bin/uv" pip install --quiet --python "$hermes_install_dir/venv/bin/python" \
  'boto3==1.42.89' \
  'edge-tts==7.2.7'
printf '%s\n' "miaos-bundle" > "$hermes_install_dir/.install_method"
cat > "$mia_runtime_bin/hermes" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME="$hermes_home"
exec "$hermes_install_dir/venv/bin/python" "$hermes_install_dir/hermes" "\$@"
EOF
chmod 755 "$mia_runtime_bin/hermes"

echo "[3/7] Downloading pinned Ghost CLI ${GHOST_VERSION} without authentication"
rm -rf -- "$ghost_extract_root"
git init --quiet "$ghost_extract_root"
git -C "$ghost_extract_root" remote add origin "$GHOST_SOURCE_URL"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
  git -c credential.helper= -c core.askPass=/bin/false -C "$ghost_extract_root" \
    fetch --quiet --depth 1 origin "$GHOST_COMMIT"
git -C "$ghost_extract_root" checkout --quiet --detach FETCH_HEAD
actual_ghost_commit="$(git -C "$ghost_extract_root" rev-parse HEAD)"
[[ "$actual_ghost_commit" == "$GHOST_COMMIT" ]] || {
  echo "Ghost CLI commit mismatch: expected $GHOST_COMMIT, got $actual_ghost_commit" >&2
  exit 1
}
[[ -f "$ghost_extract_root/in_app_browser_transport.py" ]] || {
  echo "Pinned Ghost CLI does not contain the in-app browser connector." >&2
  exit 1
}
rm -rf -- "$ghost_extract_root/.git"
rm -rf -- "$ghost_install_dir"
mv "$ghost_extract_root" "$ghost_install_dir"
printf '%s\n' "$actual_ghost_commit" > "$ghost_install_dir/.miaos-source-commit"

echo "[4/7] Verifying the installation has no persisted provider credentials"
for credential_file in "$hermes_home/auth.json" "$hermes_home/profiles/miaos-agent-runtime/.env" "$hermes_home/profiles/miaos-bot-worker/.env"; do
  [[ ! -e "$credential_file" ]] ||
    [[ "$credential_file" == *.env && ! -s "$credential_file" ]] ||
    [[ "$credential_file" == *.env && -z "$(grep -Ev '^[[:space:]]*(#|$)' "$credential_file")" ]] || {
      echo "Unexpected configured credential file: $credential_file" >&2
      exit 1
    }
done
if [[ -f "$hermes_home/.env" ]] && grep -Eiq '^[A-Za-z_][A-Za-z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID)=.+' "$hermes_home/.env"; then
  echo "Hermes .env unexpectedly contains configured values." >&2
  exit 1
fi

echo "[5/7] Installing Mia backend and desktop dependencies"
rm -rf -- "$app_install_dir"
mkdir -p "$app_install_dir"
while IFS= read -r -d '' relative; do
  case "$relative" in
    */.gitignore|*/.env.example|*.test.js|*.test.cjs|*.test.mjs|backend/test.sh|backend/smoke-stub-hermes.mjs|backend/verify-platform-map-coverage.js|macos/dist/*) continue ;;
  esac
  (cd "$repo_root" && cp -a --parents "$relative" "$app_install_dir")
done < <(git -C "$repo_root" ls-files -z -- backend frontend macos modules)
npm --prefix "$app_install_dir/backend" ci --omit=dev --no-audit --no-fund
npm --prefix "$app_install_dir/macos" ci --no-audit --no-fund

echo "[6/7] Installing Mia and Ghost launchers"

cat > "$local_bin/ghost-cli" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export GHOST_CLI_HOME="$ghost_install_dir"
export GHOST_MIA_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_MIA_TOKEN_FILE="$miaos_home/ghost-bridge.token"
export GHOST_IN_APP_BROWSER_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="$miaos_home/ghost-bridge.token"
exec python3 "$app_install_dir/backend/miaos-ghost-cli.py" "\$@"
EOF
chmod 755 "$local_bin/ghost-cli"

cat > "$local_bin/miaos-bot" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export MIAOS_BASE_URL="\${MIAOS_BASE_URL:-http://127.0.0.1:4871}"
exec node "$app_install_dir/modules/bot-creation/scripts/miaos-bot.js" "\$@"
EOF
chmod 755 "$local_bin/miaos-bot"

cat > "$local_bin/miaos-local" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME="$hermes_home"
export HERMES_BIN="$mia_runtime_bin/hermes"
export HERMES_PYTHON="$hermes_install_dir/venv/bin/python"
export PATH="$local_bin:\$PATH"
export DB_PATH="$miaos_home/mia-os.db"
export DATA_DIR="$miaos_home/data"
export STATIC_DIR="$app_install_dir/frontend"
export PORT="\${PORT:-4884}"
export MIAOS_NO_AUTH="\${MIAOS_NO_AUTH:-1}"
export MIAOS_LOCAL_PROFILE="\${MIAOS_LOCAL_PROFILE:-1}"
export INSTANCE_DOMAINS="\${INSTANCE_DOMAINS:-localhost}"
export GH_CONFIG_DIR="$miaos_home/provider-isolation/github"
export MIAOS_HERMES_PROCESS_HOME="$miaos_home/provider-isolation/home"
export GHOST_CLI_HOME="$ghost_install_dir"
export GHOST_IN_APP_BROWSER_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="$miaos_home/ghost-bridge.token"
mkdir -p "\$GH_CONFIG_DIR" "\$MIAOS_HERMES_PROCESS_HOME"
cd "$app_install_dir/backend"
exec node server.js
EOF
chmod 755 "$local_bin/miaos-local"

cat > "$local_bin/miaos-desktop" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME="$hermes_home"
export HERMES_BIN="$mia_runtime_bin/hermes"
export MIAOS_HERMES_BIN="$mia_runtime_bin/hermes"
export HERMES_PYTHON="$hermes_install_dir/venv/bin/python"
export PATH="$local_bin:\$PATH"
export MIAOS_DB_PATH="$miaos_home/mia-os.db"
export MIAOS_LOCAL_PROFILE="\${MIAOS_LOCAL_PROFILE:-1}"
export MIAOS_DESKTOP_NO_AUTH="\${MIAOS_DESKTOP_NO_AUTH:-1}"
export INSTANCE_DOMAINS="\${INSTANCE_DOMAINS:-localhost}"
export GH_CONFIG_DIR="$miaos_home/provider-isolation/github"
export MIAOS_HERMES_PROCESS_HOME="$miaos_home/provider-isolation/home"
export GHOST_CLI_HOME="$ghost_install_dir"
export GHOST_MIA_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_MIA_TOKEN_FILE="$miaos_home/ghost-bridge.token"
export GHOST_IN_APP_BROWSER_SOCKET="$miaos_home/ghost-bridge.sock"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="$miaos_home/ghost-bridge.token"
mkdir -p "\$GH_CONFIG_DIR" "\$MIAOS_HERMES_PROCESS_HOME"
cd "$app_install_dir/macos"
exec "$app_install_dir/macos/node_modules/.bin/electron" . --user-data-dir="$miaos_home/electron"
EOF
chmod 755 "$local_bin/miaos-desktop"

install -m 644 "$app_install_dir/macos/assets/mia-512-linux.png" "$linux_icon_dir/miaos.png"
cat > "$applications_dir/miaos.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Mia
Comment=Local AI workspace
Exec=$local_bin/miaos-desktop
Icon=miaos
Terminal=false
Categories=Office;Utility;
StartupWMClass=miaos
EOF
chmod 644 "$applications_dir/miaos.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$applications_dir" >/dev/null 2>&1 || true

cat > "$miaos_home/install-manifest.json" <<EOF
{"miaosInstall":"$app_install_dir","hermesVersion":"$HERMES_VERSION","hermesTag":"$HERMES_TAG","hermesCommit":"$HERMES_COMMIT","ghostVersion":"$GHOST_VERSION","ghostCommit":"$GHOST_COMMIT","providerCredentials":"none"}
EOF

echo "[7/7] Installation complete"
echo "Start Mia desktop with: $local_bin/miaos-desktop"
echo "Start the localhost server only with: $local_bin/miaos-local"
echo "Hermes: $HERMES_COMMIT (no provider credentials configured)"
echo "Ghost CLI: $GHOST_COMMIT (Mia in-app browser connector only)"
