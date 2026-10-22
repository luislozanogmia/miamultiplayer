# Changelog

All notable changes to Mia are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) (`major.minor.patch`).

Entries under **Unreleased** ship with the next release and reach users
automatically through the in-app updater.

## [Unreleased]

## [0.2.19] — 2026-10-19

### Added
- Let bots work in separate browser tab groups while the user and Mia keep
  their own conversations; show bot activity and return to a bot's tabs.
- Complete addresses from local browsing history, with matching suggestions,
  site icons and keyboard navigation.

### Changed
- Open Your bots from a left-pane icon at the start of the address row;
  remove the separate pink mote from the tab strip.
- Present the Downloads panel over a still of the current page.

### Fixed
- Start the Windows, macOS and Linux agent connection on an available local
  port when the default port is reserved by the operating system.
- Serialize provider connection saves and agent restarts; preserve saved keys
  on a failed startup and report when the connection is not ready.
- Enforce Mia-or-bot browser tab assignments for explicit targets and queued
  actions; keep a tab with its controller until pending page operations settle,
  including operations that outlast an API timeout.
- Restore the packaged Windows Python interpreter so connected tools can load
  their native dependencies.
- Keep Google broker credentials out of agent-readable profile files and
  process launch environments; separate tool execution from connection management.
- Run connected Google operations inside the desktop broker without temporary
  OAuth credential files; discard stale results after account changes.
- Preserve explicitly typed HTTPS when completing an address from history.
- Discard dismissed or outdated page captures, and preserve typed text when
  delayed history responses arrive or Escape removes a completion.
- Keep later chat choices selected when a previous browser chat opens late.
- Reject unresolved browser actors, confirm potentially unsafe downloads,
  and wait for runtime cancellation acknowledgement before releasing a tab.
- Expose Google tools directly to Mia and bots on each connected chat turn;
  refresh account/grant capabilities after connection changes and prevent
  resumed or steered turns from inheriting an older connection.
- Request only the five supported Google scopes; remove unused Contacts access.

### Notes
- Windows packages remain unsigned; macOS packages must be signed and notarized.

## [0.2.18] — 2026-10-16

### Added
- Let users hide/show Mia beside the browser and resize its pane; remember
  pane visibility and width on the device.
- Show the connected Google account email in Connected apps.

### Changed
- Polish browser tabs and toolbar, simplify displayed addresses, and keep
  the idle status footer hidden. Align native macOS window controls with
  the app's top row.
- Let the message composer grow with the draft up to a third of the window.
- Keep model selection in chat instead of the bot profile editor.

### Fixed
- Bind Google connections to the current Mia identity. Reconnecting a different
  Google account refreshes Mia/bot session bindings and clears stale Drive
  selections; existing unverified connections require one explicit reconnect.
- Keep agent Google commands on Mia's app-scoped configuration instead of
  accidentally using a previous global Google account.
- Prevent later Mia/bot requests and setup helpers from inheriting a saved
  Claude profile after disconnect. Explicit reconnect and other connected
  providers remain available; independently scheduled work is unchanged.
- Check Claude Code compatibility when Mia starts; maintain older native
  installations, verify the resulting version, preserve newer versions, and
  offer an in-app retry when setup fails. Missing installations retain consent.

## [0.2.17] — 2026-10-15

### Fixed
- Register Linux browser sign-in with the installed desktop identity, so a
  freshly installed Mia can open Google and receive its callback.
- Detect a missing Linux browser opener and bound stalled handoffs; keep
  Google retry, email sign-in, and cancellation available while waiting.

### Added
- Add Haiku 5.5 to Claude subscription model choices alongside Sonnet 5.5,
  replacing Haiku 4.5. Keep Opus 5.5 and retire Opus 5/4.8; saved retired
  selections migrate to their 5.5 successors.
- Offer a short-lived, copyable Google sign-in link on Linux when the browser
  cannot open, and while waiting for browser sign-in to finish.

## [0.2.16] — 2026-10-13

### Fixed
- Save Mia Router keys noninteractively by supplying the credential label,
  avoiding an invisible optional-label prompt on Windows.
- Give Mia Router key saves a 60-second ceiling so slow cold starts on
  Windows (antivirus scanning, first run) no longer lose the freshly minted
  key and loop provisioning forever.

### Added
- Record a content-free Mia Router provisioning trail (step names, statuses,
  exit codes — never keys or conversation text) and let Send feedback attach
  it as an optional technical report, so connection failures on a user's
  machine are diagnosable from one email.

