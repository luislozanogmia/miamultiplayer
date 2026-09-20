#!/usr/bin/env bash
# Runs one or all of the platform packaging wrappers (bundle_build_mac.sh,
# bundle_build_win.sh, bundle_build_linux.sh), skipping any target that
# cannot be built from the current host, and prints a per-target
# success/skip/failure summary at the end.
#
# Usage: scripts/bundle_build.sh [mac|win|linux|all]   (default: all)
#
# From macOS this can build: mac (always, if this host is macOS), linux
# (cross-buildable — Electron Packager just unpacks prebuilt binaries — as
# long as dpkg-deb is on PATH), and win (never: package-win.cjs refuses to
# run unless process.platform === "win32", so it needs an actual Windows
# build host). See each bundle_build_<target>.sh for the full prerequisites,
# including the pinned runtime bundle env vars every target needs.
#
# Bash 3.2 (macOS's default /bin/bash) has no associative arrays, so target
# results are tracked with three plain variables instead of a map.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

target="${1:-all}"
[[ "$#" -le 1 ]] || { echo "Usage: $0 [mac|win|linux|all]" >&2; exit 2; }
case "$target" in
  mac|win|linux|all) ;;
  *)
    echo "Usage: $0 [mac|win|linux|all]" >&2
    exit 2
    ;;
esac

want_mac=0
want_win=0
want_linux=0
case "$target" in
  all) want_mac=1; want_win=1; want_linux=1 ;;
  mac) want_mac=1 ;;
  win) want_win=1 ;;
  linux) want_linux=1 ;;
esac

mac_status="not requested"
win_status="not requested"
linux_status="not requested"

run_target() {
  local name="$1"
  echo "==> $name"
  if bash "$script_dir/bundle_build_${name}.sh"; then
    echo "$name"
    return 0
  fi
  return 1
}

if [[ "$want_mac" == 1 ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if run_target mac; then mac_status="success"; else mac_status="failure"; fi
  else
    echo "==> mac: skipped (package-mac.cjs uses codesign/ditto/xcrun and only runs on macOS)"
    mac_status="skipped"
  fi
fi

if [[ "$want_win" == 1 ]]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if run_target win; then win_status="success"; else win_status="failure"; fi
      ;;
    *)
      echo "==> win: skipped (package-win.cjs requires process.platform === 'win32'; it cannot cross-build from this host)"
      win_status="skipped"
      ;;
  esac
fi

if [[ "$want_linux" == 1 ]]; then
  if command -v dpkg-deb >/dev/null 2>&1; then
    if run_target linux; then linux_status="success"; else linux_status="failure"; fi
  else
    echo "==> linux: skipped (dpkg-deb not found on PATH; install it to cross-build the .deb from this host)"
    linux_status="skipped"
  fi
fi

echo
echo "Bundle build summary:"
echo "  mac:   $mac_status"
echo "  win:   $win_status"
echo "  linux: $linux_status"

for status in "$mac_status" "$win_status" "$linux_status"; do
  if [[ "$status" == "failure" ]]; then
    exit 1
  fi
done
exit 0
