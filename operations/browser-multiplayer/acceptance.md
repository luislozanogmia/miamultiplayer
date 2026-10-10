# Browser multiplayer acceptance evidence

Current evidence includes actual DeepSeek Flash execution through Mia's bot UI
on isolated Linux display `:100`, followed by independent stored-work, runtime
session metadata and rendered-output checks. See
[root UI run](flash-ui-acceptance.md) and
[independent real Flash evidence](real-flash-acceptance.md), both tied to app
source `944a8ca`. Subsequent actual Stop/group/approval/reuse evidence uses app source `8b50f9f`; ledger reconciled through integration `7ea009c`.
Personal Mia and two real workers completed Alpha 17 + Beta 29 = 46.
The original locked DCV session remains preserved; it no longer blocks this
separate display's exercised path. The disposable app uses supported local
mode, which does not establish Clerk or Mia Router authorization. Full MVP
acceptance remains open for the unverified gates in the current table below.
Earlier starting states and incident observations are explicitly historical.

## Explicit personal Mia model selection

Luis authorized a fresh local-only profile and direct DeepSeek credentials for
testing, selecting V4.1 Flash. The live API accepts `deepseek-flash`. Local mode
does not verify Clerk or Mia Router. Baseline `d2d5dd5` picks the first connected
API model for personal Mia, which is Pro in the current live inventory.
The new gate requires an explicit per-work personal selection to reach both
planning and synthesis, fresh connected-inventory validation, rejection of an
unavailable choice without default fallback, and a UI choice distinct from bot
models. Automated regression and actual Hermes session evidence are required.

## Recoverable Stop addendum

Luis requested this addition after the initial integration: preserve useful
partial work when interrupted, inspired by a supplied vendor UX description.
That description is design input, not measured reliability evidence.
Baseline for this addition is `63082c8`.

| Required behavior | Starting evidence | Acceptance gate |
|---|---|---|
| Original goal and actual visible streamed answer survive Stop and process restart | Goal already stored; streaming text not persisted | Interrupted worker regression plus encrypted-store reload |
| Partial answer remains explicitly stopped, incomplete and unverified | Stopped label exists; partial output absent | UI projection regression and actual Linux UI interaction |
| Recovery retains prior attempts as context while requiring fresh browser evidence | Recovery deletes prior result | Recovery prompt/state regression; no prior proof promotion |
| Late replies cannot change stopped output; uncertain writes cannot replay | Existing epoch and uncertain-write guards | Retain negative coverage across the new path |

Agent 2 owns coordination and durable state, agent 3 owns display, and agent 4
independently reviews their combined changes. Existing turn limits remain.
The actual Linux UI and real Hermes interruption/resumption gates remain
unverified until exercised; automated transport fixtures cannot close them.

Integrated implementation `2572ef7` preserves visible worker and personal Mia
text, bounded prior-attempt history, and fresh recovery context. Root's combined
focused checks pass 45/45, including three independent regressions that failed
against the baseline. Full backend checks pass 544 with three optional probes
skipped; frontend and desktop checks pass 464. Independent review is recorded
in `recovery-acceptance.md`. These are automated local/integrated checks.
At that historical stage the original isolated app remained on earlier source:
DCV reported locked and `/api/browser-work` returned 401. That stage established
no real model or manual UI result. The later separate-display Flash run above
supersedes that starting limitation for its exercised path only.

Frozen contract: `operations/browser-multiplayer-mvp.md`, all 15 criteria. Base
`0eb6c0ba7cfa8f49788355468c04a1d33968d0c7`. Verification lane owns only this
directory and focused tests. Candidate modules do not establish integration.

## Historical baseline and readiness

`baseline.json` records all 15 starting states. Existing browser and bridge tests:
40 passed, zero failed. These use an Electron boundary double (`mocked`).

