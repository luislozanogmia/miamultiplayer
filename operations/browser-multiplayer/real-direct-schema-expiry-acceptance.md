# Real direct-schema approval and expiry attempts

October 10, 2026, America/Monterrey; mia-dev-aws Linux. Both attempts used the actual local Mia UI, personal Mia and two DeepSeek Flash workers, with Alpha bound to tab2 and Beta to tab3. They targeted private synthetic loopback pages, not a customer website. Root reports appPID759252 loaded source5c8217b (direct worker schema8037a35 plus expiry guard5c8217b) and the separately prepared scheduler runtime described in real-model-queue-first-attempt.md. Documentation baseb013410 includes a later snapshot change; it was not loaded for these attempts. Read-only packet inspection cannot independently establish process import origins.

## Frozen outcomes

| Gate | 913a invalid expression | 427a valid expression |
|---|---|---|
| Two direct requests reach separate approval cards concurrently | Two pending cards in readiness packet | Two pending cards in readiness packet |
| Human approval permits native eval head | Unexecuted; root caught invalid expression before approval | Consumed eval approval links to native DONE eval |
| Fill admitted while eval is held; physical fill after head settlement | Not exercised | Not exercised: fill never approved, no fill operation |
| Expiry does not convert earlier read proof into verified completion | Alpha FAILED, partial/read proof retained | Alpha FAILED despite completed read/eval |
| Beta completes independently | DONE, read/wait/read stored | DONE, read/wait/read stored |
| Matching user Stop/owned interruption terminal | Not established | Not exercised |
| Full requested goal/personal synthesis | Incomplete; no synthesis | Incomplete; no synthesis |

Separate approval cards establish direct-tool admission beyond the earlier deferred-wrapper mismatch. They do not prove native mutation queue overlap. These are bounded actual model/UI/native observations with synthetic page effects; they do not close criteria6,13 or15 of the full contract.

## Attempt 913a: invalid expression, no approval

Work913a8267-be38-43fa-8df7-c0511ce6f898 requested one Alpha read17 followed by concurrent direct eval/fill requests and Beta read29/wait40000/fresh read. The eval expression ended with `};`, whereas native eval wraps an expression. Root identified the prompt error before approving it. No native syntax rejection is claimed, because the eval never dispatched.

Readiness records approval5bd2ec3a-a819-4923-af87-ef8c7a8f000b (eval) and8636d8a0-b40b-4511-a814-61912a585ea8 (fill), both pending at work/worker epoch0. Both later became EXPIRED. No eval or fill operation record exists; the16 normalized native events contain only read/wait operations plus actor binding/cleanup. Root separately reports fixture gate attempts0 and no effects.

Alpha is FAILED with1399 characters of retained partial output, result incomplete/unverified, and read proof f9fa0dd3-4a39-442a-823d-a8dda1a35fc7. Beta is DONE with1023 characters, verified read proofs54c17c89-73ce-427e-afdd-7482e63c46ae and3d2541e2-eaeb-4e1e-b1c2-842c1a45b9f6 plus completed waitc260ad6b-c505-4abe-bc8f-6588e3e4ac4a. Beta's full result and all four operation records compare exactly across readiness, final and the authorized read-only GET. No personal synthesis exists.

Root clicked Alpha Stop near the deadline, then corrected its initial interpretation: stored work and both workers remain epoch0, Alpha FAILED rather than cancelled, approvals EXPIRED rather than pending-to-revoked. Coordinator Stop increments the targeted worker epoch even when terminal. Thus no accepted Stop mutation is established in these packets. The filename `invalid-head-stopped` is an artifact label only. Native `cancelled` actor events also occur on ordinary worker cleanup and do not establish user Stop, owned message interruption or provider halt.

Sources: /tmp/mia-direct-queue-invalid-head-readiness.json, /tmp/mia-direct-queue-invalid-head-stopped.json, /tmp/mia-direct-queue-invalid-head-readonly-current.json and /tmp/mia-direct-queue-invalid-native-events.json. Root UI observations are separately attributed; these packets do not prove the clicked control's network request.

