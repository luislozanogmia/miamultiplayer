# MiaOS Synthetic User Limits and Lifecycle Test Plan

Status: active acceptance run
Target: current macOS Electron app on `work/dr-shannon-4ac1b84`
Test data: isolated local profile and disposable database only; do not mutate Vultr or real user data
Timezone for reports: America/Monterrey

Current run baseline: commit `3411220`; macOS 26.6.2 (25G83); Electron 44.2.0; database `/tmp/miaos-synthetic-9sjDGl/mia-os.db`; Electron profile `/tmp/miaos-synthetic-9sjDGl/electron`; three enabled synthetic schedules.

## What success means

MiaOS can be opened, used heavily, closed, and reopened repeatedly without stale UI, duplicate processes, duplicate deliveries, data leakage, or growing resource use. Conversations, authorized memberships, browser state, and scheduled work restore predictably. Failures identify whether the problem belongs to the selected model provider, the network, or MiaOS, and always leave the user's message recoverable.

This document freezes the acceptance contract before execution. It does not claim that any scenario has passed. A failure may be fixed and retested, but it may not be removed or replaced with an easier check.

## Evidence rules

- `Automated`: repeatable regression test against the integrated repository.
- `Manual Electron`: the actual macOS Electron UI, not localhost and not a mocked browser.
- `Resource`: process, port, CPU, memory, file-descriptor, and log measurements for the complete MiaOS-owned process tree.
- `Static`: a source-code fact. Static evidence does not prove runtime behavior.
- Every UI defect requires both an automated regression and a manual Electron reproduction of the original flow.
- Screenshots or recordings must start before launch or interaction so startup flashes and delayed replacement data are visible.
- Failed evidence and generated artifacts are retained with the scenario ID.

## Starting acceptance results

| Criterion | Starting status | Current evidence | Exact expected result |
|---|---|---|---|
| One app/runtime instance | Passing (`Installed macOS app`) | Launching `/Applications/MiaOS.app` a second time retained the same single app PID and backend PID, with one listener. | A second launch focuses the existing window and creates no second Electron, backend, browser, Ghost, or Hermes runtime tree. |
| Clean close | Passing (`Automated` + `Installed macOS app`) | Red-window Close originally left the Electron/backend/Ghost tree alive. In the final installed build, clicking the actual red close button removed the app, backend, port 4870 listener, and Ghost process; reopening restored one clean tree. | Red-window Close and Quit both end the desktop session and leave no unintended MiaOS-owned processes, ports, media, or audio. |
| Restart resource stability | Passing (`Resource` + `Manual Electron`) | After fixing the rapid media-restore race, 20 complete Quit/reopen cycles held one app/backend/runtime per cycle. Checkpoint Electron RSS was 1151.5, 1164.0, 1140.2, and 1120.7 MiB at cycles 1/5/10/20; main-process descriptors were 222/222/222/223. Final Quit left no owned process, listener, or bridge socket. | After 20 restart cycles, process/port counts return to baseline and settled memory is not monotonically increasing. |
| Channel and membership persistence | Partial (`Manual Electron`) | `Synthetic QA Top 12-51` survived Quit/reopen exactly once with the same selected room and 2-user count. Full membership, deletion, and workspace-isolation scenarios remain open. | Only database-authorized users, agents, and bots return after restart; no closed/deleted test channel or stale member leaks into another workspace. |
| Automation recovery and delivery | Unknown | Not exercised in this plan yet. | Scheduled runs survive the appropriate restart boundary, execute once, and deliver once to the correct bot conversation. |
| Browser tab restoration | Passing (`Automated` + `Manual Electron`) | Three live native tabs (YouTube, Example Domain, IANA) survived Quit with Example Domain still selected. After IANA was closed, a second Quit/reopen restored only YouTube and Example Domain; the removed tab did not return. | Selected tab and all open tabs return after Close and Quit without reopening removed tabs. |
| YouTube playback-position restoration | Passing (`Automated` + `Manual Electron`) | Browser state records media time before close. A delayed-background retest held the restored timestamp after 12 seconds, released only on a real page click, and the pane-close retest held 1:34 while hidden for 10 seconds and for five more seconds after reopen. | Reopen the same video paused at the last known position, with no surprise autoplay or audio. |
| Window/browser-pane restoration | Failing (`Static`) | The main window is recreated at 1440×900, and browser-pane visibility/bounds are not in the native-browser state file. | Window bounds, selected workspace/chat, browser-pane state, and selected tab return predictably. |
| Provider-specific error attribution | Failing (`Static`) | Native dispatch failures currently render the generic text “I couldn’t complete that response. Please try again.” | The UI distinguishes provider authentication/quota/outage, local network, and MiaOS service failures without exposing secrets. |
| Startup/workspace transition | Partial (`Automated` + `Manual Electron`) | Development UI refresh now retains a native Loading layer until authoritative hydration; the focused regressions pass 35/35. Two live Solo ↔ Multiplayer Test switches rendered only resolved target-workspace data, with no login form, previous-workspace preview, or Bob leakage into Solo. Cold-start frame sampling and delayed/failing API cases remain open. | A loading mote covers the unresolved state; no login form, stale workspace, stale preview, or unauthorized name is visible for even one frame. |
| Activity/unread dot | Passing (`Automated` + `Live backend` + `Manual Electron`) | Active status is sourced from the latest Hermes execution ledger state. A completed Research run disappeared while a genuinely running Spreadsheet run remained; after both completed `/api/automations/active` returned `[]`, and the installed Electron sidebar showed no orange pulse. Unread remains the non-animated variant. | Pulse only during a live automation run, model response, or user typing; unread-only is one fixed orange dot; otherwise no dot. |