Real pinned Electron 44.2.0 / Chromium 152.0.7977.76 starts on Ubuntu 22.04,
glibc 2.35, Node 22.22.3. `electron-readiness.cjs` enables sandbox, sets disposable
userData, loads a hidden isolated renderer, and reports `require` undefined.
Secure storage reports encryption available and `gnome_libsecret`. No
credential files are read. This is `local` readiness, not sign-in evidence.

`runtime-baseline.cjs` loads the actual browser owner into pinned Electron and
serves disposable loopback pages. The protected Mia backend origin differs
from the fixture origin, preserving the attachment boundary. On the base:
an explicit worker-tab read returned the active human page, and an unknown
actor's scroll was accepted. Human active tab stayed selected. This establishes
failures of criteria 3 and 7 at the actual browser owner (`local`); it does not
exercise the Mia frontend, real workers, or manual acceptance.

PR39 runtime source is the pinned Hermes commit
`eeb220d40c2fb6cb33d61a9b792ca68811408b3a`. Its existing launcher selects test
Clerk and local profile; it cannot establish production Router authorization.
No existing credential contents were inspected or copied.

## Required integrated sequence

Use a fresh disposable data root, pinned Hermes, encryption and Chromium
sandbox. Keep production account secrets in their approved runtime store.
Record exact source SHA, runtime, authentication instance, requested model,
and evidence path without account identifiers or credential values.

1. In the actual Linux Mia UI, create named groups and three tabs using the
   fixture server's `/human`, `/worker-a`, `/worker-b`. Choose the human tab,
   type a distinctive unfinished draft, and leave its caret in the input.
2. Give personal Mia the overall goal: obtain Alpha 17 and Beta 29 with two
   distinct bounded bots, then synthesize their total 46. Establish dependency
   order in stored work. Personal Mia must remain the coordinator.
3. Observe **two actual Hermes sessions/turns**, each with the requested model,
   stored native events/results, and one bound tab. A scripted model transport,
   success status, or session creation acknowledgement is insufficient.
4. Observe personal Mia's actual Hermes synthesis consuming stored results.
   Verify visible statuses, bot motes, ownership rings and target region match
   execution events. Preserve the human tab, caret and draft throughout.
5. Read/click/fill/scroll/navigate each background worker tab. Capture each
   hidden tab and check correct distinct color and text. Verify the human tab
   and view do not change. Check parallel progress on separate tabs and queue
   serialization/cancellation on the same tab.
6. Exercise all negative paths below. Independently inspect the fixture
   server's `/evidence` counter and durable task/events, beyond HTTP success.
7. Close and restart the actual app using the same disposable root. Verify
   named group order, active group, selected tab per group, worker results and
   owner authorization. Also load a disposable legacy tab-state fixture.
8. Record each of the 15 final states separately. Anything not exercised is
   `unknown`/`blocked`; local or mocked passes cannot close the real UI gate.

## Negative tests and recovery observations

| Criteria | Action | Required observation |
|---|---|---|
|3,14|Spoof actor, tab, group or owner; omit explicit actor tab; request another owner's results.|Denied before browser/model dispatch or result exposure; no implicit active-tab fallback.|
|6|Queue two mutations on one tab; Stop the head while second waits; operate another tab.|Same-tab operations serialize, other tab progresses, cancelled head releases queue.|
|8,12|Request consequential `/write`; reject approval.|No write counter increment; draft/caret/view unchanged.|
|9|Reuse numbered snapshot on another actor/tab, after reread, after navigation/reload/history or document replacement.|Fail closed before dispatch; fresh snapshot succeeds only on original bound actor/tab/document.|
|12|Accept then revoke approval while operation queues; change target/tab/task/document or owner before dispatch.|Revalidate at dispatch and deny; no write, no stale approval reuse.|
|13|Stop worker and group separately; release delayed model reply afterward.|Matching Hermes interruption, partial results retained, no late reply/status overwrite; unrelated work continues.|
|13,14|Crash/restart after a write was dispatched without completion proof.|Durable uncertain-write hold; no automatic replay, reusable work remains unvalidated.|
|14|Validate reusable work without durable proof or with mismatched owner/group.|Denied; completed proof-preserving work survives restart and remains owner authorized.|

