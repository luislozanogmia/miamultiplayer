# Dispatched consequential write crash fixture

Candidate base: `2307ef3f59df06b93024b752ae8f67db480bcf11`. Scope: isolated
operations fixture, GET-only observer and focused tests. No core implementation,
credentials, encrypted-store edits, approval bypass, display access or app crash.
Root owns integration, actual Mia UI approval and the disposable app process tree.
Reviewed dependency evidence handoffs are unchanged.

## Frozen gates

| Criterion | Required evidence | Current evidence class |
|---|---|---|
| Synthetic effect precedes held response | fsynced sequence 1, responseOpen true, independent ledger | Local fixture test |
| Exactly bound pending native click | Current work/worker epochs, consequential dispatching click, exact linked consumed approval | Mocked metadata negatives and real loopback HTTP transport |
| No false readiness after race | Done/uncertain/closed/stale/mismatched/duplicate/late records remain inconclusive | Local focused negatives |
| Actual crash/restart, criteria 13/14 | Root performs UI approval, crashes owned app while native click pending, reopens original supported store and challenges uncertainty/replay | Unverified |

This is a new harness; there was no pre-existing failing implementation test.
The existing fixture's asynchronous fetch returns from the click handler before
its response arrives. Delaying that response or issuing a separate wait proves
neither a pending consequential click nor crash-during-dispatch acceptance.

## Root run sequence

1. Start the fixture separately from the app, using Node 22:
   `node operations/browser-multiplayer/dispatched-write-fixture.mjs`.
   It binds an ephemeral `127.0.0.1` port and prints only its origin, fixture ID
   and synthetic ledger path under a new private `/tmp/mia-dispatched-write-*`
   directory. Preserve this process through the app crash and restart.
2. In the actual disposable Mia UI, assign Alpha to `<fixture-origin>/worker-crash`.
   Keep human and Beta tabs separate. Request one click on `#crash-write`, fresh
   approval, and no retry if interrupted. The button performs a synchronous,
   same-origin XHR POST. The server fsyncs one synthetic sequence before holding
   its response for at most 30 seconds. Renderer blocking through the native
   isolated-world click must be observed in the real app, not assumed from tests.
3. Root approves through the real UI. Run the GET-only observer immediately:
   `node operations/browser-multiplayer/dispatched-write-observe.mjs <backend-origin> <fixture-origin> <fixture-id> <work-id> <worker-id> 8000`.
   Both origins must be explicit HTTP `127.0.0.1:<port>` origins. No auth values
   are accepted. An authenticated environment needing a credential must use its
   supported human observation path; this helper does not bypass authentication.
4. Only `ready_for_root_crash` permits root's next step. It brackets fixture
   evidence with two GET work observations of the same exact dispatching click,
   requires a current consumed grant bound to owner/work/worker/actor/tab/hash/
   generation/URL/epochs, and requires sequence 1 plus one attempted write and an
   open response. It rejects operation age >=8 seconds; the native script timeout
   at this base is 10 seconds. Root must act immediately and record the crash
   time and exact owned Electron/backend process scope. The helper never kills,
   approves, dispatches, restarts or changes anything. A native timeout, completion,
   response closure or missed window is inconclusive for crash-during-dispatch.
5. Restart the same supported disposable app profile/store. Verify the operation
   is `uncertain`, work awaits human review, and no new native dispatch or worker
   replay appears. Verify `/evidence` still has sequence 1 AND writeAttempts 1.
   The one-shot fixture rejects duplicates with 409, so a stable sequence alone
   cannot prove absence of automatic replay. Attempt counts remain independently
   fsynced even for rejected duplicate requests.
6. Root challenges worker/dependent Recover and reusable export through authorized
   app requests: expected 409 uncertainty/completed-proof denials. Existing saved
   source reuse is challenged only if actual pre-crash validated source proof
   exists; do not fabricate or edit encrypted records to create that condition.
   Verify rendered pending/uncertain state and separate actual stored/model/UI
   evidence. If the backend survived and already classified transport failure,
   report that path separately from startup `recoverInterrupted` classification.

GET `/evidence` returns only synthetic metadata. POST `/release` with the exact
fixture Origin header releases an open response without another effect. It is
for root cleanup or a non-crash control, not the accepted crash path. Timeout,
client disconnect and fixture shutdown close the pending marker; the synthetic
effect remains on disk. Stop the separate fixture after review; remove only its
printed disposable directory when evidence is no longer needed.

Observer output never contains operation parameters/results, page text, goal,
raw errors, approval capability, URLs or private profile paths. It uses GET only,
rejects redirects, caps each JSON response at 2 MiB and polls for at most 8 seconds
plus bounded in-flight GET latency. Readiness is an observation, not crash or
recovery acceptance. Fixture preflight does not prove real UI/model execution,
native callback blocking, durable app startup recovery or production behavior.

Focused checks: `node --test operations/browser-multiplayer/dispatched-write-fixture.test.mjs`.
The suite uses local loopback HTTP and synthetic metadata, no browser/model/app
process. No unchanged product suite is needed for this operations-only handoff.
