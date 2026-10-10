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