## Commands

```sh
node --test macos/src/browser.test.cjs macos/src/mia-ghost-bridge.test.cjs
macos/node_modules/electron/dist/electron operations/browser-multiplayer/electron-readiness.cjs
macos/node_modules/electron/dist/electron operations/browser-multiplayer/runtime-baseline.cjs
node operations/browser-multiplayer/fixture-server.mjs
MIA_TEST_VISIBLE=1 MIA_TEST_SOURCE=/absolute/candidate/tree macos/node_modules/electron/dist/electron operations/browser-multiplayer/native-smoke.cjs
node --test operations/browser-multiplayer/fixture-server.test.mjs
```

The characterization runner uses `MIA_TEST_SOURCE` to select a candidate tree;
it must be rerun with actor registration once that tree's exact API is integrated.
It never returns an acceptance pass, even when the characterization process exits 0.

`native-smoke.cjs` tests the actual candidate owner with its trusted binding API,
real Chromium DOM, native captures and loopback write evidence. Hidden host
windows have no display surface; a visible host with hidden worker tabs is
required for screenshot coverage. The script waits 300 ms for compositor
initialization without selecting or showing the workers. On the runtime lane's
mutable candidate at `/2371`, seven scenario groups passed: actor/tab/owner
denial, background operation draft/caret preservation, distinct screenshot
pixels, stale/replaced snapshots, approval denial/one-use/write observation,
revocation and group persistence. These remain local candidate evidence until
rerun against an immutable integrated source SHA. At that candidate stage,
real UI and real model gates remained open. Later integrated and actual Flash
evidence is recorded in the current table. No source path alone establishes a
candidate revision.

## Historical incident and preserved boundaries

At 2026-10-09 21:15 America/Monterrey, invoking the existing packaged binary
with `--version` entered app startup and began copying runtime staging into
`~/.config/Mia/hermes/hermes-agent.next`. The process was interrupted and exited;
the exact command no longer had a live process. Staging directory metadata
showed modification at 21:15:25. No staging contents or credential values were
read. No cleanup was attempted; uncertain content is preserved. This incidental
runtime-copy mutation is separate from disposable checks and precludes claiming
the installed profile was untouched. All later checks use isolated Electron.

## Current integrated evidence: all 15 criteria

Actual UI initiation is root-reported computer-use evidence. Independent
verification inspected the final screenshot, real stored replies, current
native read operations and narrow runtime session metadata. It did not witness
initiation. Actual runtime metadata confirms `deepseek-flash` / `deepseek` for
personal Mia and both workers, beyond requested options or inventory. Alpha's
three unsupported method attempts failed before its successful `read`; failed
operations are excluded from completion proof. Read-only success does not
establish approval, mutation, interruption or restart acceptance.

The [recoverable Stop review](recovery-acceptance.md),
[explicit model review](model-selection-acceptance.md) and
[runtime helper review](secret-helper-acceptance.md) supply integrated local
regression evidence, distinct from the actual Flash run. Previous native-owner
smoke evidence remains applicable to its tested scope:

Browser-owner smoke first passed integrated browser modules at
`8939dbaabee0e523d68f7983ae5d7a665c4d2dea`, then expanded smoke passed at
`c447db29e2773a8832b291cad54941ba76260824`. The latter tree was clean when
inspected. Eleven real Electron scenario groups pass, including exclusive tab
claims and revocation suppressing both late native results and queued work.
The final expanded twelve-scenario harness also passed against final source
`8e8f685a64b81ada81671f34276932916a831f77`, including one bot's second-tab
claim denial and selected native-tab reorder preserving group selection.
The harness uses actual browser modules from that tree. It does not import
the frontend or claim actual Hermes model execution.

