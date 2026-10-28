# Shared by install-local-mac.sh (the release install) and
# provision-dev-runtime.sh (dev mode's own runtime): download the pinned
# Hermes and Ghost CLI sources and install them under a given root. Source it
# after hermes-release.env and ghost-release.env.

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

# Hermes with Mia's patches at <hermes_home>/hermes-agent, its own venv, no
# provider setup and no skills.
provision_hermes() {
  local hermes_home="$1" downloads="$2" patches="$3"
  local extract_root="$downloads/hermes-source"
  pinned_clone "$HERMES_SOURCE_URL" "$HERMES_COMMIT" "$extract_root"
  local patch
  for patch in noninteractive profile-picker model-switch-history gpt6-tiers mia-browser-worker-scheduler process-secrets; do
    (cd "$extract_root" && git apply "$patches/hermes-$patch.patch")
  done
  local install_dir="$hermes_home/hermes-agent"
  rm -rf -- "$install_dir"
  mkdir -p "$hermes_home"
  mv "$extract_root" "$install_dir"
  printf '%s\n' "$HERMES_COMMIT" > "$install_dir/.miaos-source-commit"
  local stage
  for stage in venv python-deps node-deps config complete; do
    GIT_TERMINAL_PROMPT=0 HERMES_HOME="$hermes_home" \
      bash "$install_dir/scripts/install.sh" \
        --stage "$stage" \
        --skip-setup \
        --skip-browser \
        --skip-computer-use \
        --no-skills \
        --non-interactive \
        --dir "$install_dir"
  done
  "$hermes_home/bin/uv" pip install --quiet --python "$install_dir/venv/bin/python" \
    'boto3==1.42.89' \
    'edge-tts==7.2.7'
  printf '%s\n' "miaos-bundle" > "$install_dir/.install_method"
}

provision_ghost() {
  local install_dir="$1" downloads="$2"
  local extract_root="$downloads/ghost-cli-source"
  pinned_clone "$GHOST_SOURCE_URL" "$GHOST_COMMIT" "$extract_root"
  [[ -f "$extract_root/in_app_browser_transport.py" ]] || {
    echo "Pinned Ghost CLI does not contain the in-app browser connector." >&2
    exit 1
  }
  rm -rf -- "$install_dir"
  mv "$extract_root" "$install_dir"
  printf '%s\n' "$GHOST_COMMIT" > "$install_dir/.miaos-source-commit"
}
