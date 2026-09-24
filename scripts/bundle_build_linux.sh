#!/usr/bin/env bash
# Builds the Linux Mia .deb bundle via macos/scripts/package-linux.cjs
# (npm run package:linux). Ensures macos/ has its dependencies installed,
# runs the packager, and prints where the output landed.
#
# Electron Packager can stage a linux/x64 Electron tree from any host (it
# just unpacks prebuilt Electron binaries — no compilation), so unlike
# Windows packaging this can cross-build from macOS. But the last step shells
# out to dpkg-deb to build the .deb archive, and that tool is Debian/Ubuntu
# specific. This wrapper checks for it up front so a host without it fails
# fast instead of only after packaging, staging the runtime, and rebuilding
# native modules. Install it first (e.g. `brew install dpkg` on macOS) or run
# this on a Debian/Ubuntu host.
#
# The Linux icon (assets/mia-512-linux.png) that package-linux.cjs copies in
# is already checked into the repo; `npm run build:linux-icon` only needs to
# be re-run if assets/mia-512.png changes.
#
# package-linux.cjs also requires the same pinned runtime bundle env vars as
# package-mac.cjs (HERMES_BUNDLE_DIR, GHOST_BUNDLE_DIR, HERMES_PYTHON_RUNTIME_DIR
# — see scripts/install-local-mac.sh) plus a clean git checkout.
# Official builds additionally set MIA_REQUIRE_GOOGLE_OAUTH=1 and inject the
# public MIA_GOOGLE_OAUTH_CLIENT_ID. Fork builds may omit both and ship Google
# disconnected until they supply their own Desktop OAuth client ID.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
engineering_root="$(cd -- "$script_dir/.." && pwd)"
macos_root="$engineering_root/macos"

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "package-linux.cjs shells out to dpkg-deb to build the .deb archive, and it is not on PATH." >&2
  echo "Install it first (e.g. 'brew install dpkg' on macOS) or run this on a Debian/Ubuntu host." >&2
  exit 1
fi

if [[ ! -d "$macos_root/node_modules" ]]; then
  echo "Installing macos/ dependencies…"
  (cd "$macos_root" && npm install --no-audit --no-fund)
fi

echo "Packaging the Linux app (npm run package:linux)…"
(cd "$macos_root" && npm run package:linux)

version="$(node -p "require('$macos_root/package.json').version")"
dist_root="$macos_root/dist"
echo
echo "Linux bundle output:"
echo "  Package: $dist_root/Mia_${version}_amd64.deb"
echo "  (plus .sha256 and .spdx.json alongside it)"
