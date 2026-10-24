# Failed actual all-tools attempt

Observed October 9, 2026 on mia-dev-aws Linux. Documentation-only handoff
based on integration `98d0396936e2101415c599e0983cae8aee923a90`.
Root operated the disposable actual Mia UI; verification independently read
the authorized synthetic work API. Verification did not operate the UI, call
a model, inspect credentials, or rerun a test suite. This is actual stored
app/native execution evidence, not a passing fixture or full-flow acceptance.

Work `bbb6a070-5d71-4a96-aac0-9c28071c967c` requested both assigned bots to
read/vacuum, obtain approval for fill and a fresh numbered local click, wait,
scroll, screenshot, navigate with approval, then attempt exactly one old
snapshot click and report its stale denial. It also requested an integer sum.
The requested flow did not complete.

The API records six done native operations, all at work/worker epochs 0/0
and document generation 1:

| Worker / assigned tab | Completed operations |
|---|---|
| Alpha 1 / tab 2 | read `71a22915-fdff-443e-82b2-0fefa90b6cbc`; vacuum `ae8d441f-1df8-4534-bedf-fa07d6756278` |
| Beta 0 / tab 3 | read `f19556b3-b4e6-494b-abf0-17a8d8114085`; vacuum `23d1421b-1e98-47e5-96ad-91e51379229e`; fill `3e2cc8ec-4b61-4cd1-a95a-c52faf933629`; fresh vacuum `669a3361-c788-43e8-838c-439ffd05bf6a` |

Beta fill has an exact link to consumed grant
`c88141bd-6cb8-4259-9f84-8acfd46a18d2`. Its native result reports filled
true, input value `Beta acceptance`, and a target rectangle. The subsequent
vacuum independently records the textbox name `Beta acceptance`. This proves
the exercised native fill and subsequent page observation; no external or
durable write effect is inferred.

Alpha fill grant `fb986ee6-f031-4a55-bbe0-47c448688df4` expired. Beta's
numbered local-click grant `2b04046b-4dfd-4286-9f48-7bf5ca833c20` also expired.
Neither has a native dispatch record. These are expiration outcomes, not
explicit user rejections, successful actions, or stale-snapshot denials.

There are no native click, wait, scroll, screenshot or navigation records for
this work. No post-navigation read or old-snapshot click was reached. Worker
text reports generic bound-operation denials and additional denied calls;
that prose does not create execution proof. In particular, Alpha reports an
argument-validation failure and a later denied fill retry; no second fill
dispatch appears in the authoritative ledger. No `#write` operation is recorded.

Despite work/worker status done and complete verified synthesis metadata, the
visible stored worker text describes blocked/incomplete flows. Mia's final
stored synthesis explicitly states **not achieved**, distinguishes the one
consumed/done fill from two expired grants, and does not fabricate the requested
navigation, scroll, captures or stale denial. Its `total: 46` is expressly the
sum of the initial native read values Alpha 17 and Beta 29, not the requested
confirmed post-navigation total. Transport completion and minimum native-read
proof do not establish semantic completion of the requested goal.

This attempt advances only the exercised Beta fill observation and truthful
incomplete synthesis. It does not pass the two-bot all-tools flow, stale snapshot
gate, or stronger approval/recovery/focus/restart criteria. No rendered final
screenshot or continuous human focus was independently reviewed for this work.
Root's next action is a shorter fresh UI flow with timely approval handling;
the expired actions are not silently resumed or promoted to acceptance here.
