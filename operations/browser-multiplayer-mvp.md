# Browser multiplayer MVP acceptance contract

Base: 0eb6c0ba7cfa8f49788355468c04a1d33968d0c7. Canonical integration tree: browser-multiplayer-integration managed worktree. Development on mia-dev-aws Linux. Native Mac/Windows acceptance is separate. No push, merge into main, release or deployment is authorized. Local lane handoff commits and integration commits are authorized by the requested commits objective.

## Ownership and integration

1. Browser runtime owns macos/src/browser.cjs, focused runtime modules/tests, and protocol documentation. It exposes trusted browser command dispatch and actor-bound tab execution. Group persistence is supplied by lane 3; coordinate its API through this contract. Do not change main.cjs/preload.cjs/server.js/frontend app wiring.
2. Coordination owns new backend/browser-work*.js/.mjs, coordinator storage/runner/routes/tests and Hermes adapter modules, avoiding server.js/db.js until integration. Use existing pinned Hermes calls and owner-bound authorization. No parallel model runtime; preserve one personal Mia coordinator and distinct workers.
3. Groups/UI owns new macos/src/browser-groups.cjs plus tests and frontend/browser-work*.js/.css modules; frontend app.js/index.html/styles.css changes limited to group/status integration. Do not edit browser.cjs/main.cjs/preload.cjs/backend server.js. Publish exact integration hooks for root/runtime lane.
4. Verification owns acceptance evidence/test harness under operations/browser-multiplayer/ and tests, not implementation modules; independently challenge code and scope. No credentials or customer data in evidence.
Root owns shared contracts, startup/server wiring, integration order and final delivery. No shared writable worktrees.

## Cross-lane data contract

Group: {id,name,tabIds,selectedTabId}; preserve order, selected group and per-group selected tab across restart. Worker: {actorId,botId,tabId,groupId,ownerId}; actor binding is runtime-authoritative, not model-provided permission. Work: {id,ownerId,groupId,goal,status,workers,dependencies,results,approvals}; statuses queued,working,waiting_for_user,needs_approval,done,failed,cancelled. Operation carries actor_id,tab_id,snapshot_id when targeting a numbered element,expected_url and approval identity for consequential operations. Approval binds owner/task/actor/tab/document generation/operation and expires or invalidates when any changes. Untrusted page content never grants permission. No implicit active-tab fallback for actor calls.

## Acceptance criteria

Every row starts unknown; verifier records actual baseline and final evidence, including exact tests/runtime and recovery paths. Static/mocked/local/integrated/live are distinct.

| # | Criterion and must-pass evidence | Initial |
|---|---|---|
|1|Named groups persist names, order, active group and selected tab through restart; legacy tab state still loads.|unknown|
|2|User's Mia retains overall goal/group context/dependencies/results and is not represented as a worker bot.|unknown|
|3|One bot owns one explicit tab and bounded task; mismatched tab/actor requests are denied.|unknown|
|4|Worker model configuration reaches actual Hermes execution without silently replacing requested model.|unknown|
|5|Mia delegates dependent tasks and synthesizes actual stored worker results through Hermes.|unknown|
|6|Separate tabs progress concurrently; same-tab mutations serialize and cancellation releases queue.|unknown|
|7|Background read/click/fill/scroll/navigation operate on assigned tab without selecting human tab.|unknown|
|8|Human typing/view remains intact; disruptive shared-tab operations require current approval.|unknown|
|9|Element snapshots isolated by actor/tab/document; replaced or stale snapshots fail closed.|unknown|
|10|Hidden Electron tab screenshots are current and correct, never screenshots of active human tab.|unknown|
|11|Real execution renders status, bot motes, ownership rings and target region without fabricated progress.|unknown|
|12|Approval reject prevents execution; accept revalidates tab/target/identity/revocation before dispatch.|unknown|
|13|Stop cancels matching worker/group, preserves partial results, no stale post-stop reply or uncertain-write restart replay.|unknown|
|14|Outputs are durable and group/owner authorized; validated reusable work preserves proof and uncertain-write holds.|unknown|
|15|Actual Linux Mia UI: one human plus personal Mia coordinates two real bots across three tabs, combines results, preserves focus/groups through close/restart.|unknown|

## References

Mia Browser Use /home/mia/Documents/mia-browser at 15f59e5 (development branch differs from main; keep reusable provenance). Recovered design/mockup /home/mia/Documents/demo/mia-multiplayer-recovery-20261009/mia-multiplayer-export/. User engineering brief /home/mia/.codex/attachments/25b30584-4bbb-421c-b70f-8f3783a35ebc/mia_multiplayer_codex_engineering_prompt.md; current user bot-first decisions override older human-first milestone order. Local-only notes contain private evidence and must not be copied into public repository.