| # | Current result | Evidence and remaining gate |
|---|---|---|
|1|PARTIAL: actual UI groups/order/selection restart passes; legacy coverage local|Manual UI named groups, empty group, tab reordering via Move tab, active group and selected tab survived actual app quit/relaunch. See group-ui-acceptance.md and live-stop-and-groups.md. Legacy v1 loading and v2 reopening now pass the actual sandboxed native probe; see legacy-state-restore.md for its same-process/native-owner limits.|
|2|PARTIAL: actual personal Mia planning/synthesis; lifecycle checks open|UI selected personal Mia separately from bots; its real session planned the work and synthesized two stored replies to the overall goal. Group context/dependency retention has integrated scripted coverage; broader lifecycle remains open.|
|3|PARTIAL: actual bound reads; native negative checks pass|Two distinct actors/bots read explicit tabs 2/3 at current epoch 0. Local trusted-capability, actor/tab/owner spoof, competing claim and revocation tests pass. Actual UI reassignment/revocation lifecycle remains unverified.|
|4|PASS for exercised Flash dispatch; other model choices unverified|Requested personal and worker `deepseek-flash` matches all three actual runtime session rows with billing provider `deepseek`. Explicit-selection persistence/no-fallback regressions pass. No claim for other providers/models.|
|5|PARTIAL: two real workers and personal synthesis complete|Current successful native reads feed actual stored Alpha 17/Beta 29 replies and personal synthesis 46. Actual fd19 non-empty dependency gating and downstream result propagation now pass; two current saved-plan replay runs have explicit fresh native links (real-dependency-replay.md). That run omitted arithmetic 46; earlier numeric-sum evidence remains separate.|
|6|PARTIAL: real independent worker progress plus native queue checks|Root observed Beta done while Alpha awaited approval in actual work 8d12; stored result visible in predecision card. Same-tab serialization/cancel release remains native-owner evidence, not established by final model records.|
|7|PARTIAL: actual background reads/click/fill/canonical scroll; navigation open|Actual assigned-tab reads and approved click preserve human selection. Integrated parameter fix is consumed in work710bbc: direction down/amount400 result400 and current Beta scrollY400. Earlier deltaY/default500 remains failed evidence. Actual Beta fill is verified in failed-all-tools-attempt.md and interrupted-fill-attempt.md. Alpha fill/read/vacuum/scroll/capture ran in 56eba with a failed literal mismatch. Fresh post-fix 7f579 preserves Alpha acceptance in plan/card/fill/post-fill vacuum and final synthesis; see real-exact-fill-acceptance.md. Navigation and two-worker full sequence remain open.|
|8|PARTIAL: full human draft/focus/caret preserved during real workers and recovery|Narrow read-only native observations before/during/after actual work match full draft, active input and caret8 while human tab1 remains selected. Manual Stop/recovery also preserves human control. Disruptive human-viewed-tab approval remains open; unsaved draft restart retention is not claimed.|
|9|PARTIAL: native snapshot negative checks pass|Reread/cross-actor/cross-tab/replaced-node snapshots are denied; main-world overwrite cannot change isolated snapshots. These are actual native-owner tests; model-driven stale/document-change snapshot paths through the app UI remain unverified.|
|10|PASS for actual cold-restored hidden Alpha/Beta capture|Integrated83c8454 actual UI work710bbc repeats never-selected worker restart path; both current screenshots show correct red17/green29 with1440x900 matching hidden viewport. Independent hashes/pixels/runtime metadata corroborate. Native timeout/busy/navigation negatives remain local; see live-cold-capture.md.|
|11|PARTIAL: real status/ring/mote/target region; lifecycle UI gate open|Actual cold worker screenshots show labelled working motes and owner borders. Actual c236 selected owned-tab ring and targeted region passed (real-linked-approval-presence.md). Corrected after-wait geometry/document guards have independent native evidence; full current app lifecycle/manual refresh and target-cleanup gates remain open.|
|12|PARTIAL: actual Reject and Approve once pass; revalidation negatives local|Actual ce745 Reject records rejected and no native click/fixture write. Actual8d12 grant consumed, exactly one native click, independently observed fixture counter1 from root baseline0. Native negative gates pass; actual stale target/revocation/queued permission changes remain open. Post-fix c236 synthesis cites the consumed grant and linked native execution correctly (real-linked-approval-presence.md). Literal task drift in 56eba remains failed history; fresh post-fix 7f579 exact-literal path passes.|
|13|PARTIAL: actual group Stop/partial persistence/fresh recovery pass|Actual work741 preserves stopped incomplete/unverified Alpha/Beta partial text, unchanged after late replies and quit/restart. Manual Recover starts fresh sessions/current epochs/read proofs while retaining prior attempts. Actual individual Alpha Stop preserves an already-done Beta result; active sibling continuation and Alpha partial retention remain open (real-individual-stop-acceptance.md). Controlled 0a9b crash establishes startup uncertainty/partial retention/one attempt, but dependent recovery incorrectly returned200; fix/retest and personal Mia Stop remain open (real-controlled-write-crash.md).|
|14|PARTIAL: actual result restart and linked saved-step replay; uncertainty gate open|Actual stopped outputs survive app restart. UI exported Beta read-only proof and selected reference for Alpha; work10015722 has fresh Alpha17 reads and rendered synthesis. Native records lack explicit replay/source link, so worker run_reusable claim is not independent replay proof. Reference persistence and post-fix fd19 linked replay now have actual evidence (real-dependency-replay.md); historical 10015722 remains unlinked. Controlled 0a9b startup uncertainty and export409 pass, but dependent Recover200 fails; a candidate guard requires integration/actual retest. Cross-owner lifecycle gates remain open (real-controlled-write-crash.md).|
|15|PARTIAL: actual two-bot Flash synthesis plus focus/group restart evidence|Actual UI personal Mia plus two Flash workers produce17/29/46. Subsequent group Stop/recovery preserves full draft/focus/caret and group/tab state survives actual quit/relaunch. Cold screenshots and actual dependency/replay paths now have bounded evidence; full tool/control/approval/uncertain-write lifecycle remains open; post-fix exact-literal task now has bounded actual acceptance. Linux evidence does not establish native Mac/Windows acceptance.|

