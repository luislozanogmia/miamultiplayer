# Windows installer and OTA

`npm run package:win` retains the portable ZIP and builds an electron-builder
NSIS installer from the same packaged app. `windows-installer.cjs` owns NSIS
configuration; `package-win.cjs` owns the application and runtime payload.

## Artifact contract

- `Mia-Setup-<version>-x64.exe`: per-user, one-click installer.
- Installer `.sha256` and `.blockmap` companions.
- `latest.yml`: Windows update feed, generated from the installer bytes.
- `Mia-<version>-win-x64.zip` and checksum: portable distribution.

Publish all Windows artifacts together only after release approval. Never
modify or sign an installer after generating its hashes/feed. No version bump
or publication is performed by the packaging command. An OTA test requires a
higher candidate version than the installed app.

## Install and update behavior

The installer uses stable app ID `com.miamultiplayer.mia`, installs per user
without requesting elevation, and preserves app data on uninstall. It must not
remove the user's bots, credentials, chats or workspace. The app registers its
`miamultiplayer` protocol at runtime, including for portable distribution.

electron-updater reads `resources/app-update.yml` and the GitHub `latest.yml`.
The existing readiness UI calls `quitAndInstall(true, true)` on Windows, which
requests silent replacement and relaunch through the maintained NSIS updater.
macOS keeps its existing behavior. Portable ZIPs are not an OTA install format;
use the installer for supported installation and update testing.

## Signing and release gates

Luis has approved unsigned Windows distribution and OTA as an explicit release
exception. The current artifact is still a test candidate until source review,
fresh release packaging, security review, publication and actual OTA acceptance
are complete. `signWindowsApp` does not sign the payload.

Windows may show Unknown publisher or SmartScreen warnings. HTTPS and the
updater's manifest hash checks remain in use, but they are not certificate-based
publisher verification. Do not describe this release as signed, and do not
disable signature verification globally to support it. This exception applies
only to Windows; macOS signing and notarization requirements are unchanged.

For a future signed release, enroll Luis as an individual publisher with a
provider supporting his location in Mexico, then wire
Authenticode signing for app, installer and uninstaller into packaging. Configure
the updater's expected publisher name and verify signatures before publication.
Private signing credentials must remain in a protected store, never the repo.
Signing does not guarantee an immediate absence of SmartScreen warnings.

CI builds Google-disconnected test artifacts. Official Google registration is
approval-bound release configuration from 1Password, not a public workflow
variable. Do not claim CI artifacts are an official connected release.

See [installer-acceptance.md](installer-acceptance.md) for observed test results.
Native install/uninstall retention, higher-version OTA replacement/relaunch,
and real installed-app sign-in/chat are independent gates; unit tests do not
replace them. No production feed should be changed for acceptance testing.
