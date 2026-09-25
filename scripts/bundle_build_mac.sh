#!/usr/bin/env bash
# Builds the macOS Mia.app + DMG bundle via macos/scripts/package-mac.cjs
# (npm run package:mac). Ensures macos/ has its dependencies installed, runs
# the packager, and prints where the output landed.
#
# package-mac.cjs itself (not this wrapper) additionally requires:
#   - a clean git checkout (no staged, unstaged, or untracked changes) —
#     it refuses to package a dirty tree;
#   - HERMES_BUNDLE_DIR, GHOST_BUNDLE_DIR, GWS_BUNDLE_DIR, and
#     HERMES_PYTHON_RUNTIME_DIR pointing at the pinned runtime bundles
#     (scripts/install-local-mac.sh shows how those are provisioned and
#     which env vars it exports before calling `npm run package:mac`);
#   - codesign/ditto/xcrun, which only exist on macOS — this wrapper checks
#     the host up front so a non-mac run fails fast instead of partway
#     through packaging;
#   - MIAOS_MAC_SIGN_IDENTITY, MIAOS_MAC_NOTARY_PROFILE, and
#     MIAOS_MAC_PROVISIONING_PROFILE, set together, to produce a signed and
#     notarized release build. Signed releases also require the public
#     MIA_GOOGLE_OAUTH_CLIENT_ID and MIA_GOOGLE_OAUTH_CLIENT_SECRET injected by the controlled release shell.
#     Leave all release variables unset for an ad-hoc local build.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
engineering_root="$(cd -- "$script_dir/.." && pwd)"
macos_root="$engineering_root/macos"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging (package-mac.cjs) shells out to codesign/ditto/xcrun and only runs on macOS." >&2
  exit 1
fi

if [[ ! -d "$macos_root/node_modules" ]]; then
  echo "Installing macos/ dependencies…"
  (cd "$macos_root" && npm install --no-audit --no-fund)
fi

echo "Packaging the macOS app (npm run package:mac)…"
(cd "$macos_root" && npm run package:mac)

version="$(node -p "require('$macos_root/package.json').version")"
dist_root="$macos_root/dist"
echo
echo "macOS bundle output:"
echo "  App: $dist_root/Mia-darwin-arm64/Mia.app"
echo "  DMG: $dist_root/Mia-${version}-arm64.dmg"
echo "  ZIP: $dist_root/Mia-${version}-arm64-mac.zip (electron-updater feed, with latest-mac.yml)"
