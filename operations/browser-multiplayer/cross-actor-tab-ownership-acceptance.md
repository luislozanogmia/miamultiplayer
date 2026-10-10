# Actual cross-actor tab ownership and snapshot boundary

October 10, 2026, America/Monterrey; mia-dev-aws Linux. Documentation base `721b0a95aa5c473d2b2e4548a1e3f3b90cfcafa4`. Root executed the actual Mia UI and model runtime against a private synthetic local counter on tab 2. This lane inspected saved evidence only. Static Git and controller hashes are distinct from runtime import proof. The v4 readonly admission packet records no bound actors, human tab 1 selected, and target counter 0 before the controlled b trial.

## Controlled b trial: independently reviewed bounded PASS

| Gate | Actual saved evidence |
|---|---|
| Alpha owns tab 2 while waiting | Native bound sequence 13; wait starts sequence 20 at generation 1 |
| Competing Beta assignment | Native sequence 21, TAB_ALREADY_BOUND; Beta work FAILED, no operations |
| Exact normal UI Stop of Alpha | HTTP200; native cancellation sequence 22; Alpha worker CANCELLED at epoch 1 |
| New Beta after release | Distinct actor bound sequence 23, same tab/URL/generation 1 |
| Old Alpha snapshot used by new Beta | REVOKED/approval-phase STALE_SNAPSHOT; no linked click; counter remains 0 |
| New Beta's own fresh snapshot | Separate approval consumed, one linked DONE click; counter 1; requested read DONE |
| Terminal state | Fresh Beta worker/work DONE; personal Mia synthesis 3288 characters, complete/incomplete=false/verified=true |

Independent review matched all 25 scoped native events against the desktop log and approved this bounded chain. Eight driver child-exit packets and both pair phase exits record 0; preparation source hashes also matched. Earlier driver/watcher fields saying synthesis/review pending describe their capture time. The later stage packet, observed at `1791629782160`, already contains completed synthesis at `1791629722751`; terminal completion is no longer pending.

Alpha work `556afa64-d756-4d35-b830-4ff418e7cd41`, actor `83e2d8a5-815f-4157-b438-8c956bdf5d4b`, completed read and vacuum before its 100000 ms wait. Vacuum `5095be74-d22f-41c1-a347-fb72b3a921f0` returned S `3ed6d4f3-e3bf-41ac-94c8-8726f3df763e`, generation 1 and actual choice 2 mapped to `#local`. This proof was frozen while Alpha's wait was active.

Competing Beta work `e9a6943b-f53d-4a96-be95-3b05cf294b09`, actor `02a6ed86-63b4-4b37-95d2-000275a0f24c`, was denied TAB_ALREADY_BOUND during that wait and recorded no native operations. The UI Stop then cancelled Alpha. Its work is FAILED, its worker CANCELLED/epoch 1, and its wait operation FAILED; these distinct statuses are preserved. Independent review verified matching owned interrupt `fdef18ec` acknowledged at `1791629640063` with interrupted terminal at `1791629640163`. Provider halt is not established. The old wait only settles later at native sequence 37, without a post-Stop DONE event.

Fresh Beta work `bdb09ccf-1cc2-4f4a-9493-e44b0ba4c86c`, actor `e12faa69-7ef2-4575-9dfc-a9626c7c6e38`, bound the released tab at the same generation 1. A captured bootstrap read precedes the old-target negative; no Beta vacuum precedes it. This actual sequence must not be described as having no intervening read. Approval `05fb0dc5-22b5-4f25-8c48-037f39e4f5d6` requests only choice 2 and old S, without optional URL/generation preconditions. Exact UI approval returns HTTP500/accept=true/bodyCode=null. Durable metadata is REVOKED, failurePhase=approval, denialCode=STALE_SNAPSHOT, no linked operation; physical counter remains 0. HTTP500 alone is not denial proof, and the classification gap remains unresolved.

Only after definite denial, Beta vacuum `468fd9c3-1bb8-4e00-b5c1-2854d2e63bc0` returns its own T `62fdf1b7-0faa-430b-b3bc-04fc56de8c72`, choice 2 at generation 1. Approval `8eb82f41-9e61-453f-8cb6-0f852e38e87c` uses that exact T without another read/vacuum before the click. UI HTTP200, consumed grant and linked DONE click `bcb49f96-6fca-4f3a-b66c-594735a14533` corroborate one execution, native sequences 30–32. Physical counter reaches 1 and post-click read is DONE.

## Reporting improvement and remaining limits

The integrated trusted denial projection is consumed in this actual personal Mia synthesis: it explicitly cites failurePhase=approval and denialCode=STALE_SNAPSHOT as the native pre-execution reason, without inferring the reason from revoked status alone. This is bounded live reporting evidence for that projection. Mia correctly leaves exact snapshot parameters and page effects unverified in its metadata-only view; separately collected controller/physical evidence corroborates the bounded mapping and counter result.

The worker still falsely says the fresh click required no approval card. Personal Mia does not explicitly flag that claim, so clean reporting acceptance remains unproved despite stored complete/verified flags. No human draft/caret/focus packet was found for this b trial; neither point nor continuous human focus is claimed. This controlled Alpha interruption does not establish personal Mia Stop, provider halt, every ownership/snapshot negative, or full criteria 3, 9, 12, personal 13 and 15.

## Earlier a failure and provenance

The a watcher EXIT1 remains a failed observation attempt. Saved `/tmp/mia-crossactor-20261010-a-readonly-competition.json` corroborates a competing bind denial, but Alpha subsequently finishes normally. No Stop or reassignment was exercised in a. The successful b trial does not retroactively repair that watcher or replace its history.

Evidence: `/tmp/mia-crossactor-v4-readonly-admission.json`, `/tmp/mia-crossactor-20261010-b-stage.json`, `/tmp/mia-crossactor-20261010-b-driver-*`, and `/tmp/mia-actual-cross-actor-bdb09ccf-1cc2-4f4a-9493-e44b0ba4c86c-*` retain admission, phase exits, actual mappings, UI responses, physical counter observations, final work and native events. Pair helper SHA256 is `0d95733319d4caacab92b7e86b3139b90e829875edb43174e3ac671dd60bb1d1`. Private packets and capability values are not copied into this public repository.

No runtime actions, suites or replays were performed by this documentation lane. Next material action is independent review of this immutable docs candidate, then root's remaining actual acceptance gates and reporting correction.
