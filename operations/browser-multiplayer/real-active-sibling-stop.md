# Actual active individual Stop and sibling continuation

October 10, 2026, mia-dev-aws Linux. Root reports actual disposable Mia app
source bd8125c. Verification observed synthetic localhost work API only;
root controlled the UI. Work e3c01c2a-b62d-47db-8137-57a13fe874af has independent
Alpha worker 1/tab 2 and Beta worker 0/tab 3, with empty dependencies. Both
requested exact bound native wait ms120000 after visible preliminary reads.
No approval, write, recovery or restart was part of this attempt.

Independent pre-Stop observation at 1791612376550 finds work/worker epochs 0,
both workers working, both assigned-page reads done and both waits dispatching:
Alpha ef79fdd5-0362-4786-bd6f-d1220d9d3650 since 1791612346508; Beta
59377232-2992-460d-b0d5-e7e8eb492891 since 1791612344297. Alpha has a nonempty
290-character incomplete streamed result, SHA256
a619918435d4962e3906e01ebee9314f3ad30f9c93790930e5d8e964bfda8ad4.
This satisfies readiness; it is not inferred from a plan or UI Working label.

Root reports manually clicking Alpha Stop, anchored to the pre-click observation
timestamp 1791612384456 in /tmp/mia-bound-waits-at-stop.json. That observation
still has both working and both waits dispatching. The precise input-event
timestamp is not independently measured. Stored Alpha stoppedAt is
1791612384486; supplied after-state observation 1791612385663 has Alpha cancelled
at epoch 1, Beta working at epoch 0 and work still working at epoch 0.

Independent post-Stop GETs at 1791612411816 and 1791612454189 corroborate Alpha
cancelled epoch 1, failed Alpha wait, preserved stopped/incomplete/unverified
290-character answer and Beta still working at epoch 0 with its wait pending.
Alpha's text hash matches the pre-Stop value exactly. Browser evidence for this
stopped result is empty and source is message.delta at origin epochs 0/0; it is
retained context, not a completed answer or current proof.

Independent later GET at 1791612495401 establishes actual Beta continuation:
new assigned-tab read 740cb274-595e-484a-b08e-3aadcebf630d starts at
1791612466377 and completes at 1791612466420, after the root Stop observation
and stored stoppedAt. It returns Beta result 29 on tab 3/document generation 1.
Beta is now done at unchanged epoch 0 with a 1090-character complete stored
answer. Alpha remains cancelled at epoch 1 with the same exact stopped text.
This observation is later than Alpha's original 120000 ms wait deadline; no
late Alpha result or status overwrite appeared during this bounded window.
It does not establish an indefinite late-reply guarantee.

## Preserve separate failures

Beta's preceding wait is **failed**, with no completedAt or native waited_ms
result. Its final answer honestly says the wait did not complete, quotes the
generic denied/interrupted tool message and makes no literal duration claim.
Elapsed timestamps alone do not prove successful completion of ms120000, and
this evidence does not establish the wait failure's cause. No interrupted wait
retry appears. The successful fresh read proves sibling execution continued
after Alpha Stop even though the separate literal wait requirement failed.

Final work status is **failed** at epoch 0, and no personal Mia synthesis is
stored. Worker done/result complete are transport states and do not turn the
uncompleted wait or unsynthesized overall goal into a pass. Acceptance is scoped
to active individual cancellation, exact partial preservation and an unaffected
sibling's later successful operation. Full work completion, exact wait duration
and synthesis remain unaccepted.

The earlier 8ffb6e27-ca19-427a-977c-f05ca4b166f3 readiness attempt is failed history:
Alpha completed early without submitting its requested ms90000 native wait,
while Beta remained active. Alpha's final answer admitted that omission. No
active Alpha Stop acceptance is derived from that earlier attempt. The separate
fb9bc378 attempt in real-individual-stop-acceptance.md preserved an already-done
sibling; this new run supplies the previously missing post-Stop fresh operation.

Root reports human draft setup Stopping Alpha keeps Beta and this draft. at caret
8. No final draft/focus JSON or rendered Stop screenshot was independently
reviewed here; no continuous focus, draft persistence or rendered partial-state
claim follows from API evidence. Personal Mia Stop, group Stop, crash recovery,
queued permission changes and other retained contract gates remain separate.
No verifier display/API mutation, model call, secret access, product implementation
or unchanged suite rerun occurred.
