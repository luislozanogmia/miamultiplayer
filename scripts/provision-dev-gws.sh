#!/usr/bin/env bash
# Installs the pinned Google Workspace CLI into dev mode's runtime on Linux,
# where nothing else provides it. Uses the static musl build, which also runs
# on distributions older than the release's GNU build needs (it requires glibc
# 2.39), and verifies it against the pins in scripts/gws-release.env.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gws-release.env
source "$script_dir/gws-release.env"

runtime_root="${1:?Usage: provision-dev-gws.sh <runtime root>}"
runtime_root="${runtime_root%/}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "The pinned Google Workspace CLI for dev mode is Linux x64 only." >&2
  exit 1
fi

archive_name="google-workspace-cli-x86_64-unknown-linux-musl.tar.gz"
url="https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/${archive_name}"
staging="$(mktemp -d "${runtime_root}/.gws-staging.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

curl --fail --location --silent --show-error "$url" --output "$staging/$archive_name"
actual_archive_sha="$(sha256sum "$staging/$archive_name" | awk '{print $1}')"
[[ "$actual_archive_sha" == "$GWS_LINUX_X64_MUSL_ARCHIVE_SHA256" ]] || {
  echo "Google Workspace CLI archive does not match the pinned ${GWS_VERSION} checksum." >&2
  exit 1
}
mkdir "$staging/gws"
tar -xzf "$staging/$archive_name" -C "$staging/gws"
actual_binary_sha="$(sha256sum "$staging/gws/gws" | awk '{print $1}')"
[[ "$actual_binary_sha" == "$GWS_LINUX_X64_MUSL_SHA256" ]] || {
  echo "Google Workspace CLI binary does not match the pinned ${GWS_VERSION} checksum." >&2
  exit 1
}
chmod 755 "$staging/gws/gws"
mv "$staging/gws" "$runtime_root/gws"
echo "Google Workspace CLI ${GWS_VERSION} installed in $runtime_root/gws"