## Test environment and safety

- Use a disposable Electron user-data directory and a copy/new instance of the local database.
- Create only synthetic records prefixed `Synthetic QA` plus a run timestamp.
- Use only the real Alice and Bob identities already authorized by the chosen test fixture; never invent users in application code.
- Give file-producing bots write access only to a per-run temporary folder.
- Record the tested commit, build type, macOS version, Electron version, database path, user-data path, and start/end times.
- Capture a baseline before launch: relevant PIDs and parent/child trees, listening ports, CPU, RSS, file descriptors, Electron windows, and scheduled-job count.
- Do not treat a server restart or page refresh as evidence that the desktop app was restarted.

## Scenario checklist

### A. Launch, close, and restart lifecycle

- [x] **LIFE-001 — Cold launch:** Launch from no MiaOS-owned processes. Exactly one app window appears, one managed backend binds its intended port, and only the expected browser/GPU/runtime children start. Before launch, the isolated profile had no matching app/backend/runtime process, no 4971/9221 listener, and no Ghost socket. After launch, Computer Use exposed one `Mia - Solo` window; the owned tree had one Electron main, one GPU helper, one network helper, one audio helper, six renderers for the shell plus two restored web tabs/site isolation, one backend listener on 4971, one runtime listener on 9221, and one isolated Ghost socket.
- [x] **LIFE-002 — Second launch:** Launch the same build again. The existing window focuses; no second process tree, backend, browser bridge, profile writer, or tray/dock instance appears. The second `npm start` exited normally while the original window and its single backend on port 4971 remained the only owned process tree.
- [x] **LIFE-003 — Packaged-versus-development collision:** Start one build, then attempt the other against the same profile. The second process exits cleanly and never races the first for data or ports. Rebuilt the packaged arm64 app from the tested source, launched it against the live development instance's exact isolated profile, and observed exit code 0 in under one second. The original Electron main PID, backend PID, single 4971 listener, single 9221 listener, GPU tree, Ghost socket, and one Computer Use window remained unchanged; no packaged process survived.
- [x] **LIFE-004 — Red window Close:** Close the only window with the macOS red button. The initial shipping candidate incorrectly remained resident with its backend, renderer, and Ghost bridge. The corrected handler persists browser state, disposes auxiliary views, quits the application on macOS, and the live retest left no app/backend process, listener, lease, or Ghost socket.
- [x] **LIFE-005 — Command-Q Quit:** Quit while idle. Within 10 seconds there are no unintended Electron renderer/GPU trees, managed backend, Ghost bridge socket/listener, Hermes duplicate runtime, or playing media processes. Passed in the isolated Electron profile after fixing the interrupted async-close path; all owned processes, port 4971, and the Ghost socket were gone after 3 seconds.
- [x] **LIFE-006 — Immediate reopen:** Reopen one second after Quit. The isolated Electron app returned to the persisted Solo/Mia/browser state on one Electron main process, one backend PID, and one listener on port 4971; startup logs contained no stale-port, destroyed-object, duplicate-service, or profile-lock error.
- [x] **LIFE-007 — Repeated restart:** Twenty corrected-code Quit/reopen cycles each reached one app/backend/runtime and released port 4971 before the next launch. Manual checkpoints at 1/5/10/20 showed the same paused YouTube page at 2:04; RSS was 1151.5/1164.0/1140.2/1120.7 MiB and main descriptors 222/222/222/223. Final Quit left no owned process, port 4971/9221 listener, or Ghost socket.
- [x] **LIFE-008 — Rapid reopen after Close:** Under the approved shipping behavior, red-window Close is a full desktop-session quit. Reopen cycles therefore create one fresh app/backend tree from persisted state; the prior resident-process close/reopen behavior is superseded and is not a shipping requirement.
- [x] **LIFE-009 — Force-kill recovery:** Kill the Electron main process during idle, then reopen. The app recovers its last durable state, ignores partial state files, and reports no false in-progress work. The original run failed: SIGKILL orphaned backend/runtime PIDs 63216/63226, and relaunch tried a competing backend on 4972 before showing the fallback renderer. The fix writes a mode-0600 profile lease containing only the owned backend PID, loopback URL, and exact database path; relaunch validates that ownership, terminates the orphan's process group, and refuses to spawn if reclamation fails. The repeated live SIGKILL reclaimed backend/runtime PIDs 65308/65317, started one replacement backend PID 65567 on 4971 and one runtime on 9221, restored the full Solo/browser UI with YouTube paused at 2:47, and created no 4972/9222 listener or false activity state. Main-process regressions pass 14/14.
- [x] **LIFE-010 — Backend crash recovery:** Stop only the managed backend while Electron remains open. The initial run exposed two defects: an earlier failed Development refresh could leave a blank native loading view, and same-URL recovery restarted the service without clearing the stale renderer error. The fixed flow retires stale native loading views before a new navigation and, when the real renderer is already loaded, restarts the backend without replacing chat/browser state. Frame-by-frame Manual Electron evidence showed the existing Mia/browser UI remain visible behind “MiaOS service is unavailable. Your messages are safe.”; one click removed the banner within 0.9 seconds, preserved both browser tabs and the selected chat, and produced exactly one replacement backend PID 69248 on 4971 and one runtime PID 69254 on 9221, with no listener on 4972 and one Electron main tree. Focused recovery regressions pass 21/21.
- [ ] **LIFE-011 — Quit during model response:** Quit during a reply and reopen. The dispatch is either safely resumed/requeued once or clearly marked failed; it must not remain pulsing forever or duplicate the response.
- [ ] **LIFE-012 — Quit during automation:** Quit while a scheduled run is active and reopen. The run has one final state and at most one delivery; a claimed run is not lost or executed twice.
- [x] **LIFE-013 — Development “Restart server”:** Use the menu action once. One backend replacement occurs, the UI reconnects to the replacement, and no old server, old UI bundle, or duplicate runtime remains. Manual Electron evidence: backend PID 52657 was replaced once by PID 53301 on the same port 4971; the selected Research conversation and current delivery remained rendered with no duplicate server or stale bundle.
- [x] **LIFE-014 — Development refresh:** With the native YouTube browser and Mia chat split open, Computer Use captured four frames around Development > UI refresh. The intact pre-refresh split was replaced by the centered branded Loading mote, with all native browser views hidden; the refreshed split then returned within one second with the browser and chat in their original non-overlapping bounds, both tabs preserved, YouTube still at 2:47 and paused, and no login/stale-data flash.
- [ ] **LIFE-015 — Stale port/socket:** Seed an abandoned port or Ghost socket before launch. MiaOS either reclaims only its own stale resource or shows a precise blocker; it never starts a hidden second stack.

