# Actual queued target replacement acceptance

October 10, 2026; mia-dev-aws Linux. Root exercised actual Mia UI with personal Mia and two DeepSeek Flash workers on separate synthetic loopback tabs. Loaded application behavior was ec7ffc90730acd94eae946de74a29d4fa284d625; documentation base was 97f50b330eab3d267f5f5170c5bd81a9b8f41ca9. No production Clerk/Router or real website acceptance is claimed.

## Bounded negative result

Work a33ece22-1328-4e41-adde-60550e486983 finished FAILED: Alpha worker1/tab2 FAILED, Beta worker0/tab3 DONE, all epochs0, no synthesis. Both independent bootstrap reads completed. Stored personal selection was deepseek/deepseek-flash/high.

The exact stored Alpha session20261010_054839_be6726 contains assistant row571 with two distinct direct mia_browser_work calls, eval and fill, in one tool-call array; row569 contains the bootstrap read. Root and independent reviewer queried only this session's assistant tool-call metadata from its profile state.db, never message content, reasoning or credential files.

Both normal UI Approve once decisions returned200. The eval was held inside one bounded fixture gate. At1791632929170 the separately consumed fill was dispatching behind the held head, with no native fill start or head settlement. Root released the gate only after that queue evidence.

The fixture settled1791632929172 and recorded one original-to-clone replacement1791632929193. Native eval completed and settled at1791632929198, then fill started and failed APPROVAL_TARGET_CHANGED at1791632929201. No native fill DONE occurred. The original node was disconnected; exactly one replacement #draft remained empty, with zero browser input events and zero server input events. Beta's other-tab read completed independently.

Head operation ab31f96a-17b8-4fea-b362-ce06ed9ccf2c is DONE with replaced:true/oldConnected:false. Fill be91b86e-5b7a-4b6f-895f-f711b2ceca6c remains UNCERTAIN and consequential; it was never retried, recovered or replayed. The three pre-existing uncertain-operation projections remained exact. This comparison does not establish whole-history equality.

## Failed controller retained

V3 manifest5b3c30c2fab76f13b7548c9cb1911964d7298b8c4ce0060ddb6241104ba9a968 and all11 source hashes were admitted before execution. Submit exited0. Driver29472 exited1 because the controller called native fetch Response.status as a function while constructing its release receipt, after r.ok had passed. The real release had already occurred. Independent source review missed this helper defect; the original failure is preserved, and the entire driver is not reported as passing.

Root separately executed the unchanged, independently reviewed read-only observe.cjs once, exit0. Its outcome and native/fixture/physical packets passed independent review, including an independent exact11-event log projection, both prefix hashes, operation/grant hashes, current work/fixture GETs and exact same-assistant batch metadata. No observer process-receipt artifact was saved; exit0 attribution is root command evidence.

V1's pre-Start form-readiness failure and V2's post-Start candidate-order assertion failure remain separate evidence. V2 work ff095066-4df2-4408-9b09-234248d25490 expired both approvals without eval/fill execution. V3 validates bot-to-tab associations without changing persisted group order [1,3,2]. No failed work was adopted or replayed.

## Evidence and limits

Private source and run packet: /home/mia/.codex/lane-checkpoints/criterion12-target-replacement-preparation-v3, prefix queue-target-20261010-b. Root admission: /tmp/mia-queue-target-b-v3-root-admission.json. Same-response metadata: /tmp/mia-queue-target-b-v3-alpha-batch-metadata.json. Root-owned fixture source is separately hash-verified; its nonce is queue-target-20261010-b.

Independent verdict: PASS for this actual queued-target negative case. The worker's1643-character partial remains incomplete/unverified, acknowledges unknown approval-card visibility and describes a synthetic fixture. This proves the exercised target revalidation and no-effect boundary, not full criteria12/15, continuous human focus, provider attestation or real website collaboration. Remaining finite document/group authority cases and combined Linux acceptance stay open.
