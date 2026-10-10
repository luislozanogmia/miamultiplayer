# Browser multiplayer acceptance evidence

Frozen contract: `operations/browser-multiplayer-mvp.md`, all 15 criteria. Base
`0eb6c0ba7cfa8f49788355468c04a1d33968d0c7`. Verification lane owns only this
directory and focused tests. Candidate modules do not establish integration.

## Baseline and readiness

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
rerun against an immutable integrated source SHA. Real UI and real model gates
are still open. No source path alone establishes a candidate revision.

## Incident and preserved boundaries

At 2026-10-09 21:15 America/Monterrey, invoking the existing packaged binary
with `--version` entered app startup and began copying runtime staging into
`~/.config/Mia/hermes/hermes-agent.next`. The process was interrupted and exited;
the exact command no longer had a live process. Staging directory metadata
showed modification at 21:15:25. No staging contents or credential values were
read. No cleanup was attempted; uncertain content is preserved. This incidental
runtime-copy mutation is separate from disposable checks and precludes claiming
the installed profile was untouched. All later checks use isolated Electron.
