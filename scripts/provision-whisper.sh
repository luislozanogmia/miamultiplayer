#!/usr/bin/env bash
# Puts the pinned whisper.cpp engine in a folder, ready for the packagers
# (WHISPER_BUNDLE_DIR) or dev mode. Linux verifies the official build against
# scripts/whisper-release.env; macOS compiles the pinned commit, which needs
# git, cmake and the Xcode command line tools on the build machine. Windows is
# handled by scripts/install-runtimes-win.ps1.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=whisper-release.env
source "$script_dir/whisper-release.env"

destination="${1:?Usage: provision-whisper.sh <install folder>}"
destination="${destination%/}"
mkdir -p "$(dirname "$destination")"
# CMake embeds its source path in the macOS binary. A destination beneath a
# person's home would disclose that private path in the public installer and
# fail the bundle privacy audit. Build from a neutral temporary directory;
# the verified output still moves to the requested destination afterward.
if [[ "$(uname -s)" == "Darwin" ]]; then
  staging="$(mktemp -d /tmp/mia-whisper-build.XXXXXX)"
else
  staging="$(mktemp -d "${destination}.staging.XXXXXX")"
fi
trap 'rm -rf -- "$staging"' EXIT
mkdir "$staging/out"

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    url="https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD_TAG}/whisper-bin-ubuntu-x64.tar.gz"
    curl --fail --location --silent --show-error "$url" --output "$staging/whisper.tar.gz"
    [[ "$(sha256_of "$staging/whisper.tar.gz")" == "$WHISPER_LINUX_X64_ARCHIVE_SHA256" ]] || {
      echo "whisper.cpp archive does not match the pinned checksum." >&2
      exit 1
    }
    tar -xzf "$staging/whisper.tar.gz" -C "$staging"
    built="$staging/whisper-bin-ubuntu-x64"
    [[ "$(sha256_of "$built/whisper-cli")" == "$WHISPER_LINUX_X64_SHA256" ]] || {
      echo "whisper-cli does not match the pinned checksum." >&2
      exit 1
    }
    # Only the engine, as plain files under the names it loads them by.
    cp "$built/whisper-cli" "$built/LICENSE" "$built"/libggml-cpu-*.so "$staging/out/"
    for library in libwhisper.so.1 libggml.so.0 libggml-base.so.0; do
      cp -L "$built/$library" "$staging/out/$library"
    done
    ;;
  Darwin-arm64)
    command -v cmake >/dev/null 2>&1 || { echo "Building whisper.cpp needs cmake on this machine." >&2; exit 1; }
    git init --quiet "$staging/source"
    git -C "$staging/source" remote add origin "$WHISPER_SOURCE_URL"
    GIT_TERMINAL_PROMPT=0 git -C "$staging/source" fetch --quiet --depth 1 origin "$WHISPER_COMMIT"
    git -C "$staging/source" checkout --quiet --detach FETCH_HEAD
    [[ "$(git -C "$staging/source" rev-parse HEAD)" == "$WHISPER_COMMIT" ]] || { echo "whisper.cpp commit mismatch." >&2; exit 1; }
    # One self-contained binary: static libraries, Metal shaders embedded, no OpenMP.
    cmake -S "$staging/source" -B "$staging/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
      -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
    cmake --build "$staging/build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)"
    cp "$staging/build/bin/whisper-cli" "$staging/source/LICENSE" "$staging/out/"
    ;;
  *)
    echo "No pinned whisper.cpp build for $(uname -s) $(uname -m)." >&2
    exit 1
    ;;
esac

[[ "$(sha256_of "$staging/out/LICENSE")" == "$WHISPER_LICENSE_SHA256" ]] || {
  echo "whisper.cpp LICENSE does not match the pinned checksum." >&2
  exit 1
}
chmod 755 "$staging/out/whisper-cli"
rm -rf -- "$destination"
mv "$staging/out" "$destination"
echo "whisper.cpp ${WHISPER_VERSION} installed in $destination"
