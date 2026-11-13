# Changelog

All notable changes to Mia are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) (`major.minor.patch`).

Entries under **Unreleased** ship with the next release and reach users
automatically through the in-app updater.

## [Unreleased]

## [0.3.9] — Unreleased

### Added
- Shared browser sessions can transcribe each participant's opted-in microphone locally and suggest tasks from the conversation. A suggestion shows its full request for review before it can ask that person's Mia to act.
- The browser can show two or four pages at once and supports camera, microphone, and screen sharing in pages.
- Connecting Google can request read-only access to the whole Drive; file changes still require a file picked or created through Mia.

### Changed
- A company bot asked by the person at this computer can use that person's Mia browser. Settings can use one set of instructions for Mia and all bots.

### Fixed
- Bot chats and settings work for a person's Solo bots while a company is open. Chat progress and follow-up messages stay visible, and a run that ends without a reply reports it.

## [0.3.8] — 2026-11-11

### Added
- People can add company bots to channels without an approval queue. Bot owners and workspace admins can publish updates for that company; copies in that company follow the latest version automatically. Solo and other companies keep their own versions.
- Connected apps can open their sign-in page in the system browser. Mia resumes the task after sign-in or key setup.
- Mia can show a folder or reveal a file in the system file manager. Bots are limited to their own working folders.

### Changed
- Idle browser tabs and Hermes sessions sleep to use less memory. Channels and direct messages show their latest message before they are opened.

### Fixed
- Company bot chats reconnect after a dropped connection, and completed replies clear the thinking indicator.
- Browser playback continues under dialogs, and stopped browser work clears its glow.

## [0.3.7] — 2026-11-10

### Added
- Company bot chats keep up to 100 recent messages and allow longer runs. Each company has a private 1:1 Mia chat.
- Chat accepts CSV, Office, text, image and other supported files through the composer or drag and drop. Thread replies use the full composer.
- Shared company bots can sync a reviewed working folder around each run. Concurrent edits keep both copies.
- Mia can propose an MCP app from its vendor address or package. The person reviews its connection details before accepting and supplies any key outside chat.
- Channel settings can change its name, description and picture. Browser links and text can be dropped into a prompt.

### Changed
- Bot delegation is off; Mia retains delegation. Browser tab groups keep new tabs outside groups unless the person puts them there.
- Reactions sit beside message bubbles, list markers appear in dark bubbles, and switching rooms closes the old thread panel.

### Fixed
- Shared-folder paths and conflict copies follow the Hub's file rules, avoid symlink escapes and stop a late download before a bot run.
- Proposed app logos allow public HTTPS images with bounded downloads and refuse private network addresses. MCP approval cards show the executable arguments and connection settings.
- MCP apps with similar long names no longer overwrite one another's Hermes server configuration.

## [0.3.6] — 2026-11-09

### Added
- The Bot marketplace opens over the app like Settings, with a shelf for Mia's bots, one for each company you're in, the bots you own, the copies you got, and your skills. Clicking a bot opens its full card: what it does, its instructions, its skills and automations. **Ask Mia** opens her chat with what you were looking at already named.
- Skills are folders, as in Codex, Claude and Hermes: SKILL.md says what the skill is and when to use it, and it can point to notes and scripts beside it. You edit a skill's files in the marketplace's Skills shelf. Bots are told where their skill folders are, and sharing a bot carries the files.
- Inbox Triage ships with two skills: Sort new messages and Draft a reply.
- Mia can read your skills and the marketplace, and propose creating or changing a skill, giving skills to a bot, or getting a marketplace bot. Each change is a card you accept.
- One right-click menu for bots and channels, in Solo and companies: pin, hide, share or mark as unread, then the chat's own actions, then the ones to be careful with. Hidden rows fold into a Hidden group.
- The docked video or page under the chat has a bar to drag it taller or shorter, and fits the space left.
- Downloaded company bots show an **Update** action when a newer approved version is available. You review and apply it; local chats stay in place.

### Changed
- Settings' Output choice is now **View**: Normal user (the default) or Power user. In Bot settings, a normal user ticks skills from a list; a power user sees them as folders whose files edit in place.
- Bot settings calls the brief **Instructions**.
- **Sign in with Chrome** shows on any ChatGPT tab, a bot's included, but never while a bot is driving that tab.