### B. Startup and workspace transitions

- [ ] **START-001 — First-frame capture:** Record from before cold launch through five seconds after ready at 250 ms intervals. Only the branded loading mote appears before resolved content—never the login form, previous user, previous workspace, or placeholder data.
- [x] **START-002 — Solo to Multiplayer Test:** Switch workspaces repeatedly. The loading mote covers any unresolved interval until membership and conversations for the target workspace are authoritative. Two live Electron returns to Multiplayer Test rendered the resolved Research conversation and Multiplayer Test sidebar directly, with no Solo/placeholder mixture.
- [x] **START-003 — Multiplayer Test to Solo:** Confirm Bob and Multiplayer Test-only channels never appear in Solo, including for a single frame and in autocomplete/search. Two live Electron switches rendered only Mia and Alice in Solo; frame captures contained no Bob, Multiplayer Test channel, or stale Multiplayer Test preview.
- [ ] **START-004 — Delayed API response:** Delay workspace/conversation APIs by three seconds. The app remains in loading state rather than rendering cached names/previews and replacing them later.
- [ ] **START-005 — Failed workspace load:** Return an error for the target workspace. Keep the previous workspace coherent or show an error state; never display a mixture of both workspaces.
- [ ] **START-006 — Restart on each workspace:** Quit from Solo, reopen, switch to Multiplayer Test, quit, and reopen again. The selected workspace and its active conversation restore without cross-workspace data.

### C. Channels, conversations, and membership

