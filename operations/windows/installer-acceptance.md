# Windows installer and OTA acceptance

Base: v0.2.12 / 56343fb. Target: main via reviewed PR; version bump and publication are separate release steps.

## Approved release scope (supersedes historical signing gates below)

Luis explicitly approved unsigned Windows distribution and working OTA. Signing
is deferred, not passed: Unknown publisher/SmartScreen warnings and absence of
certificate-based publisher verification are accepted. macOS signing rules are
unchanged. Delivery still requires reviewed source, a fresh versioned candidate,
security review, published installer/feed, and actual check/download/install/
relaunch with existing user data preserved. Manual installer replacement is not
proof of OTA delivery.

## Current result

- Passed on RTX: corrected installer fresh install and subsequent in-place
  replacement using `/S --updated --force-run`, both scheduler exit code 0.
- Passed after replacement: installed version 0.2.12, shell/startup-page hashes
  match candidate, and all four branded icon representations match. Interactive
  desktop capture confirms automatic relaunch into the signed-in workspace,
  with existing conversation, bot and automation still visible.
- Passed: 74 local regression tests and three native long-path tests (update,
  ordinary uninstall and locked-file rollback). User reported working app/chat
  before replacement; a fresh post-replacement chat send remains user acceptance.
- Still unverified: download-to-install OTA through a versioned feed; publisher
  signing; full release provenance from a clean merged commit. Candidate remains
  unsigned, uncommitted and unpublished. GitHub v0.2.12 has no Windows feed.
- Current test installer: `D:\mia-v0.2.12-prep\installer-longpath\Mia-Setup-0.2.12-x64.exe`,
  SHA256 `449fb043f66f9adf76778d9a47ee2eb5f079c72769a60a83934fb2e132ed17c7`.

The sections below retain the chronological investigation, including superseded
artifacts and failed intermediate checks; they are not the current delivery state.

| Criterion | Environment | Starting evidence | Expected result |
| --- | --- | --- | --- |
| Installer artifact | Native Windows | Failing: packager only writes ZIP | Versioned NSIS EXE plus latest.yml with matching filename, size and SHA512 |
| Install and uninstall | Windows disposable target | Unknown | Per-user installation without elevation; user data survives uninstall |
| Update install | Windows disposable target | Unknown | Silent replacement accepts updater arguments and relaunches only when requested |
| Readiness action | Automated regression | Failing: quitAndInstall uses defaults | Windows uses silent installation and relaunch; macOS behavior unchanged |
| CI artifact contract | Workflow inspection | Failing: uploads ZIP only | Installer, update manifest, blockmap and checksum uploaded as CI artifacts |
| End-to-end OTA UI | Windows desktop | Unverified | Candidate feed downloads, prompts and installs; no production release mutation |
| Main window startup | RTX interactive Windows desktop | Failing: process exists without visible window | Fresh and returning-user launches show usable sign-in/app UI; no indefinite hidden startup |
| Windows branding | Installed EXE, shortcut and installer | Failing: Electron default icon | Existing Mia dots/tile icon appears in executable, installer and shortcuts |

Keep production publication and signing identity enrollment out of this implementation.

## Implementation evidence

- Local automated: 13/13 targeted packaging, installer configuration and readiness
  tests pass. The Windows restart regression fails against the base readiness
  module (no arguments), and passes with silent/relaunch arguments enabled.
- Static: independent review found no concrete correctness defects; diff check
  and redacted gitleaks scans of changed code passed.
- Native Windows: NSIS packaging smoke uses the previously prepared v0.2.12
  payload, not a fresh release build from the uncommitted candidate. This does
  not establish the changed readiness behavior inside a packaged app.
- Unverified: actual per-user install, uninstall data retention, higher-version
  OTA replacement/relaunch and manual Windows UI acceptance. Signing is pending
  publisher enrollment. Nothing uploaded or published.

## RTX startup investigation

- The initial NSIS artifact was produced and its EXE version, SHA256,
  `latest.yml` SHA512/size and blockmap were checked on Windows.
- User installed 0.2.12 but reported no window. Lifecycle instrumentation in a
  disposable candidate confirmed trusted renderer-ready IPC and a window-show
  event. An interactive desktop capture showed Mia behind a Windows Firewall
  permission dialog and console; remote `MainWindowHandle=0` was not proof of
  a missing window.
- Desktop backend launch previously inherited a wildcard bind when Clerk was
  enabled and omitted `windowsHide`. It now explicitly uses `127.0.0.1` and
  hides the child console. Native `Get-NetTCPConnection` verifies 4871 bound to
  `127.0.0.1` on the updated candidate. Two regression tests fail on base and
  pass after the change; 19 focused tests plus 51 main-process tests pass.
- The old 0.2.8 portable copy and 0.2.12 installed files were archived on RTX,
  not erased. The stale uninstall entry was backed up and removed. Database
  and encrypted native-auth file hashes were unchanged by initial cleanup.
- Windows icons now reuse the exact PNG representations from Mia's ICNS.
  Executable and NSIS paths both consume the generated ICO.
- The updated RTX candidate reuses the provisioned 0.2.12 payload with current
  shell files and icon; it is not a clean merged-SHA release artifact. Signing,
  fresh release provenance, installed UI and full OTA remain release gates.
