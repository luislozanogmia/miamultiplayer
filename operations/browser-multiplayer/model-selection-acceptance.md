# Explicit personal model selection evidence

Reviewed integration source: `340bee86c0064f68b1682c9883e4b67bed1da6b4`.
Coordinator candidate: `207db6a061c1bce270b117fa0e3798c2e26829f3`.
Independent regression: `model-selection-evidence.test.mjs`.

The regression fails on baseline `1411df2`: the work record drops the explicit
personal model selection. It passes against the coordinator candidate and the
integrated source. With scripted transports, chosen personal `deepseek-flash`
reaches planning and synthesis despite the resolver's first/default
`deepseek-pro`; worker selection remains separate. The personal pair survives
encrypted-store reopen and recovery. Untrusted profile/session fields are
stripped, another owner cannot recover the work, and later resolver drift to
Pro rejects before any additional model dispatch.

Independent execution against the integrated source also passes 16 existing
UI/resolver tests. Read-only review confirms the UI requires an explicit
personal choice, the server refreshes connected inventory and validates the
requested pair, and the coordinator checks option retention before planning,
creation, start and synthesis. Root's separate integrated focused test log at
`/tmp/mia-flash-selection-integrated.log` reports 56 PASS / 0 FAIL.

These are local scripted checks, not real Hermes/model evidence. A direct
DeepSeek READY reply and a connected Flash inventory entry alone do not prove
that the planner, workers and synthesis dispatched Flash.

Root prepared the actual new isolated Mia app's native browser with a human
tab and separate disposable loopback Alpha/Beta tabs, plus two fresh worker
bots. Actual model acceptance must establish selected Flash in runtime
dispatch/session metadata, successful current native reads on each assigned
tab, stored real worker replies, and personal Mia synthesis using both replies.
The human selection, unfinished draft and caret must remain preserved. Root
owns those app/fixture mutations to avoid concurrent lane changes. This lane
did not read credentials or authentication files, call a model, restart either
app, or mutate those native tabs. Actual model and manual UI acceptance were
pending when this evidence was recorded; the desktop lock still blocks manual
interaction, while the new local app's connection is available for automation.