- [ ] **CHAN-001 — Create channel:** Create `Synthetic QA Channel A`; verify one database row, one sidebar row, correct creator, and only explicitly selected members.
- [ ] **CHAN-002 — Open/close panel:** Open and close the channel repeatedly. Closing the view does not delete or duplicate the conversation.
- [ ] **CHAN-003 — Archive/delete channel:** Use the supported destructive channel action. The channel disappears from normal lists after confirmation and does not return after refresh or restart.
- [ ] **CHAN-004 — Reopen persisted channel:** Quit while Channel A is selected and reopen. The same channel, messages, membership, and unread state return exactly once.
- [ ] **CHAN-005 — Many channels:** Create 25 synthetic channels, switch rapidly among them, then restart. Order, titles, previews, and active selection remain correct with no stale message flashes.
- [x] **CHAN-005A — New-channel placement (UX preference):** A newly created channel appears at the top of All conversations immediately and remains ordered by its creation/activity timestamp after restart until newer conversation activity supersedes it. `Synthetic QA Top 12-51` appeared first immediately, survived restart exactly once, and then correctly moved below conversations with newer automation deliveries.
- [ ] **CHAN-006 — Concurrent messages:** Send messages in three channels while another receives an agent response. Each event lands once in its originating conversation and previews update only there.
- [ ] **CHAN-007 — Authoritative membership:** Search and `@` autocomplete match database membership exactly. No hardcoded or historical user appears.
- [ ] **CHAN-008 — Private agent 1:1:** Alice ↔ Mia contains exactly Alice and Alice's private agent. It never gains bots, other agents, or Bob through automation delivery or restart repair.
- [ ] **CHAN-009 — Bot 1:1:** A bot conversation contains its owner and that bot only, unless a shared-channel membership was explicitly created.
- [ ] **CHAN-010 — Workspace isolation:** Bob is visible only where his database membership authorizes him; Solo contains no Bob row, search result, mention, count, or transient cached name.
- [ ] **CHAN-011 — Close while loading history:** Close/switch a conversation while older messages are loading. The late response cannot overwrite the newly active conversation.
- [ ] **CHAN-012 — Deleted member/session cache:** Remove a synthetic membership, refresh, restart twice, and search/mention again. No local cache resurrects it.

### D. Automations and bots

- [ ] **AUTO-001 — User-intent creation:** Ask Mia to have Bot A run a five-minute reminder. Bot A owns one durable schedule; Mia does not become the worker and no schedule is created without explicit recurring intent.
- [ ] **AUTO-002 — Several bots:** Create three bots with independent reminder, research, and file-update automations. Each schedule is attached to the intended bot and delivery conversation.
- [ ] **AUTO-003 — Parallel due time:** Make all three automations due together. They execute through the intended single runtime architecture without spawning duplicate Hermes stacks, blocking one another indefinitely, or crossing outputs.
- [ ] **AUTO-004 — Overlapping run:** Make one run last longer than its interval. Enforce the product policy—skip, queue, or coalesce—but never overlap the same job silently or deliver duplicates.
- [ ] **AUTO-005 — Edit automation:** Change name, task/prompt, schedule, and enabled state from the automation detail panel. Saved values round-trip from the database and drive the next run.
- [ ] **AUTO-006 — Cancel in bot chat:** Ask the owning bot to cancel its cron. The schedule becomes disabled, the bot confirms the real change, and no later tick runs.
- [ ] **AUTO-007 — Cancel through Mia:** Ask Mia to cancel a named bot automation. Authorization is checked, the correct bot/schedule changes once, and the reply reflects the persisted result.
- [ ] **AUTO-008 — Pause/resume:** Pause for two due periods, then resume. No paused delivery occurs and only future due times run after resume.
- [ ] **AUTO-009 — App closed at due time:** Quit Electron before a due time. The designated scheduler—not a duplicate orphan app stack—runs the job and stores one delivery, or the product explicitly reports that local automations pause while closed. Silent loss is a failure.
- [ ] **AUTO-010 — Restart during claim:** Restart after a run is claimed but before completion. Recovery produces one terminal run and one delivery.
- [ ] **AUTO-011 — Restart after completion:** Restart after execution but before/after UI refresh. Completed work is not mistaken for currently running work.
- [ ] **AUTO-012 — Running-now panel:** Show only unfinished cron sessions, labeled `<automation name> automation running`; clicking opens the conversation receiving that run's output.
- [ ] **AUTO-013 — Ordinary bot reply:** Message a bot without recurring intent. No automation is created and no “Running now” automation row appears merely because the bot is replying.
- [x] **AUTO-014 — Idle activity dot:** After every run reaches a terminal state, observe its sidebar row for 30 seconds. It must not pulse. A genuinely unread delivery may show one fixed orange dot. After the parallel research/spreadsheet runs disappeared from `/api/automations/active`, 30 seconds of Electron observation showed no `Active now` state; unread deliveries retained only one fixed dot, and opening Research cleared its dot.
- [x] **AUTO-015 — Live activity dot:** During an actual run, exactly one orange dot pulses for that conversation; it stops within one refresh interval of the terminal state. The real Electron sidebar exposed `Active now` only on the two conversations backed by live running session IDs; both activity states disappeared after the API returned no runs.
- [ ] **AUTO-016 — Count consistency:** With exactly one active run, every surface reports one active automation. With four configured but idle schedules, no surface reports four active jobs.
- [ ] **AUTO-017 — Failed run:** Force a tool/provider failure. The run reaches failed, delivers a concise failure once, stops pulsing, and remains inspectable.
- [ ] **AUTO-018 — File update:** Run a bot that updates an `.xlsx` file in its authorized temporary folder every five minutes. Each run preserves prior rows, appends once, and attaches/links the correct artifact without exposing host paths.
- [ ] **AUTO-019 — PDF research:** Run a bot that gathers permitted web sources and creates a PDF in its authorized temporary folder. Sources, artifact, and failure state remain associated with that run.
- [ ] **AUTO-020 — Cleanup:** Disable/delete every synthetic schedule and bot. After two restart cycles, there are no due jobs, active sessions, sidebar rows, temp writers, or synthetic delivery events outside the retained test evidence.

