# Actual individual Stop boundary

October 9, 2026, mia-dev-aws Linux. Work
fb9bc378-139c-48a6-a015-18af9cbbc458 ran in the disposable actual Mia app. Root
reports manually clicking Alpha Stop bot and returning to the human draft with
caret 8. Verification independently read the synthetic work API and viewed
/tmp/mia-alpha-stop-button.png. That image shows both worker controls/statuses
before the reported click; it does not independently attest the click or its
precise timing. Immediate root metadata is /tmp/mia-individual-stop-immediate.json.

Later independent API observations agree: work failed at epoch 0; Alpha worker
1 cancelled at epoch 1; Beta worker 0 done at epoch 0. Alpha read/vacuum completed
at origin epoch 0, then wait 9d82ddd9-9d60-4379-942e-b373990feb28 failed. Beta
wait 5a19591b-eb6a-4073-8c5a-36540b80a8a8 completed 10000 ms, followed by fresh
read 36a3f1dc-d2ac-4521-bac2-b3419a56352e and a complete stored result. Root states
Beta finished before the Stop click. This proves preservation of an already
completed sibling, not ongoing sibling progress after Stop.

Two independent later API snapshots have identical status, epochs, workers,
operations and results. Alpha has no stored partial/final result; do not claim
partial-result preservation from this attempt. Beta's 2877-character complete
result remains byte-identical, SHA256
be820d369084eb5e5a9ef2c7fe97f41f9365d2208fed1a9199f4b2a54d032d9d.
There is no synthesis, approval, consequential operation, dispatching operation
or uncertain write. No late Alpha result appeared during these observations;
this is a bounded stability observation, not an indefinite guarantee.

This supplements individual cancellation evidence only. Group Stop, personal
Mia Stop, active sibling continuation, partial preservation and dispatched-write
crash/no-replay remain separate gates. Verification operated no app/display and
reran no passing suite.

## Later attempt rejected before Stop readiness

October 10, 2026, America/Monterrey. Documentation base `bd8125c`; the
attempt preceded that denial-observability integration. Work
`8ffb6e27-ca19-427a-977c-f05ca4b166f3` used two actual DeepSeek Flash workers
in the disposable Linux Mia app, reading synthetic localhost pages. Its
original goal requested Alpha's preliminary answer followed by a native
90000 ms wait and fresh final read, and Beta's preliminary answer followed by
a 120000 ms wait and fresh final read. Both dependencies were empty.

The independent raw snapshot `/tmp/mia-verifier-active-individual-stop.json`
shows both workers working at epoch 0, two completed reads and no stored result
yet. That snapshot alone does not establish readiness to preserve Alpha partial
text. The later independent snapshot
`/tmp/mia-verifier-independent-stop-observation-1791612016.json`, observed at
1791612016979, shows Alpha already done at epoch 0 with a complete
1373-character answer, while Beta is working at epoch 0 with a
568-character incomplete, unverified streamed answer and a dispatching
`wait` operation `e88af501-a081-4578-b76a-ff5510b83234`, params `{ms:120000}`.
Alpha has only two completed reads; it never dispatched its requested wait.
Its answer explicitly admits the missing 90000 ms delay. Alpha therefore
finished before the required active-worker plus partial-answer readiness gate.

Root reports no Stop click was performed. A fresh read-only GET of the actual
app's `/api/browser-work` was saved as
`/tmp/mia-ui-readiness-handoff-final.json`. It confirms the work and both workers
ultimately done, all at epoch 0, empty dependencies and no approvals. The four
reads remain done. Beta genuinely dispatched the bound native wait, but its
final operation status is failed, with no completedAt or successful wait result;
there is no later Beta read. Its complete 1128-character answer uses the earlier
read. Neither a completed 120000 ms delay nor the requested fresh post-wait read
is established. The failure cause is not identified by these snapshots.

Beta's final prose infers it was stopped from the generic denied-or-interrupted
error, and personal Mia's synthesis repeats that interpretation. These are model
claims, not evidence of a human Stop or matching session interruption. Root's
no-click report and unchanged epochs must remain distinct from that prose.
The runtime complete/verified result labels do not establish fulfillment of
either worker's requested delay or this Stop acceptance gate.

This attempt adds no individual Stop acceptance: Alpha was not stopped while
active with retained partial text, and no unaffected Beta operation after an
Alpha Stop exists. The earlier `fb9bc378` cancellation and already-completed
sibling evidence above remains intact. Criterion 13 remains partial. The next
material action is a coordinator-owned actual run that establishes both workers
active and nonempty incomplete Alpha text before the Alpha Stop click, then
independently observes Alpha partial retention and a fresh successful Beta
operation afterward. No UI/model/runtime mutation or test suite was performed
for this documentation handoff.