### Historical original app startup and mounted-route observation

Isolated app started from `8de474ca44617c62c6466277e1e5f79e399c995e` with
production Clerk authentication enabled, its own database and desktop profile.
The actual `/api/browser-work` request initially returned 404; root found the
API fallback preceding the dynamically registered routes. A graceful SIGTERM
app shutdown stopped both the owned app and backend. Relaunch of the same
marked disposable root at `c447db29e2773a8832b291cad54941ba76260824` returned
401 (`unauthorized`) from `/api/browser-work`, demonstrating the mounted auth
boundary. This is actual local app/backend startup evidence, not a manual
Development-menu restart.

Original preserved app at that stage: PID 627467; backend PID 627557; URL
`http://localhost:4969`; data root `/tmp/mia-browser-mvp-ui-verifier-20261009-01`.
It was gracefully relaunched from final implementation
`8e8f685a64b81ada81671f34276932916a831f77`; previous owned app/backend PIDs
were confirmed stopped. Its `/api/browser-work` request returns 401 before
sign-in. This root is kept for Luis rather than removed as a transient fixture.
Port selection advanced automatically rather than reusing a busy port. No
existing app/profile data or credential contents were copied into this root.
The OS keyring is available, and `desktop/browser-work-key.enc` mode is 0600.
File presence establishes private key persistence, not a model connection.

Manual X11 acceptance was blocked on the original DISPLAY `:0`: its screenshot showed
GNOME's locked desktop and X window activation failed. The real Mia window
exists, titled `Mia - Solo`; no UI interactions were claimed. Preserve this
app for Luis, who must unlock the mia-dev-aws DCV desktop and complete the
supported production Clerk/model connection flow in this fresh profile. Root
must coordinate any restart after sign-in. No authentication, encryption or
Chromium sandbox bypass was permitted. Later root-authorized supported local
mode on a separate disposable profile/display established the Flash UI path;
it did not establish production Clerk/Router acceptance or unlock this profile.