### E. Native in-app browser, Ghost, and YouTube

- [x] **BROW-001 — Basic persistence:** Open three tabs, select the middle tab, Quit, and reopen. Live Electron restored YouTube, Example Domain, and IANA exactly once, with Example Domain still selected and each URL unchanged.
- [x] **BROW-002 — Closed-tab persistence:** Close one tab, Quit, and reopen. IANA was closed before Quit; only YouTube and Example Domain returned and Example Domain remained selected.
- [ ] **BROW-003 — Session persistence:** Sign in to an approved test site, Quit, and reopen. The persistent browser session restores the allowed login without exposing credentials to chat or logs.
- [ ] **BROW-004 — Navigation history:** Navigate through three pages, Quit, reopen, and use Back/Forward. If history is part of the contract it works across restart; otherwise the UI does not falsely claim it was restored.
- [x] **BROW-005 — YouTube window Close:** Play a YouTube video, note the exact second, close the macOS window, wait, reopen from the dock, and compare URL, selected tab, playback time, play/pause state, and audio. Live Electron evidence: Big Buck Bunny was playing before Close; state persisted at 124.9 seconds; reopening produced one window on the same URL at 2:04 with the large Play control, muted audio, and the “Browser restored where you left off. Playback is paused.” cue.
- [x] **BROW-006 — YouTube full Quit:** Play a YouTube video, Quit, reopen, and verify the same video is restored paused at the last known position (±5 seconds). Nothing auto-plays sound on launch. Automated native-browser regressions cover paused restore and rapid-Quit protection. In the final real-Electron retest, the restored YouTube tab held at 1:31 beyond the former delayed-autoplay window; an intentional page click advanced it to 1:34.
- [ ] **BROW-007 — Resume cue:** On first close with browser state, show a non-blocking message such as “We'll reopen your browser where you left it.” On restore, show “Browser restored where you left off.” The cue must not cover controls or repeat forever.
- [ ] **BROW-008 — Site-owned resume distinction:** Repeat YouTube while signed out and signed in. MiaOS must not count YouTube account history as proof that MiaOS persisted playback time.
- [ ] **BROW-009 — Chat link routing:** Click an HTTP(S) link in a Mia/bot response. It opens in the native MiaOS browser tab, not an iframe or external fallback.
- [ ] **BROW-010 — YouTube/LinkedIn access:** Navigate directly to both sites. MiaOS adds no domain-specific restriction or substitute page; ordinary site authentication and anti-bot behavior remain distinguishable from MiaOS errors.
- [ ] **BROW-011 — Ghost control:** While a tab is visible, ask Mia to read, click, fill, navigate, stop, and switch tabs. Commands operate on the same native browser the user sees.
- [ ] **BROW-012 — Ghost after restart:** Restart and ask Mia to inspect the restored selected tab. Exactly one Ghost bridge answers and it maps to the visible app instance.
- [ ] **BROW-013 — Hung/crashed tab:** Terminate a tab renderer. The tab shows an actionable reload state; chat and other tabs remain usable and resources settle after close.
- [x] **BROW-014 — Browser close resource release:** Close the browser pane/tab while video plays. Audio stops immediately; media/GPU load returns near its pre-video baseline within 30 seconds. The original real-Electron test failed because YouTube restarted invisibly after a one-shot pause. The fixed native owner now holds every audio/video element paused while hidden and releases only for a page gesture: playback advanced to 1:34, held at 1:34 through 10 hidden seconds and five reopened seconds, then advanced to 1:41 only after a new deliberate click. The focused native-browser suite passes 15/15.
- [ ] **BROW-015 — Pane/window geometry:** Resize the app and browser split, Quit, reopen, and verify the agreed window/pane geometry. No browser view overflows or obscures chat at minimum supported size.
- [ ] **BROW-016 — Downloads:** Start and complete/cancel a download, then Quit. No partial-download process or unexplained temp file remains, and the file destination was user-selected.