## [0.2.15] — 2026-10-03

### Added
- Show live agent activity and file status beside chat without exposing local
  file paths.
- Open chat attachments and approved Drive links in Mia's in-app browser.
- Keep Mia and bot files in a visible Documents/mia folder, choosing a new
  folder when an existing one belongs to something else.

### Fixed
- Recover from stale provider-key copies in Mia-managed Hermes profiles while
  preserving independent profiles and refusing unsafe credential-store updates.
- Explain when a Mia Router key moved to another computer and retain useful
  connection errors after a failed retry.
- Use the last selected model for automation and goal work outside a chat turn.
- Show a status message when a model takes too long to begin answering.
- Advance the onboarding tour reliably and report successful or failed file
  edits accurately.
- Stop the development backend and Hermes gateway when the app quits.
- Limit browser attachment authorization to the prepared file request and
  prevent unrelated browser pages from receiving Mia's session cookie.
- Include the pinned Google Workspace runtime and complete dependencies in
  the Linux package.

### Notes
- Windows packages remain unsigned; macOS packages are signed and notarized.

## [0.2.14] — 2026-09-29

### Added
- Start fresh conversations with Mia while keeping earlier chats in History.
- Use `/goal` and `/compact` in Mia and bot chats, with a command menu,
  a goal-status chip, and `/clear` to start a new conversation.
- Archive and restore bots while retaining their instructions and chat history.
- Remember a separate model choice for each bot and allow an automation to
  override its bot's model.
- Receive desktop notifications and unread indicators for replies and finished
  automation runs, with notification clicks opening the relevant chat.
- Add a new tab to an approved Google Sheet through the Google integration.
- Attach the open browser page's title and cleaned address as chat context.
- Open browser links in background tabs and drag tabs to reorder them.

### Fixed
- Keep queued messages separate from autonomous goal replies and deliver files
  produced by bot goal continuations.
- Keep bots usable if archiving fails and recover chat state after interrupted
  archive or restore operations.
- Avoid false completion notifications when checking running automations fails.
- Let Mia edit bot instruction files while retaining the bot instruction-file
  approval guard.
- Try Ghost before the separate browser fallback in profiles with the guard;
  merely mentioning Ghost or placing it in a skipped conditional does not count.
- Explain Mia Router connection failures and rejected credentials more clearly.
- Remove URL credentials, fragments, and sensitive query parameters from
  automatically attached browser context.
- Allow browser copy buttons and fullscreen video; leave fullscreen when
  switching to a new foreground tab.

### Notes
- `/subgoal` is not exposed in Mia's command menu or command-dispatch path.
- Windows remains unsigned; macOS releases remain signed and notarized.

## [0.2.13] — 2026-09-28

### Added
- Windows per-user installer and update-feed packaging for in-app updates.
- Mia's branded icon in the Windows executable and installer.

### Fixed
- Show a preparation window while packaged runtimes are copied instead of
  leaving the app running without a visible window.
- Keep the desktop backend on loopback and hide its Windows console.
- Handle long dependency paths during Windows installer replacement, retaining
  rollback on failure and preserving user data.

### Windows distribution
- Windows artifacts are unsigned: Windows may show Unknown publisher or
  SmartScreen warnings. Certificate-based publisher verification is not provided.
- macOS signing and notarization requirements are unchanged.

## [0.2.12] — 2026-09-25

### Changed
- Mia asks for a bot's purpose before drafting a vague request in chat. The
  editable review card creates the bot only when you choose **Accept**.
- Claude Code subscription setup now finds an existing CLI outside the app's
  shell PATH; if absent, Mia offers an explicit, opt-in native installation.

### Added
- Google Workspace connection with reusable, approved Drive-file attachments
  in chat, while keeping access limited to files the user chooses or creates.
- A Downloads list in Mia's browser, with persistent history and Show in Finder.
- Automatic update checks every four hours while Mia is running.
- Windows backend blockers B1/B2 fixed: the backend now launches the
  Hermes CLI through an argv launch vector (`MIAOS_HERMES_ARGV_JSON`,
  interpreter + script) published by the packaged Windows shell, instead
  of the `.cmd` shim Node refuses to spawn (CVE-2024-27980); and the
  Hermes/gws child-process environment allowlists pass the
  Windows-critical variables (`SYSTEMROOT`, `APPDATA`, `USERPROFILE`,
  `COMSPEC`, `TEMP`, …) plus the venv `PYTHONPATH` the shim used to set.

