# Actual controlled synthetic write crash and recovery failure

October 9, 2026, mia-dev-aws Linux. Documentation base 994e4c0, with actual app
source a29a1ea reported by root. Verification independently read synthetic
localhost work/fixture GET APIs and supplied evidence files and pixels; root
performed the actual UI approval, owned-process kill, same-profile restart and
authorized mutation challenges. Verification performed none of those actions.
No fixture test or trace substitutes for actual app evidence.

## Bound pending dispatch and crash

Work 0a9b6a14-9943-4140-87a9-2e2772fa4cd1 binds Alpha worker 1, actor
aac6ba1d-23c5-48f4-a50f-1aa583ba02d7, tab 2, document generation 2. Beta worker
0 on tab 3 depends on Alpha 1. Root reports manually approving
ac0807ba-7de6-4679-862d-88c41102391a. The GET observer in
/tmp/mia-controlled-crash-gate.json brackets the consequential dispatching click
8dff1f1b-13fb-444f-af92-daa4eb7a33fa with its consumed approval at epochs 0/0.
Inspection of recovered API records corroborates matching owner/work/worker/
actor/tab/hash/generation/URL and grant identity; the operation targets #crash-write.

The separate fixture instance 8449df9c-7405-43a6-b2c2-8b76010da01e, origin
http://127.0.0.1:35181, recorded sequence 1 and writeAttempts 1 before holding the
synchronous XHR response. Operation timestamp 1791611185857; fsynced synthetic
effect 1791611185892; pending observer 1791611186075 with responseOpen true;
root helper records SIGKILL at 1791611186077, two milliseconds later and 185 ms
after the effect, well before the 30-second response deadline and native timeout.
No completion/timeout race appears in this bounded evidence.

Verification read /tmp/mia-controlled-crash.mjs without executing it. It validates
owned Electron/backend PID start times, executable and CWD, backend parentage,
and rechecks root start times after readiness. Root reports killing Electron
682234/backend 682353 plus 12 descendants. The helper reports 14 kill signals;
it is not an independent OS exit census. Actual UI click/process termination
remain root-provided evidence, distinct from independent recovery observations.

## Independently observed supported restart

The first independent post-restart GET finds work waiting_for_user at epoch 1;
Alpha and Beta both waiting_for_user at epoch 1. The same click is uncertain;
only its earlier read/vacuum are done at historical epochs 0/0. The consumed
grant remains historical. No new operation or synthesis appears. Alpha's
289-character streamed answer is retained as incomplete, unverified, origin 0/0,
source message.delta, interruptedBy restart, with no current browser proof.

Independent fixture GET returns the same effect sequence 1 and writeAttempts 1,
responseOpen false, closedReason client_closed. The effect survived separately
from the crashed app. The one-shot fixture rejects duplicates; sequence alone
would not establish absence of replay. Both sequence and attempted-write count
remain one in the subsequent observation after root's recovery challenges.
This is a bounded no-replay observation, not an indefinite or production guarantee.

Independent viewing of /tmp/mia-uncertain-restart-ui.png shows Alpha Preserved
answer with Incomplete/Unverified labels and context-only warning. It shows the
human page with an empty input; it does not prove draft persistence or visibly
establish the separate waiting/uncertain state outside the displayed viewport.
Rendered waiting-state acceptance remains pending.

## Authorized challenge exposes a blocker

Root's /tmp/mia-crash-recovery-authorized-challenges.json records actual
same-origin authorized requests after restart:

| Challenge | Actual | Gate |
|---|---|---|
| Recover Alpha worker 1 | 409, uncertain write requires external effect review before recovery | Direct writing-worker hold passes |
| Export Alpha reusable proof | 409, completed execution proof required | Export denial passes |
| Recover dependent Beta worker 0 | **200**, work queued epoch 2, Beta queued epoch 2, Alpha still waiting epoch 1 | **Fails required dependent hold** |

Earlier originless 403 origin_required responses establish only the origin
boundary and are not uncertainty/recovery denials. They must not replace these
authorized challenge results. Verification made no POST request.

An independent later GET confirms the failure's persisted state: queued work at
epoch 2, Beta queued at epoch 2, Alpha waiting_for_user at epoch 1, same three
operations with the click uncertain, no synthesis, and unchanged incomplete
Alpha result. Root reports no /start was issued; API/fixture observations show
no added operation or write attempt. Thus the failure is unauthorized dependent
recovery state mutation, not an observed repeated write or Beta execution.

Root assigned a separate coordination fix for transitive prerequisite uncertainty
before recovery mutation while preserving independent-worker recovery. Candidate
source/tests and fresh authorized actual retest are required. No fix or full
crash lifecycle pass is claimed here. This attempt advances actual pending-crash,
startup uncertainty, preserved partial and bounded no-replay evidence while
preserving the failed dependent recovery gate in criteria 13/14.

The earlier e4d10565 attempt ended before approval: app/fixture exit and SIGTERM
were root-reported, sender unresolved, no crash helper invoked and no effect
claimed. It is not this controlled dispatch evidence. All effects here are
synthetic local fixture writes; no external production, credential, security,
Mac/Windows or full MVP acceptance is established.