### F. Model, provider, network, and MiaOS failures

- [ ] **ERR-001 — No model configured:** Send a message with no connected model. Do not start an endless thinking state; preserve the draft/message and say that a model connection must be configured.
- [ ] **ERR-002 — Invalid OpenAI credential:** Return OpenAI 401/403. Show: “OpenAI connection error. Reconnect OpenAI or choose another connected model.” Never label it a Multiplayer Test outage.
- [ ] **ERR-003 — OpenAI quota/rate limit:** Return OpenAI 429. Show: “OpenAI is rate-limited or out of quota. Try again later or choose another connected model.”
- [ ] **ERR-004 — OpenAI outage:** Return OpenAI 5xx/timeout. Show: “OpenAI is temporarily unavailable. Your message is saved; retry when ready.”
- [ ] **ERR-005 — Local network offline:** Disable network after Send. Show: “No internet connection. Your message is saved; retry when you're back online.”
- [x] **ERR-006 — MiaOS backend unavailable:** The live LIFE-010 run displayed a MiaOS-specific service banner over the preserved UI and offered one safe “Restart and reconnect” action. It did not mention or blame OpenAI; the action restored one backend/runtime pair and cleared the banner without replacing browser or chat state.
- [ ] **ERR-007 — MiaOS gateway/runtime unavailable:** Keep the backend up but make the model runtime unavailable. Identify it as a MiaOS service problem and record a diagnostic correlation ID without exposing internals or secrets.
- [ ] **ERR-008 — Tool failure only:** Make Firecrawl/browser/file tooling fail while the model remains connected. The response identifies the failed capability and does not misreport a model API failure.
- [ ] **ERR-009 — Explicit fallback policy:** If the user has enabled another connected provider, offer or perform only the documented fallback. Never silently switch providers, models, identities, or billing accounts.
- [ ] **ERR-010 — No fallback available:** Preserve the selected model and message, end the progress animation, restore Send/Retry controls, and show the provider-specific error.
- [ ] **ERR-011 — Error recovery:** Restore the failed dependency and press Retry. Produce one response linked to the original user message; no duplicate progress or stale error remains.
- [ ] **ERR-012 — Secrets and logs:** Inspect UI, console, desktop logs, backend logs, and persisted events after every failure. No API key, OAuth token, password, or authorization header appears.

### G. Chat interaction and rendering limits

- [ ] **CHAT-001 — Stop:** While a model is responding, the Send button becomes Stop when the composer is empty; Stop terminates the current response and returns to Send.
- [ ] **CHAT-002 — Steering:** Type and send a new message while a response is in progress. It is accepted as steering/follow-up according to the product contract and never disabled silently.
- [ ] **CHAT-003 — Current model label:** The composer always shows the current selected model, including during load, failure, retry, workspace switch, and restart.
- [ ] **CHAT-004 — Verbose mode:** With tools/debugging accepted and Verbose selected, show the complete allowed runtime stream and tool calls in order. Normal mode remains concise.
- [ ] **CHAT-005 — Latest shimmer only:** During one response, only the newest in-progress status/message has the moving-light animation; completed progress messages are static.
- [ ] **CHAT-006 — Select/copy:** Select and Command-C both user prompts and Mia/bot responses, including multiline text and links. Clipboard content matches the visible selection.
- [ ] **CHAT-007 — Markdown previews:** Sidebar previews strip presentation Markdown such as `**`, headings, and code fences without corrupting ordinary punctuation.
- [ ] **CHAT-008 — Long message overflow:** Render long URLs, hashes, code, tables, lists, and attachments at minimum width. No content widens its chat pane or is clipped behind the composer.
- [ ] **CHAT-009 — Link click:** Links remain selectable/copyable and open in the native browser without causing horizontal overflow.
- [ ] **CHAT-010 — Unread state:** A background delivery creates one fixed orange dot. Opening the conversation clears it; restart does not resurrect a read notification.
- [ ] **CHAT-011 — Activity priority:** If a conversation is both unread and currently active, show one pulsing dot; once activity ends it becomes one fixed unread dot; once read it disappears.
- [ ] **CHAT-012 — Avatar animation budget:** Only the canonical active Mia avatar animates at a time; duplicate Mia avatars in message rows remain static, and bot animations are staggered rather than synchronized.