- Fixed installer SHA256:
  `1b3560c8133d032182f2ee3ae2cc1a95445b41f463574023ebe56d1c84041463`
  (312,408,860 bytes); Windows manifest SHA512/size and blockmap checked.
- Native installed-file verification confirms version 0.2.12, exact candidate
  `main.cjs`/`update-readiness.cjs` hashes, and all four branded PNG icon
  representations embedded in installed `Mia.exe`. This is file verification,
  not a claim that installer completion or installed UI acceptance passed.

## Startup follow-up

- The first corrected NSIS installer subsequently completed with exit code 0.
- Cold startup also copied the bundled runtime synchronously before creating
  a window. The shell now shows a sandboxed preparation page first and awaits
  asynchronous, verified runtime copying. Preparation errors retain the fallback
  and initialize desktop services so Retry does not leave a partial app.
- Local integrated regression suite: 73 tests passed, including async-copy
  yielding, preservation of the old runtime until verification, startup ordering,
  and recovery initialization. Tracked diff secret scan and whitespace check pass.
- A diagnostic replacement of the installed shell reached the Mia sign-in UI
  on the interactive RTX desktop, with the Mia icon visible in the title bar and
  taskbar. The old firewall dialog still obscures interaction; user dismissal and
  manual acceptance remain pending. This shell replacement is not evidence for
  the final installer, which is being rebuilt separately in `installer-final`.
- The earlier `installer-fixed` checksum above does not include the new async
  preparation page. Do not distribute it as the final startup fix.
- Final test installer built successfully at
  `D:\mia-v0.2.12-prep\installer-final\Mia-Setup-0.2.12-x64.exe`:
  312,409,347 bytes; SHA256
  `b73c49949368800c1af43634fae3d3748e161bd096a2338da61ab68b38aed847`.
  Its manifest size/SHA512, SHA256 sidecar and blockmap passed verification.
  Native Authenticode status is `NotSigned`; packaging log text mentioning
  signtool does not establish a signature. Installation of this exact final
  artifact remains unverified; the current installed shell was replaced for
  diagnosis rather than installed by this artifact.
- Independent follow-up review verified the preparation recovery correction
  with no further concrete issue; four focused startup checks passed.
- After user dismissal, a fresh interactive capture confirms the firewall
  dialog is gone and the branded Mia window remains open. Other desktop
  windows obscure its content; sign-in and chat have not been confirmed.
- User subsequently reported the app works, with an update-check error.
  Native log inspection identifies missing `latest.yml`; GitHub v0.2.12 assets
  contain only macOS artifacts. Windows feed publication is not implemented
  by a local build and remains an explicitly authorized release action.
  Final-installer in-place installation was started after that confirmation;
  completion and relaunch must be checked before claiming this artifact passed.

## Replacement failure and long-path regression

- Replacement did not complete: the old installed NSIS uninstaller returned
  error 2. The installer waited at a failure dialog, not an active copy operation.
- Installed payload includes 267-character paths. Exclusive-read scan of all
  47,226 installed files found no failures. A separate disposable fixture using
  the exact cached NSIS compiler reproduced a failing 270-character `Rename`
  (exit 2); the same operation with extended-path prefixes passed (exit 0).
- Candidate `windows-uninstaller.nsh` retains the pinned upstream atomic
  move/rollback logic with extended paths for traversal, creation, movement,
  rollback and deletion. A regression check detects divergence from those
  pinned functions. Native update/uninstall/rollback fixtures are still pending.
- The new hook cannot repair an already-installed old uninstaller. Recovery of
  that test installation and a genuine corrected-installer-to-corrected-installer
  replacement test remain necessary. Do not distribute `installer-final` above:
  its uninstaller predates this correction.
- Native tests with the exact cached compiler passed update removal (342-char
  path), ordinary uninstall (344 chars), and deliberate locked-file rollback
  (344 chars; expected exit 2, all three original contents intact). Reusable
  harness is `macos/scripts/test-windows-uninstaller.ps1` and runs after Windows
  packaging in CI. No long-path policy change was made.
- The failed test installation was moved to the recoverable sibling directory
  `C:\Users\drshannon\AppData\Local\Programs\mia-retired-longpath-test`.
  Its uninstall registration was exported before removal; database and saved
  native-session hashes were unchanged. A corrected `installer-longpath`
  artifact is building; its real replacement test is still pending.
- Full packaging initially caught early include expansion before LogicLib was
  defined. Functions now expand through the supported `customHeader` hook;
  the reusable native harness mirrors that include order. All three native
  cases passed again and full packaging completed.
- Corrected `installer-longpath/Mia-Setup-0.2.12-x64.exe`: 312,409,507 bytes,
  SHA256 `449fb043f66f9adf76778d9a47ee2eb5f079c72769a60a83934fb2e132ed17c7`.
  Manifest size/SHA512, checksum sidecar and blockmap verified. Actual clean
  installation is running; replacement and relaunch remain unverified.
- Corrected installer completed its fresh installation with scheduler result 0.
  The first startup-page verification mistakenly used POSIX separators in the
  Windows ASAR API. Archive listing confirms the page is present; candidate and
  installed ASAR SHA256 both equal
  `8b9bf8c77f0746ee58201a3aa0808e6fe8fbfad69c33df82b7721cbb97a838b8`.
  The verifier now uses platform-native path joining. This was a verifier error,
  not a missing packaged file; replacement testing resumes after that check.