## Attempt 427a: valid approved head, unapproved tail

Work427a17f2-d68b-4bed-ab97-7b76e4865344 used a valid expression ending with `}`, for runqueue-success-20261010-c. Readiness contains eval approvalf0244eda-fa6c-46ed-9b2c-86add8e8be7b and fill approval980d76fe-df13-447f-8f2b-7277be04113e, both pending. Root's grounded UI helper approved the eval head. The head-held packet shows its approval CONSUMED, eval412a9dba-96fb-4097-b90c-e4fbb77891e4 DISPATCHING and fill still PENDING.

Normalized native events bind Alpha actor512dd5a4-ae1c-4110-b96b-a824993a47e9 to tab2/task1. Native eval starts1791621465017 and finishes/settles1791621473035. The operation record links the same eval approval and reaches DONE at1791621473037, returning gateSettled=true/released=false. Fixture HTTP entry1791621465031 is separately captured with attempts1, settled=null and effects[]. Root reports the fixture automatically settled at1791621473031 after8seconds, released=false/effects0. HTTP fixture settlement and native eval settlement are distinct observations, four milliseconds apart.

Root reports the layout shifted the fill approval offscreen and the grounded helper aborted because it could not recognize the button. It did not approve fill. The existing helper source is mutable and was inspected after the run; it is not an immutable at-run controller capture. Before/tail PNGs are observation artifacts, not proof of a click or a continuous focus guarantee. The final fill card is EXPIRED, with no linked fill operation and no native fill event in the19 normalized events. A completed eval head alone cannot establish tail admission, serialization or overlap.

Final work is FAILED, epoch0; Alpha FAILED with918 characters of retained partial output, incomplete/unverified and native read proof63254c17-42d4-4a9c-bf66-07c2f55a4df1. The DONE eval remains stored as native evidence but does not waive the unexecuted fill. Beta is DONE with398 characters and read proofs696329ac-6903-428f-af76-b51c3a10b9a5 and75dd87fb-e8e3-488b-91bd-fede4265ba9e, plus completed waite93cfd05-cd8b-4a5e-b80e-6137c1895f47. The final-failed packet and authorized current GET preserve Beta's completed result, operation records and approval statuses exactly. Beta's readiness result was still in progress, so equality with readiness is not claimed. No personal synthesis exists.

Sources: /tmp/mia-direct-queue-queue-success-20261010-c-readiness.json, /tmp/mia-direct-queue-queue-success-20261010-c-head-held.json (nested work.work), /tmp/mia-valid-direct-queue-head-only.json, /tmp/mia-valid-direct-queue-final-failed.json, /tmp/mia-direct-queue-valid-native-events.json, and head-before/tail-before PNGs for runqueue-success-20261010-c. Helper abort/layout and final fixture settlement are root-supplied observations; no saved stdout or final fixture packet was available to this document builder at freeze time.

## Inspection and remaining gate

The builder performed only authorized exact-work GETs at API4972 and inspected saved packets/native event JSON. Frozen current packets and post-inspection SHA256 manifest are private under /home/mia/.codex/lane-checkpoints/direct-expiry-evidence; this is a post-run evidence freeze, not at-run immutable source provenance. The older line-prefixed native-events file yielded zero parsed JSON rows; it is not absence-of-events evidence. The normalized16/19-row JSON files supply native evidence instead. No raw model reasoning, profile configuration, credentials or page bodies are included here. No product/runtime/UI changes or test reruns were performed for this document.

Next gate remains a fresh, valid, independently reviewed UI approval sequence that captures fill admission while the eval is still held, then native head settlement before fill start and exact physical fill effect. User Stop correlation, owned terminal evidence, human focus preservation, production authentication, macOS/Windows and full MVP acceptance remain separate gates. Do not replay these expired requests or rewrite their history.