### H. Persistence matrix

For each row, test Window Close, Command-Q, forced termination, backend restart, and workspace switch.

| State | Proposed expected persistence |
|---|---|
| Authorized users/memberships | Yes, from database only |
| Channels and messages | Yes, from database only |
| Selected workspace | Yes |
| Active conversation | Yes, if still authorized |
| Conversation scroll position | Yes within the active conversation, or explicitly reset without stale content |
| Unsent composer draft/attachment | Draft yes; attachment only if safely restorable and still authorized |
| Window size and position | Yes, clamped to available displays |
| Browser-pane open/closed state and width | Yes |
| Browser tabs and selected tab | Yes |
| Browser cookies/session | Yes for the persistent user profile |
| Browser Back/Forward history | Product decision must be explicit and tested |
| YouTube/video playback position | Yes, best effort within ±5 seconds; restore paused |
| Completed progress animation | No; completed content is static |
| Live activity/pulse | No stale persistence; recompute from authoritative live work |
| Unread marker | Yes until the user opens/reads the conversation |
| Password/API-key form values | Never |

### I. Resource and leftover audit

- [x] **RES-001 — Baseline ownership map:** Recorded one Electron main tree, one child backend on `127.0.0.1:4971`, one backend-owned runtime on `127.0.0.1:9221`, the isolated Ghost bridge socket, profile/database/artifact paths, descriptor counts, and three enabled schedules. The separately launched global Ghost daemon (PID 61370 at capture) is explicitly outside this app tree and must not be mistaken for a duplicate MiaOS runtime.
- [x] **RES-002 — Idle settle:** After closing the browser pane and waiting 30 seconds, 30 process-tree samples over 60 seconds averaged 1.61% total CPU. Twenty-six samples were at or below 1.8%; four brief samples were 3.5%, 9.3%, 9.4%, and 16.3%, with no sustained or increasing load. The owned process count stayed exactly 11 throughout and the post-sample Electron renderer/GPU processes were individually 0.0–0.1% CPU.
- [x] **RES-003 — Restart trend:** At cycles 1/5/10/20 the Electron process counts were 9/9/9/8, RSS 1151.5/1164.0/1140.2/1120.7 MiB, and main descriptors 222/222/222/223. Each cycle had one backend, one runtime, and one listener per required port; every inter-cycle Quit released them. CPU samples were intentionally taken one second after launch with YouTube loading (73.9/129.0/182.0/89.6%), so they are startup-load evidence, not idle CPU evidence.
- [x] **RES-004 — Memory gate:** Cycle-20 Electron RSS was 2.7% below cycle 1 and the last three checkpoints decreased monotonically; no restart memory-growth pattern was observed.
- [ ] **RES-005 — CPU gate:** With no typing, model response, automation run, media, or animation, average total MiaOS-owned CPU over 60 seconds is no more than two percentage points above its clean idle baseline.
- [x] **RES-006 — Process gate:** The post-recovery steady-state inventory contained one Electron main (PID 68794), one GPU helper, one network helper, one audio helper, five renderer helpers for the shell plus two retained native tabs/site isolation, one child backend (PID 69248), one backend-owned runtime (PID 69254), and one isolated Ghost socket. There was one Electron main match, one 4971 listener, one 9221 listener, and no 4972 listener or second runtime.
- [x] **RES-007 — Quit gate:** The standalone Command-Q test and the final step of the 20-cycle run both left no Electron/backend/runtime process, port 4971/9221 listener, or isolated Ghost bridge socket. The global separately launched Ghost daemon was outside the tested app tree.
- [ ] **RES-008 — Automation load:** Compare idle, one running automation, and three simultaneous automations. Resource use returns near baseline after completion and no finished worker remains marked active.
- [ ] **RES-009 — Browser media load:** Compare before playback, during YouTube playback, after closing the tab, and after Quit. Audio and media-related load end at close/quit.
- [ ] **RES-010 — Data leftovers:** After cleanup and two restarts, query for the synthetic prefix across users, memberships, conversations, events, bots, schedules, sessions, attachments, and activity state. Only deliberately retained evidence remains.
- [ ] **RES-011 — Filesystem leftovers:** Compare user-data and temp directories before/after. No partial state file, abandoned download, stale browser profile lock, unauthorized artifact, or unbounded log growth remains.
- [ ] **RES-012 — Error leftovers:** Search logs for destroyed-object exceptions, address-in-use errors, duplicate-session warnings, unhandled rejections, repeated provider prompts, and secret material.

### J. Final resizing stress test

