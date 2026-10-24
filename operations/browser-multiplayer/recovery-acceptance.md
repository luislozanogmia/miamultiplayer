# Recoverable Stop acceptance addendum

Requested scope: preserve the original question and actual streamed visible
answer across Stop/restart, clearly label incomplete/unverified output, retain
prior attempt context during fresh recovery, and never reuse old completion
proof, approvals, native authority or uncertain writes. Personal Mia synthesis
is included. Turn budget and vendor reliability claims are outside this change.

Baseline implementation: `63082c87d489e121b6ab9e4f463fb023d6ef15fa`.
`recovery-evidence.test.mjs` independently exercises the actual coordinator and
encrypted store with scripted Hermes/browser transports. This is mocked/local
preflight evidence; there are no real model calls or manual UI interactions.

Three baseline regressions fail:

1. Worker `message.delta` text is discarded; Stop cannot preserve its actual
   streamed partial answer in the durable work record.
2. Personal Mia's streamed partial synthesis is not preserved at Stop.
3. A stale worker Stop can interrupt a running personal Mia synthesis without
   advancing the synthesis's epoch. Its late completion is then committed.

The regression uses pinned gateway event shape `message.delta` with `{text}`,
checks encrypted store reopen, and rejects late post-stop deltas/final replies.
Fresh recovery must carry the stopped answer as unverified context and use a
new worker session. A previous attempt's successful read cannot validate a new
model-only answer or permit synthesis. The original question and previous
answers must remain reviewable after recovery. If a stale Stop does interrupt
personal Mia, its late result must be suppressed; ignoring an already-completed
worker Stop without interrupting personal Mia is also consistent.

Run against a specific source tree:

```sh
MIA_TEST_SOURCE=/absolute/integration/tree node --test operations/browser-multiplayer/recovery-evidence.test.mjs
```

Integrated review source: `2572ef70455c37f087242d7df8eebb6147f275bd`,
including coordinator candidate `c7bef13c04fca101119617ab7c788fc66411f173`
and UI candidates `686bfd7fc8f8b2c926cfed1220c8d127b777375b` / `b5ac873`.

Independent local checks completed:

- All three regressions above PASS against that exact integrated source with
  Node 22.22.3. These use the actual coordinator and encrypted store, scripted
  transports, actual pinned gateway event shape, and disposable random keys.
- Independent UI projection assertions PASS: stopped/waiting personal Mia text
  is preserved with Incomplete labels and excluded from completed synthesis;
  all-done workers still expose explicit task recovery; any uncertain write
  blocks task recovery. Read-only rendering review confirms textContent use,
  original task context, and explicit fresh-session/page-check notice.
- Read-only coordinator review confirms bounded visible output (16,000
  characters), five retained attempts, three 2,000-character prior text entries
  per context kind; hidden reasoning/tool payloads are not captured. Recovery
  clears current sessions/results/errors, archives prior output as unverified
  context, and invalidates worker/synthesis generations. Owner/group checks and
  dependent uncertain-write holds remain in the recovery path.
- Root's integrated focused test log
  `/tmp/mia-recoverable-stop-integrated.log` reports 45 PASS / 0 FAIL. This is
  root-run local evidence inspected by this lane, separate from the three
  independently executed regressions and UI assertions.

The baseline failures are resolved in these local automated checks. Criteria
13/14's newly expanded behavior remains PARTIAL until actual Hermes interruption
and rendered UI acceptance are completed. The desktop remains locked and the
isolated profile unconnected; no real model calls, manual UI acceptance, push,
main merge, deployment, or release is established by this evidence. This lane
preserved the live app and its disposable profile without restarting it or
inspecting credentials. The next acceptance action is to unlock the DCV desktop
and connect a model in that isolated app, then exercise worker and personal Mia
Stop/recovery through the rendered UI.
