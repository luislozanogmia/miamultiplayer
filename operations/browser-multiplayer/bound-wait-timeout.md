# Bound native wait transport deadline

October 10, 2026, mia-dev-aws Linux. Documentation base
`994d3368b7da3e91a93abae9952cc66a9ad9dd7e`, integrating candidate
`ad58b5eac15488f622738e3b334ee7ec8123886f` from baseline
`b96ea5af7786685ddc0b484dca79f67e95290368`. This records a source-contract
repair and local automated evidence. The original actual 120-second wait
retest remains outstanding.

## Observed failure and source defect

The actual work in [active sibling Stop evidence](real-active-sibling-stop.md)
records Beta's bound `wait {ms:120000}` dispatch at 1791612344297, failed
status without a native `waited_ms` result, and a later successful fresh read
completed at 1791612466420. Alpha was individually stopped while Beta remained
active. The supplied final observation is
`/tmp/mia-bound-waits-final-observation.json`.

That record retains no precise transport error code or failure completion
timestamp. Beta's visible answer quotes the generic denial/interruption message.
The elapsed interval is consistent with the transport deadline race below;
it does **not** independently establish the exact cause of this actual failure
or prove that this wait completed. The historical failure remains a failure.

`macos/src/browser.cjs` normalizes native wait duration from `timeout ?? ms`,
with a 10000 ms fallback, integer truncation and bounds 0..120000 ms.
The baseline `backend/browser-work-desktop-client.js` also sets its HTTP socket
inactivity timeout to 120000 ms. A fully permitted maximum wait therefore has
no response margin before the client disconnects. This is a confirmed source
contract defect, reproduced at the local HTTP transport boundary.

The native and worker broker `server.requestTimeout = 30000` settings limit
receipt of incoming requests; they are not a 30-second response deadline for
these fully received requests. The plugin's HTTP timeout remains 180 seconds.
The coordinator records failed nonconsequential operations separately from
uncertain consequential operations; the repair does not change that policy.

## Bounded repair and preserved limits

Only desktop `execute` requests whose operation method is `wait` receive
`max(general timeout, normalized native wait + 15000 ms)`. Normalization matches
the native precedence, conversion, fallback and clamp. With the default general
timeout, the maximum wait response budget is 135000 ms. The margin covers a
final selector probe bounded to 10000 ms plus polling and response overhead.
Other methods, including validate/approve and consequential execution, retain
the general timeout. This is not a blanket timeout expansion.

Abort signals still destroy the request, close the bridge response and propagate
cancellation. There is no automatic retry; a disconnected consequential effect
may already have happened. The timeout error and conservative uncertain-write
classification remain unchanged.

A separate existing limitation remains explicit: native nonselector wait uses
a `setTimeout` promise without an abort listener to wake it early. Stop revokes
authority and the actor's post-operation check suppresses late results, but this
repair does not promptly reclaim that native timer. Local abort coverage proves
bridge request cancellation, not native timer wakeup or indefinite late-reply
safety. Selector waits check cancellation between probes.

## Verification classes

The focused command is:

```
node --test backend/browser-work-desktop-client.test.mjs macos/src/browser-work-broker.test.cjs macos/src/browser-work-dispatch.test.cjs
```

| Stage | Result | Evidence class |
|---|---|---|
| Baseline with new client regressions | 2 failed, 2 passed | Local HTTP timeout reproduction and timeout-budget observation; `/tmp/mia-bound-wait-baseline.log` |
| Candidate focused client/broker/dispatch | 9 passed, zero failures/skips | Local automated; `/tmp/mia-bound-wait-candidate.log` |
| Independent focused review/checks | 9 passed | Independent result reported by coordinating chat; this document does not claim a second builder observation |
| Root integrated focused checks at `994d336` | 9 passed | Root-reported integration checks |
| Original actual app/model 120-second wait retest | Unverified | Requires a fresh run after integration |

The delayed-response regression uses a real disposable loopback HTTP server
and reduced general timeout: the baseline disconnects with `OUTCOME_UNKNOWN`,
while the candidate receives the response without retry. Other checks preserve
non-wait write timeout and one request, observe Stop abort and request closure,
and inspect exact 120000 ms/default 135000 ms budget wiring, native precedence,
clamping and unchanged validation timeout. Budget observation does not replace
a real two-minute native/model wait. Diff and precommit checks pass.

No app, display, model, existing profile, process restart or credential value
access occurred in this repair/documentation lane. No push, main merge or
deployment occurred. Root must repeat the original literal wait and individual
Stop/sibling continuation flow in the actual integrated app, record a successful
native `waited_ms:120000` for the unstopped worker, and retain the separate stopped
partial and late-result observations. Full work synthesis, rendered state and
remaining fifteen-criterion acceptance gates require their own evidence.