### Fixed
- An @-mention's name stays on the text line in chat messages.
- A page you load yourself on a tab a bot used earlier no longer shows the bot in control.
- On Mac, hidden browser tabs no longer take clicks meant for the tab in front.
- Bot approval shows the full contents of shared skill files. Copying a bot to another company requires reviewing each file before sharing it.

## [0.3.5] — 2026-11-08

### Changed
- The one-time bot files tidy-up now asks Mia to look first. Let Mia look opens her chat, where she sorts the files bots left in the Mia folder from the ones that look like yours and explains the plan. You can change it in plain words. The tidy-up starts only when you choose Go ahead and never deletes files.
- The tidy-up card shows Mia's own Motes.

## [0.3.4] — 2026-11-07

### Added
- On Mac, ChatGPT and its OpenAI sign-in page offer **Sign in with Chrome** for security-key and passkey sign-in. Mia uses a temporary Chrome profile and imports only that site's session after the person approves the handoff.
- Company chat gains more of Solo's bot controls, reactions, private bot chats and scheduled work. Browser tabs can stay with their group, dock beside chat, and save a page as a PDF.
- A one-time review lets people choose exactly which technical files Mia moves out of their Mia folder; hidden files inside a selected folder are listed too.

### Fixed
- Google sign-in completes when Mia is the Mac's default browser. Saved browser tabs and history remove credential-bearing query parameters, including older history on load.
- Large chats can switch models without an extra Hermes confirmation, and Mia Router chooses a model it actually offers.
- Background sign-in reads wait instead of showing a busy error. Mia keeps one Hermes server per data folder.
- Bot work remains visible and controllable during browser takeovers, long replies and workspace changes.
- Scheduled jobs cannot start the agent gateway if their safety setup fails; credential-bearing page addresses are cleaned before they enter chat notices or download records.

## [0.3.3] — 2026-11-06

### Fixed
- Bot browser work stays in the Solo or company workspace where the chat began, even when you switch workspaces during a run. Browser suggestions, tab groups, and download notices stay with their workspace.
- A company bot chat checks current company membership before it is created or started fresh.
- A finished bot or Mia run no longer keeps browser or Mia app access through its old session ID.
- Updated Electron and affected dependency versions with published security fixes.

## [0.3.2] — 2026-11-06

### Added
- In a company, clicking a company bot opens your private chat with it where the company's server supports bot chats; otherwise it opens a channel with the bot, as before.
- Company admins can copy a company bot to another company. Mia proposes a generalized copy and shows it beside the original for the admin to review, edit, and approve before sharing.
- New bots can be made inside a company, the same way as in Solo. Admins can remove a company bot from its sidebar row.
- History titles each chat from how it started and updates the title as it goes; chats can be deleted from History.
- A direct message or group can be closed, as in Slack: it leaves the sidebar until someone writes again or it is opened.
- A stuck automation shows what it needs under its title, with a Fix with Mia button that sends the problem to Mia.
- Emoji reactions on messages. GPT 6.1 is offered when signing in with ChatGPT.

### Changed
- The shared space is called a company everywhere you read it, and colleagues instead of teammates.
- A bot asked in a company channel works in that company's own folder on your computer, and can use Mia's browser there.
- A Solo bot you have shared with a company moves to a folded Hidden group in that company's My Bots, where it can be reactivated.
- Approval cards say in plain words what will happen, including connector actions, and one yes covers further edits to the same document in a reply.
- Bots' Motes show beside @mentions and on the line saying a bot joined a channel. Browse-together cards are green.
- Mia Router shows Setting you up while it starts, and Mia gives a slow computer more time to start.

### Fixed
- A custom bot color picked from the color panel is kept.
- Message times in an open chat no longer stay at "just now".
- Sidebar menus and the browser tips stay above the browser page; collapse buttons and browser controls stay in reach in a small window.
- The sidebar dot no longer blinks while someone types, and stays visible on hover; unread chats are bold.
- Signing up with a new email creates the account.
- A company that hits the server's request limit waits and opens again on its own.
## [0.3.1] — 2026-11-05

### Added
- After an interrupted close or crash, Mia shows a checklist of chats, bot replies, workflows, automations, and browser work that can be started again. Work that could repeat an action starts unchecked.
- Several Mia accounts can be used on one computer, with clearer account names during sign-in.
- Dictation works with the engine included in the desktop installers. Bots can read files attached to their messages.
- Recently closed browser tabs can be reopened, and a tab can be saved as an Artifact or app.

