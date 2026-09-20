#!/usr/bin/env bash
# Builds the Windows Mia zip bundle via macos/scripts/package-win.cjs
# (npm run package:win). Ensures macos/ has its dependencies installed, runs
# the packager, and prints where the output landed.
#
# package-win.cjs hard-refuses to run unless process.platform === "win32":
# Windows packaging needs a Windows build host (a future Authenticode signing
# step will need signtool, and the runtime layout it stages is Windows-only).
# This wrapper checks that up front so a non-Windows run fails fast instead
# of doing partial work first; run it from Git Bash / MSYS2 / WSL's bash on
# an actual Windows machine.
#
# package-win.cjs also requires the same pinned runtime bundle env vars as
# package-mac.cjs (HERMES_BUNDLE_DIR, GHOST_BUNDLE_DIR, GWS_BUNDLE_DIR,
# HERMES_PYTHON_RUNTIME_DIR — see scripts/install-local-mac.sh) plus a clean
# git checkout.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
engineering_root="$(cd -- "$script_dir/.." && pwd)"
macos_root="$engineering_root/macos"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    echo "Windows packaging (package-win.cjs) checks process.platform === 'win32' and refuses to run anywhere else." >&2
    echo "Run this from a Windows build host (Git Bash, MSYS2, or WSL's bash targeting a Windows npm)." >&2
    exit 1
    ;;
esac

if [[ ! -d "$macos_root/node_modules" ]]; then
  echo "Installing macos/ dependencies…"
  (cd "$macos_root" && npm install --no-audit --no-fund)
fi

echo "Packaging the Windows app (npm run package:win)…"
(cd "$macos_root" && npm run package:win)

version="$(node -p "require('$macos_root/package.json').version")"
dist_root="$macos_root/dist"
echo
echo "Windows bundle output:"
echo "  ZIP: $dist_root/Mia-${version}-win-x64.zip"
echo "  (plus .sha256 and .runtime.json alongside it)"
