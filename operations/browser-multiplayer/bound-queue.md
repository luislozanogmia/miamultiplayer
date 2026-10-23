# Concurrent registered worker bound-path queue harness

October 10, 2026, mia-dev-aws Linux. Source base
`8e36af959743c905b06e2199a5fd70006d9483f2`; pinned Hermes
`eeb220d40c2fb6cb33d61a9b792ca68811408b3a`; sandboxed Electron 44.2.0.
This is local integrated production-module evidence with **harness-injected
concurrent callers and a scripted gateway**. It is not real-model parallel
execution, manual Mia UI, production Clerk authorization or full MVP acceptance.
No production implementation, Hermes scheduler or tool policy is changed.

## Why a harness is required

Hermes' pinned `agent/tool_dispatch_helpers.py` admits only its fixed safe tool
names, scoped filesystem tools and opted-in MCP tools for parallel dispatch.
`mia_browser_work` is a plain plugin outside those classes. Multiple calls in
one model response therefore run sequentially, even with different arguments.
The registry synchronously invokes its plugin handler, which waits on the
worker broker response. Two ordinary model calls cannot overlap in the native
queue. Browser `wait` is also not a serialized mutation. Separate bots,
dependencies and approval waiting must not be substituted for the same-actor
queue gate.

## Exercised authority chain

The harness uses the pinned `model_tools.handle_function_call` hooks/middleware
and registry, the production Mia plugin copied by the production profile
provisioner, and these unmodified modules:

```
registered worker session
  -> browser-work-worker-broker
  -> browser-work-coordinator + AES-GCM browser-work-store
  -> browser-work-desktop-client
  -> native browser-work-broker + browser-work-dispatch
  -> browser.work.execute + browser-actors queue
```

The normal Hermes adapter creates/binds/registers synthetic sessions before the
scripted gateway holds each turn open. A fresh disposable worker profile has
only the bound tool; the pinned driver checks its actual CLI policy. Two driver
threads inject calls for the same runtime session through the registered tool.
Worker requests cannot choose actor/tab/owner or approvals. A second worker
session binds Beta's different tab. Group/bot authorization and gateway output
are synthetic dependencies explicitly supplied by this standalone harness;
`backend/server.js`, the full frontend and a provider are not started.

Approvals and Stop call the real coordinator methods programmatically. Native
human-view selection uses the owned disposable window, whose actual focused
state is checked. These are harness actions, not manual app interactions.
All exercised worker operations use the chain above. Direct native protocol
calls are limited to fixture setup/reset/tab selection; a direct read-only
WebContents observation reads physical scroll/input state without joining the
mutation queue. It never grants execution authority.

The synthetic head is an approved native `eval` awaiting a loopback response.
The fixture hard-releases each received gate within 3000 ms, below the native
10000 ms script bound. Its head only finishes a synthetic marker, or replaces
a synthetic input in the target-change case. Keys/capabilities are random,
in-memory bootstrap data passed through private stdin; their values are never
printed or written. The work store uses actual encrypted persistence, mode0600,
and is reopened with the same in-process key. Three pages and all profiles are
fresh temporary data. No existing profile, credential value, model or app is used.

## Recorded results

`/tmp/mia-bound-queue-pass.log` exits 0 and records five passing cases. Native
events carry monotonically increasing sequence numbers plus timestamps. The
raw JSON includes before/after physical observations and each native start,
done/error/settled event, separate from broker receipt and coordinator dispatch.

| Case | Observation and negative assertion |
|---|---|
| Same actor overlapping mutations | While Alpha eval is actually running, Alpha scroll is coordinator-dispatching but has no native start; physical scrollY0 and no scroll-command effect. Beta read completes at sequence12 before Alpha eval settles17. Alpha scroll starts18, after head settlement, completes once, physically reaches400, and records exactly one scrollBy command. |
| Stop and fresh binding | Stop Alpha while head is running and scroll queued. Old queued scroll never starts, scrollY remains0, dispatched consequential head retains uncertain status. Beta remains epoch0 and performs another successful read. After head settles and old work is stopped, a new work/new actor scroll succeeds to400. No undo or prompt native task reclamation is claimed. |
| Queued human-view permission | Hidden-tab scroll is already queued; selecting/focusing that native tab before head release produces plugin code APPROVAL_REQUIRED, no scroll start and physical scrollY0. This is dispatch-time revalidation, not an approval wait used as queue evidence. |
| Consumed grant target replacement | Local fill's actual grant is consumed and fill is queued while head runs. The head replaces the approved input; fill returns APPROVAL_TARGET_CHANGED, input remains empty and no input effect is observed. Backend correctly retains uncertain consequential status; absent fixture effect does not grant retry permission. |
| Encrypted persistence | AES-GCM envelope, mode0600, and exact JSON-serializable store round trip pass. JSON normalization excludes transient undefined properties, as production serialization does. |

The explicit negative control in `/tmp/mia-bound-queue-negative.log` exits 1.
With `MIA_TEST_NEGATIVE_QUEUE=1`, the harness replaces the actor factory's
serialization call **in memory only** with immediate execution. It does not
edit source files. The native trace then has eval start5, scroll start11 and
scroll settled13, before eval settled19. The required queued dispatch cannot
remain pending and the assertion fails. This proves the harness detects an
owner that bypasses serialization; it is not a failing historical product SHA.

Both logs record identical harness SHA256
`4d15bc4c00b5f4aab8ddfba323703e168bd2a64b767bb4b032d8953ebb094708`
and a driver hash. Earlier harness-development failures are retained locally,
including a queue-joining observer, hidden scroll-event delivery assumptions,
and comparison of transient undefined fields. None is labeled a product
regression or passing acceptance. Physical scroll and delegated scroll-command
count replace dependence on hidden-page scroll event delivery.

## Reproduction and limits

Use a separately reserved empty display, the pinned Electron binary and pinned
Hermes source, with isolated Python dependencies:

```
DISPLAY=:101 MIA_TEST_SOURCE=/path/to/reviewed/source \
MIA_TEST_HERMES_SOURCE=/tmp/mia-browser-work-pinned \
MIA_TEST_PYTHONPATH=/opt/miaos/hermes/venv/lib/python3.11/site-packages \
/path/to/pinned/electron operations/browser-multiplayer/bound-queue.cjs
```

The default Python is `/opt/miaos/python/bin/python3.11`; override with
`MIA_TEST_PYTHON` if required. `MIA_TEST_NEGATIVE_QUEUE=1` runs the deliberately
failing control. Do not run against an existing app/profile or reuse its
capabilities. DISPLAY100 remains root-owned. The harness stops its own brokers,
driver and native window, then removes its own temporary root.

These results supplement criterion6's bound-path evidence and selected queued
permission/target checks. They do not close the frozen actual UI/model gates.
Real model same-worker overlapping native mutations remain unavailable through
the current sequential scheduler. Actual app/model navigation, viewed-tab
approval, snapshot lifecycle, full presence cleanup and remaining UI acceptance
require their own evidence. No general timeout, approval authority, uncertain
write policy or retry behavior was changed. No push, main merge or deployment
occurred. Independent review and integration remain separate from this builder run.