### Changed
- Browser work uses the bot chat's Ask before do setting and approval card. Approval for a consequential click applies once to the inspected button on the same page.
- Renaming a bot updates its open chat, earlier messages, and browser group. Claude conversations use the updated prompt cache; ChatGPT sign-in offers GPT-6 and GPT-6.1.
- Browser tab groups stack behind a count, and closing the active tab returns to the last used one.

### Fixed
- A second restart no longer loses interrupted work, and repeated opens do not duplicate the browser item.
- Native error diagnostics and recently closed tab storage no longer expose credential-bearing URLs. Signed image links are not passed to Claude as prompt text; attach the image instead.
- Browser clicks that submit or send are checked against the actual target, including selector clicks; old approval cards cannot authorize a new turn.

## [0.3.0] — Multiplayer

Version 0.2.22 was used for unpublished previews. The preceding public release
is 0.2.21.

### Added
- Shared tab groups: invite teammates into a browser session. Everyone opens
  pages with their own sign-ins, sees who is on each tab, and can follow a
  teammate or ask everyone to look at one tab. Joining and page navigation
  require the participant's approval.
- Team workflows in Automations, with assigned steps, approval cards, reports,
  files passed between steps, and a fresh approval before an interrupted step
  runs again. Each participant's step runs on their computer.
- Team files for channels, groups, and direct messages, with upload scanning,
  fingerprint checks, download, retry, and member or admin deletion controls.
- Team apps that can be reviewed, approved, installed, and run in a sandboxed
  pane. Publishing first shows the complete file list.
- Admin Center controls for team files, apps, browser sessions, and bot review.
- A Bots section in shared teams: use your own Solo bots privately inside a
  team. Your chats with them there stay in that team and never show in Solo.
- The @ menu in a team channel lists the whole team, and picking someone
  outside the channel invites them.
- Bot skills and longer instructions, including skill review before a shared
  bot or workflow runs. Mia can also carry out approved browser work.
- Private agents can be created, renamed, and deleted through the local API;
  their chat and sidebar entry are not enabled yet.
- Linux dev mode for the remote desktop display.

### Changed
- Sharing a bot into a team channel gives the team its own copy of the bot's
  instructions, which everyone in the team can see and use. The copy is no
  longer linked to your Solo bot; its skills, automations and memories stay
  with you.
- Team bot replies show which participant's Mia ran them and which provider
  answered.
- Initial setup is now called Models & Subscriptions.
- The Theme setting is hidden and Mia stays in the light theme; new installs
  answer in the concise output style.
- Shared-browser coordination uses Hub events, keeping tab and presence data
  out of channel chat messages. Older control messages are hidden in chat.

### Fixed
- The setup dialog opens without waiting for provider sign-in checks, and its
  button always reads Connect.
- Switching connections no longer reloads the app; the model selector updates
  and a notice confirms the change.
- Shared browser live previews require an explicit Join, and an already
  approved tab asks again when it navigates to a new page.
- Browser work asks for confirmation after reading a page and rejects a start
  if an assigned tab changes while the confirmation is open.
- App bundles reject sensitive files and stop if their contents change after
  the user reviews the file list.

### Known limitation
- Bots with terminal access can edit the shared local skill library. Use
  trusted skills until per-bot file isolation is available.

## [0.2.21] — 2026-10-26

Version 0.2.20 was used for unpublished previews. This is the first public
release of the changes below, with a higher version so preview installs can
receive an update.

### Added
- Shared teams (alpha): channels, groups and DMs with teammates through the
  Mia Hub, teammate search, and shared bots that execute on the requesting or
  approving participant's computer using that participant's credentials.
- Artifacts page: pages, documents and live apps in your Mia folder; share
  any of them into a chat, or pick one from the chat's (+) menu.

### Changed
- Deleting a file from Artifacts moves it to the Trash.

### Fixed
- Use a white conversation header in light mode, including the browser side
  pane, while keeping the dark-mode background.
- Keep the connection dialog inside the window on macOS.
- Open Claude sign-in in the default browser, so saved passwords and passkeys
  work there; paste the code Claude shows to finish.
- Remove credential-bearing URL paths from automatically attached browser
  context, including reset/invitation links, encoded tokens and JWT-like
  segments, while preserving ordinary Google file identifiers and GitHub
  commit references.
- Require sign-in in packaged builds even if development no-auth settings are
  present; omit sensitive URLs from desktop logs and shared browser context;
  bind pasted Claude sign-in codes to the active attempt.

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
