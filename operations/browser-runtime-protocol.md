# Browser multiplayer runtime candidate

Acceptance authority: `operations/browser-multiplayer-mvp.md` in the integration tree. Base: `0eb6c0ba7cfa8f49788355468c04a1d33968d0c7`. This lane implements the native browser owner; integration transport, actual pinned Hermes and product acceptance remain root-owned.

## Trusted main-process integration

`createBrowser()` returns `state()`, `work: {execute, validate, actors}` and equivalent top-level `execute`, `validate`, `actors` aliases. These are main-process methods, not renderer/page capabilities.

- `actors.bind({actorId,botId,tabId,groupId,ownerId,taskId,...metadata})`: numeric tab ID, one live assignment per actor, bot and tab. A competing tab claim from any work or owner fails with `TAB_ALREADY_BOUND`; revocation releases the claim. `taskId` defaults to `workId` if omitted; the broker should set it explicitly (worker ID is accepted). Group membership is rechecked on each dispatch. Metadata may include `botName`, `color`, `ownerColor` for native presence.
- `execute(binding, {method,params}, {signal,approval} = {})`: trusted broker passes the current assignment, never a model-selected binding. Supplied actor/tab conflicts are denied. Owner/task/bot/group/tab identity is checked before an internal unforgeable actor capability is injected. Direct `protocol()` calls carrying `actor_id` are denied.
- `validate(binding,operation)`: returns `{documentGeneration,url,requiresApproval,document_generation,needs_approval,tab_id,actor_id}`. This is preflight only; execution revalidates after the per-tab queue wait. The caller must bind the document generation and expected URL from preflight into its approval decision; it must not approve a newer document using an old user decision.
- **Await** `actors.approve({actorId,ownerId,method,params,expiresAt?})`. Params must exactly match the execution operation, with trusted `actor_id` and numeric `tab_id` injected. Only an authenticated owner's accepted decision may call this method. It returns `{approval_id,expires_at}`; pass that opaque token as execute's `approval` string or `{approval_id}`. Backend approval objects alone grant no permission. Approval expires within five minutes (default one minute), binds assignment token/document generation/URL/full operation, and is consumed once before execution. Click/fill approval pins actual node identity and a content fingerprint in isolated world 1001. Changed/replaced nodes fail closed.
- `actors.reject(approval_id)` deletes the grant; `actors.revoke(actorId)` cancels the assignment and approvals. Revoke on Stop/session termination/owner revocation. Running renderer mutations must settle before later same-tab mutations: cancellation cannot undo an already dispatched write. Pending work revalidates and cannot write after revocation; late completed results are denied.
- `actors.list()` returns public bindings plus actual `status` (`idle`, `working`, `failed`), excluding assignment tokens. Bindings are deliberately not restored after restart; root must recover durable work safely before rebinding.

Root must authenticate and map each Hermes session to its trusted binding before calling execute. A shared global browser token or page/model-provided actor ID is insufficient authority. Keep the existing personal Mia agent's legacy browser path separate from bounded worker dispatch. This module creates no model runtime.

## Browser operations and safety

Actor operations require one explicit assigned tab. They never switch/open human tabs, open local files, or send native keys. Read, vacuum, targeted fill, scroll, navigation, screenshot and wait use assigned WebContents. Click, eval, close and explicitly consequential actions require approval; all mutations to a currently viewed tab also require approval. A read-only vacuum remains permitted on the viewed tab. `human_ok` has no effect. For text entry, workers use targeted fill. Automated popup requests are denied while an operation is running.

`vacuum` returns `snapshot_id` and `document_generation`. Numbered click/fill must provide the actor's current `snapshot_id`. Snapshot identity is scoped to actor/tab/document; reread replaces only that actor's snapshot. Main-frame and SPA navigation invalidate it. Isolated-world node references plus fingerprints reject removed, replaced or changed targets, rather than re-resolving old selectors to a different node. Renderer crash and close fail with typed errors.

