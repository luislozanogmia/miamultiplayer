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

Builder commits and integrated review are pending. Criteria 13/14's newly
expanded recoverable Stop behavior remain open. The real Hermes and manual UI
gates remain blocked by the locked DCV desktop and unconnected isolated profile.
Preserve the existing live app PID 627467 and its disposable profile; this lane
does not restart it or inspect credentials for this review.