- [ ] **SIZE-001 — Width sweep:** Repeatedly resize the Electron window through minimum, narrow, medium, large, and maximized widths. Navigation, chat, composer, details, and native-browser panes remain usable with no horizontal page overflow.
- [ ] **SIZE-002 — Height sweep:** Repeatedly resize from minimum height to full height with long chats, expanded messages, popovers, and attachments. The composer remains reachable and content scrolls inside its owning pane.
- [ ] **SIZE-003 — Browser collaboration layout:** Resize while the native browser, browser sidebar, debugging pane, roster, and automation details are open. Bounds never overlap, leak outside the window, or hide controls.
- [ ] **SIZE-004 — Dragging budget:** During continuous resize, sample Electron renderer/GPU CPU and verify it returns to the established idle baseline after the drag stops.
- [ ] **SIZE-005 — Relaunch restore:** Quit at a non-default window size and position, relaunch, and verify the restored geometry is clamped to the current display with no login/stale-data flash.

### K. Blind Luna-low usability test

Run these last with a fresh Luna-low evaluator that receives only the visible Electron app—no repository, source code, selectors, database, prior MiaOS context, implementation notes, or operator hints. Record its screen, actions, wrong turns, and final outcome.

- [ ] **BLIND-001 — End-to-end discovery:** Give only “Use this app end to end and explain what it lets a normal user accomplish.” The evaluator can discover workspaces, conversations, composer, people/bots, automations, and browser without hidden knowledge.
- [ ] **BLIND-002 — Browse the web:** Give only “Try to get to browsing the web.” The evaluator finds and opens the native browser, navigates to a safe public page, and can return to chat.
- [ ] **BLIND-003 — Conversation discovery:** Give only “Create a channel, send a message, leave it, and find it again.” Navigation and labels are sufficient without guessing internal concepts.
- [ ] **BLIND-004 — Automation discovery:** Give only “Set up a repeating reminder and then inspect or stop it.” The evaluator can distinguish a bot from an agent, find automation details, edit/stop it, and understand whether it is currently running.
- [ ] **BLIND-005 — Failure recovery:** Give only “Use a model that is unavailable and recover.” The error identifies the provider/problem owner and exposes a useful retry/model-change path without technical logs.
- [ ] **BLIND-006 — UX remediation gate:** For every hesitation, dead end, misleading label, hidden control, or source-dependent inference, record the exact screen and treat it as a UX defect—not evaluator failure.

### L. Final roster spacing polish

- [ ] **ROSTER-001 — User-row breathing room:** In People, Agents & Bots, verify the avatar, display name, email, section count, and `Manage` control have comfortable horizontal and vertical separation at minimum, normal, and maximum supported widths. Nothing touches, crowds, clips, or appears visually fused.
- [ ] **ROSTER-002 — Roster alignment consistency:** Compare user, agent, and bot rows with one item and many items. Avatars share one column, primary/secondary text shares one baseline grid, section actions stay aligned, and resizing does not collapse the intended spacing.

## Recommended execution sequence

1. Record the commit/build and establish `RES-001` through a clean baseline snapshot.
2. Run startup first-frame tests before creating any synthetic data.
3. Create channels, bot conversations, three bots, and three automations in the isolated profile.
4. Exercise normal chat, parallel automations, activity/unread states, and the in-app browser.
5. Play YouTube and run the Window Close, Quit, immediate reopen, backend restart, and force-kill sequences.
6. Repeat the full restart loop 20 times while capturing resource checkpoints.
7. Inject model/provider/network/tool failures one at a time and verify attribution plus recovery.
8. Remove all synthetic objects, restart twice, and perform the final process/database/filesystem leftover audit.
9. Run the final resizing stress test across app, chat, and native-browser layouts.
10. Run blind Luna-low end-to-end tasks with no source or prior MiaOS context.
11. Complete the final People/Agents/Bots roster spacing and alignment pass.
12. Produce an acceptance-results table with every scenario marked `passing`, `failing`, `blocked`, or `unverified`, linked to its evidence.

## Product decisions to confirm during review

1. Resolved: red-window Close fully quits MiaOS after persisting browser state and releasing owned resources.
2. The proposed YouTube behavior is to restore the same video near the last position but paused, with a short non-blocking restore cue. Confirm this is the shipping contract.
3. Confirm whether browser Back/Forward history must survive a full Quit; current MiaOS state persistence stores URLs/titles, not navigation history.
4. Confirm that automations must continue while the Electron UI is fully quit. If yes, the independent scheduler must be singular and explicitly owned, not an orphaned app/backend tree.
5. Confirm the exact public wording for provider failures; the plan separates OpenAI, network, and MiaOS failures and forbids silent provider fallback.
