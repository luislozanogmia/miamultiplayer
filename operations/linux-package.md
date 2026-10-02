# Linux desktop package

The Linux candidate is an amd64 `.deb`, not an AppImage or a Linux OTA feed.
Version comes from `macos/package.json`; this packaging repair keeps 0.2.14.
The pinned GNU Google Workspace CLI requires glibc 2.39: target Ubuntu 24.04
or newer. Older distributions are not supported by this candidate.

Build on Linux from a clean, committed checkout with Node 22 and npm 11.19.1
(the release lockfile was validated with this npm version). Provide the pinned
Hermes, Ghost, and Python inputs through `HERMES_BUNDLE_DIR`,
`GHOST_BUNDLE_DIR`, and `HERMES_PYTHON_RUNTIME_DIR`.

Also set `GWS_BUNDLE_DIR` to an extracted official Linux x86_64 GNU gws
release containing `gws` and `LICENSE`. Verify the downloaded archive against
`GWS_LINUX_X64_ARCHIVE_SHA256` in `scripts/gws-release.env` before extraction.
The packager separately verifies the executable against
`GWS_LINUX_X64_SHA256`, stages its license, and records its checksum in the SBOM.
Prefer a disk-backed `TMPDIR` with several GB free over a small `/tmp` tmpfs.

Official builds inject the Desktop OAuth registration in-process through the
approved 1Password release wrapper. Do not copy account tokens, provider
profiles, or existing app data into the build. The installed Desktop client
registration is deliberately readable by normal users: it is shipped native
client metadata, not a user's access/refresh token. Forks supply their own
registration or ship Google disconnected.

Run `scripts/bundle_build_linux.sh`. Outputs are
`macos/dist/Mia_<version>_amd64.deb`, `.sha256`, and `.spdx.json`.
The packager retains the credential, runtime-state, and private-path audits;
do not disable those gates to obtain an artifact.

Before publication, install the actual `.deb` on the target desktop, check the
registered launcher/icon/protocol, and launch normally as a non-root user.
`chrome-sandbox` must be root-owned mode 4755; do not add `--no-sandbox`.
Use an isolated profile so existing user data stays untouched. Verify real
production Clerk sign-in, a genuine chat reply, and persistence after restart.
The desktop keyring must be unlocked; never reset a user's keyring or use
unencrypted credential storage to get a test passing.
Record these separately from unit tests and package creation. PR review,
merge, publication approval, and release-asset upload remain separate gates.
