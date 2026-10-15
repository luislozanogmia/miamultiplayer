# Linux desktop package

The Linux candidate is an amd64 `.deb`, not an AppImage or a Linux OTA feed.
Version comes from `macos/package.json`; the next candidate is 0.2.17.
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

The Electron `desktopName` must match the installed `miaos.desktop` entry.
Do not create a per-user `mia.desktop` alias to make package acceptance pass.
Test Google with `xdg-open` present and absent: the failure state must offer a
copyable sign-in link, retry, email, and cancellation. Restore the opener
before normal acceptance. Keep sign-in URLs out of logs, screenshots shared
publicly, and persistent app data; they belong only to the active sign-in UI.
A failed browser launch retains its short-lived callback challenge so the
manual link can complete; cancel, retry, email sign-in, and expiry invalidate it.

### 0.2.17 review-candidate acceptance

The QA-only package built from `0bc353c` was installed on Ubuntu 24.04.4
with a fresh user, encrypted desktop keyring and Chromium sandbox enabled.
Manual computer-use checks confirmed Google launches Chrome without a
`mia.desktop` alias; waiting exposes recovery controls; Copy confirms success;
a missing `xdg-open` gives a recoverable error; retry and Cancel remain usable.
The opener was restored afterward. First-run Chrome terms were dismissed.
Full Google account completion, real email-code verification, native macOS and
Windows checks, and OTA remain unverified for this candidate.

Screenshots are cropped from the running installed app to exclude the private
sign-in URL: [opener recovery](images/linux-signin-opener-recovery.png) and
[Copy confirmation](images/linux-signin-copy-confirmed.png).

### Claude 5.5 catalog candidate

The model update was packaged from `51f5691` and installed over the earlier
QA candidate, preserving the signed-in desktop profile. Package SHA256:
`5772349521e5c27c972892efc231627c0ba59bf87e622e1c53f0be6e1b1c790b`.
Claude Code 2.1.300 was installed from Anthropic's official installer, without
importing credentials from another profile.

Computer-use checks in the installed app verified the picker offers Sonnet
5.5, Haiku 5.5 and Opus 5.5 and omits Haiku 4.5, Opus 5 and Opus 4.8.
Switching an existing Mia conversation across all three 5.5 models produced
the requested QA replies. Stored native response metadata identifies
`claude-haiku-5-5`, `claude-opus-5-5` and `claude-sonnet-5-5` respectively.
This is real account inference through Mia, not direct runtime invocation.

The focused model/schedule suite passed 89 tests with one optional runtime
probe skipped on the host; that probe passed separately against the actual
pinned runtime. Five affected HTTP model/harness checks also passed.
Independent review found and resolved an empty-inventory fallback issue:
a Claude account that reports no offered models no longer receives the
curated catalog as a substitute.

A new local QA bot with no automation or external-action role also returned
`QA_BOT_55_OK` through Haiku 5.5; its separate runtime profile's stored native
response identifies `claude-haiku-5-5`. Returning to the earlier Mia chat
preserved its Sonnet 5.5 Medium choice. Screenshots:
[model picker](images/claude-55-picker.png),
[Mia replies](images/claude-55-replies.png), and
[bot reply](images/claude-55-bot-reply.png).