### Fixed
- Mia and bot chats select their intended Hermes profiles, so a missing
  profile constant cannot fail every response.
- Claude setup explains when the Claude Code CLI is missing instead of showing
  a raw terminal error.
- Google Desktop OAuth credentials are supplied by the controlled build flow,
  and local Google tokens stay in the installation's credential store.
- Browser downloads no longer produce a false page-load error.
- Adding an API-key provider (DeepSeek, OpenAI, Anthropic, …) hung and
  timed out on Windows: Hermes' hidden key prompt falls back to Python
  `getpass`, which on Windows reads the console rather than the stdin
  pipe the backend wrote the key into. The backend now passes the key
  via Hermes' documented `--api-key` flag on every platform.
- Google Meet (and other sites) showed "blocked" for mic/camera without
  ever prompting the user: the permission check handler returned `false`
  for undecided origins, so sites that pre-check via
  `navigator.permissions.query()` saw "denied" and never called
  `getUserMedia()`. Undecided HTTPS origins now return `true` from the
  check handler, letting the request handler's Allow/Block dialog fire.
- Screen sharing (`getDisplayMedia()`) silently failed in the embedded
  browser: Electron requires an explicit `setDisplayMediaRequestHandler`
  on the session. The browser now handles display-media requests by
  offering the first available screen/window source via `desktopCapturer`.

## [0.2.11] — 2026-09-23

### Changed
- ChatGPT and Grok sign-in now open in your own browser, where passkeys and
  saved logins work, instead of a window inside Mia.

## [0.2.8] — 2026-09-16

### Added
- Windows (x64) port groundwork: `package:win` packaging script, pinned
  Windows Python runtime + PowerShell provisioning scripts, a GitHub
  Actions workflow that builds the Windows zip on demand, a PowerShell
  port of the agent shell guard, and Windows support in the main process
  (venv/python path helpers, `.cmd`-safe spawning, menus, OTA updater
  gate). Backend Windows blockers are documented in
  `docs/windows/backend-audit.md`; the first shippable Windows build
  still requires those fixes plus the NSIS installer described in
  `docs/windows/ota-and-installer.md`.
- Microphone and camera now work in the embedded browser (Google Meet,
  video calls): sites asking for mic/camera get a native Allow/Block
  prompt, remembered per site. Packaged builds carry the required macOS
  entitlements and usage descriptions. All other permissions stay denied.

### Fixed
- Over-the-air updates never actually installed: electron-updater found
  new versions and showed the "downloading" dialog, but the download step
  requires an `app-update.yml` inside the app's resources (generated by
  electron-builder, which we don't use) and failed with ENOENT. The
  packagers now write it, and existing 0.2.6/0.2.7 installs must update
  once manually via DMG.
- Desktop file logging was silently dead on all platforms: the log
  redaction helper referenced `os.homedir()` without importing
  `node:os`, and the resulting error was swallowed by the logger's
  catch-all. Log files under the app's user-data directory now work
  again.
- "Sign in with Google" on third-party sites (e.g. x.com) no longer fails
  with Google's 400 "malformed request" page: the embedded browser's user
  agent revealed the Electron framework, which Google's OAuth endpoints
  reject. The browser now presents the Chrome build it actually runs.

## [0.2.7] — 2026-09-16

### Changed
- Hermes agents no longer stall on approval prompts: Mia-managed runtime
  profiles now set `approvals.mode: "off"`, so gated actions (protected
  file writes, guarded commands) run without a per-action prompt instead
  of timing out. Hermes's hardline approval floors still block
  destructive commands unconditionally. A future release will add an
  in-chat approval card (`approval.request` / `approval.respond`) for
  users who want manual gating back.

## [0.2.6] — 2026-09-16

### Added
- Over-the-air updates (macOS): the app checks GitHub Releases at
  launch via electron-updater, downloads new versions in the background,
  and offers "Restart and install / Later". `MIAOS_UPDATE_FEED_URL`
  remains as a generic-feed override for testing.
- `package:mac` now emits the update feed assets (`Mia-<v>-arm64-mac.zip`
  and `latest-mac.yml`) alongside the DMG; all three are uploaded to each
  GitHub release.

## [0.2.5] — 2026-09-16

### Fixed
- Bot fixes on top of 0.2.0 (first versioned patch release).

## [0.2.0] — 2026-09-14

### Added
- First public release: macOS (Apple Silicon) DMG and Linux (amd64) .deb,
  published on GitHub Releases and linked from miamultiplayer.com.