### Historical Hermes provenance and independent policy checks

Readiness uses PR39's existing installed runtime: source HEAD is the pinned
`eeb220d40c2fb6cb33d61a9b792ca68811408b3a` with eight tracked local changes
(auxiliary client, model metadata, reasoning effort, Codex models, model switch,
model switch providers, installer and gateway server). This is a locally patched
pinned runtime, not a clean source checkout. No patch or credential content was
copied into this lane. Independently running the coordinator's policy/registry
test against clean `/tmp/mia-browser-work-pinned` at that exact pin passed plugin
registration, configured CLI tool policy, seven tool-bypass denials, environment
capability scrub, runtime-injected session identity and Ghost method normalization.
That test makes no model call. The final twenty coordinator Node tests also
passed independently at `3acbeaaae46e1713743a212eb8d8a6d9b02bf53f`; they use
scripted Hermes/browser transports. They additionally require successful
current-attempt read/vacuum/screenshot proof before completion, preserve
model-only text as unverified and block synthesis, reject stale attempt proof,
and reject structured native errors. This minimum provenance gate does not
establish semantic task correctness or real model execution.

### Historical consequential-input regression and fix

Independent `fill-approval-probe.cjs` against clean integrated
`c55bc93130e9ab9e4f9d263225568d2a8735560a` attached a real input-event autosave
listener on a disposable hidden worker page. Runtime validation reported
`requiresApproval: false`, unapproved fill succeeded, and the independent
fixture server recorded one POST write. The probe exited 1. This is a real
consequential write, not a scripted model or inferred risk. Criteria 12 and the
uncertain-write parts of 13/14 remained open until runtime authority gated fill
and related consequential navigation without relying on model-provided flags.
Root/runtime lane implemented the fix at integrated
`f73a11d0da01884b7a2cd182ec77a8b547f015b1`. The independent probe passed:
`needsApproval: true`, `denied: true`, `writes: 0`, `approvedWrites: 1`, exit 0.
Runtime authority also requires approval for navigation, URL-changing vacuum,
back, forward and reload. Current grants are explicit in the updated native
smoke. Real model/UI uncertain-write recovery remains unverified.

### Historical initial integration review and suite evidence

Initial final implementation was `8e8f685a64b81ada81671f34276932916a831f77`. Root's full
backend suite reported 538 tests: 535 passed, three skipped, zero failed; its
desktop/frontend suite reported 459 passed, zero skipped/failed. Verification
independently inspected the exact summary logs at
`/tmp/mia-mvp-final-backend.log` and `/tmp/mia-mvp-final-desktop-frontend.log`.
These are local automated checks, including mocked boundaries and disposable
server processes, not external model/manual UI proof.

Independent review found no additional blocker after the concrete autosave
fix. Non-GET browser-work routes require interactive authentication rather
than accepting a bot/API bearer credential as a human approval. Native
presence colors are bounded hex colors. Runtime authority, snapshot identity,
operation-bound one-use grants and Stop epochs remain separate from page/model
text. Root's actual HTTP regression failed with 404 against pre-fix `8de474c`
and passed with 401 after mounting the browser-work router before the fallback.
Its bearer fixture permits authorized GET but denies approval POST with 401.
Those root checks are recorded as root-provided evidence; the verifier also
observed the actual isolated app's 404-to-401 transition independently.

No pushes, merges to main, releases, deployments or real-data migrations were
performed by this lane. All fifteen criteria remain in this ledger; the full
MVP cannot be marked complete while criterion 15's remaining focus/group/restart
checks and the other explicit actual UI/lifecycle gates in the current table
remain unverified. The real Flash execution evidence supersedes the historical
zero-execution state without closing those separate checks.