Screenshots use assigned `webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})`; no human tab/window capture or selection occurs. Four bounded attempts allow initial compositor surface readiness. Each attempt and returned pixels are generation-checked. Missing surface returns `CAPTURE_UNAVAILABLE`, empty pixels are denied, loading pages return `CAPTURE_NOT_READY`. A wholly hidden native host window can lack a display surface on Linux; it is not substituted with human pixels.

The shared per-tab queue serializes both personal protocol mutations and worker mutations; different tabs progress independently. Read operations can progress during waits. Rendering-script timeout is ten seconds, and load/element waits check cancellation. A timed-out dispatched page script may have an uncertain outcome: coordinator must hold it, not replay it as an ordinary safe retry.

## UI and groups

State includes `groups`, `selectedGroupId`, `ownership` and `actors` alongside legacy tabs/activeId. Group snapshots are persisted with version-2 tab state; legacy state still loads. IPC actions are `group-create {name}`, `group-rename {groupId,name}`, `group-select {groupId}`, `group-reorder {groupIds}`, `group-move-tab {id,groupId,index?}`, `group-remove {groupId}`. Empty selected groups keep activeId null across restart. `browser-groups.cjs` is supplied by the groups lane and must be integrated before this commit.

Actual lifecycle events go to `miaos-browser-actor-event` and optional `options.onActorEvent`: `bound`, `cancelled`, `operation-start`, `target`, `operation-done`, `operation-error`, `operation-settled`. Fields include actorId/tabId/taskId and method/generation/code when applicable; target contains viewport `{x,y,width,height}` from the actual acted-on element. `operation-settled` releases internal in-flight accounting, including cancelled operations, and does not imply success. Native page presence is decorative, pointer-events none: bot mote, owner ring, trusted label/status and actual target rectangle. Page markers never grant permission.

## Evidence and mandatory criteria

Starting status for every contract criterion was unknown. Before this candidate, static inspection established active-tab routing for most methods, shared vacuum elements, native key focus and no actor authority; the new trusted-actor tests cannot pass that baseline because the API is absent.

| Contract criterion | Candidate evidence / remaining acceptance |
|---|---|
|1 groups|Mocked owner-restart tests pass, including empty selected group; independent real Electron disposable owner restart passes. Actual Mia close/restart remains root acceptance.|
|3 binding|Mocked negative tests and independent real Electron owner/tab/actor spoof tests pass; authenticated Hermes transport integration still required.|
|6 concurrency|Mocked independent-tab progress, same-tab settlement and Stop tests pass; real model concurrent progress remains unverified.|
|7 background actions|Mocked focus/tab checks and independent real Electron read/fill/scroll with human draft/caret pass; real model navigation/click flow still required.|
|8 human protection|Mocked current approval and focus checks pass; real Electron draft/caret preservation passes. Manual Mia shared-tab approval UX remains unverified.|
|9 snapshots|Mocked actor reread/navigation tests and real Electron cross-actor, reread and DOM replacement denials pass.|
|10 capture|Mocked explicit target/retry/generation tests pass; independent real Electron hidden worker red/green pixel checks pass with visible host. Wholly hidden host surface is unavailable and fails typed.|
|11 presence|Native owner emits and renders actual status/mote/ring/target; manual product visual acceptance remains unverified.|
|12 approval|Mocked exact operation/reject/replay/generation tests pass; real Electron independently counted exactly one approved disposable POST, rejected changes/reuse/navigation. Integrated owner approval UX remains unverified.|
|13 Stop|Mocked revocation/queued/late-result denials and real Electron actor revocation pass. Durable partial result/restart replay policy belongs to coordinator and is unverified here.|
|2,4,5,14,15|Not satisfied by this runtime lane. Actual pinned Hermes, personal synthesis, durable outputs and Linux three-tab/two-bot product flow require root integration and final acceptance.|

Local automated checks: `node --test macos/src/browser-actors.test.cjs macos/src/browser.test.cjs macos/src/browser-attachment-auth.test.cjs` (50 passing); syntax and diff checks. Independent local actual Electron evidence is verifier commit `b0c7d9f`, `operations/browser-multiplayer/native-smoke.cjs`, running against this candidate tree. These are disposable native fixtures, not manual integrated Mia UI or live model proof. No push, main merge, release, deployment, infrastructure or real-data schema migration occurred.
