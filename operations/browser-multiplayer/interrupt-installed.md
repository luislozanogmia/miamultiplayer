# Installed synthetic interruption transport

This fixture traverses the actual gateway client, Hermes adapter and browser work
coordinator against the installed patched Hermes runtime. It is separate from
actual Linux UI acceptance and real provider acceptance. It never establishes a
remote provider's physical compute halt.

Run with Node 22 from the repository root:

```sh
node operations/browser-multiplayer/interrupt-installed.mjs
```

The script uses the workstation's installed Hermes path declared at its top. It
creates a disposable home and named profile, dynamic loopback gateway/provider
ports and an indefinitely streaming synthetic HTTP provider. Gateway environment
variables are explicitly whitelisted; current home, provider credentials and
app/profile state are not inherited. Memory and auxiliary title generation are
disabled in the fresh profile. A disposable Python `sitecustomize` guard rejects
non-loopback `socket.connect`, `connect_ex` and `getaddrinfo` calls, including
Python children. It does not cover `sendto`, other DNS APIs, native code or
non-Python subprocesses and is not an operating-system network sandbox. The fake provider
emits text only, never tool calls, and records no request headers or bodies.

Acceptance requires one owned live personal synthesis turn with nonempty partial
text before Stop, immediate cancelled/incomplete state, a receipt acknowledgement
and separately correlated interrupted terminal event for that captured live
session, local HTTP stream closure before teardown, and unchanged retained
partial text and completed worker inputs. Completed worker inputs are preloaded
synthetic data, not evidence that workers or browser operations executed. There
must be exactly one streaming HTTP request. `providerHalt` stays
`not_established`.

Reports and runtime logs remain in a private disposable directory outside the
repository. Reports contain bounded sanitized metadata and hashes, not text or
credential values. Cleanup closes the client, terminates only the fixture-created
process group and destroys its local sockets. The report records cleanup start
and requested process-group termination, not independent process-exit or cleared-port
confirmation. No shared acceptance service is
discovered, stopped or restarted.

Source base: `be4c8f4755834e509e612e8340eb1bb8951ecbda`. Installed Hermes:
`eeb220d40c2fb6cb33d61a9b792ca68811408b3a` with eight local runtime patches. This
is an installed patched checkout, not a pristine pinned commit. Initial attempt reached a live partial
and stream closure but failed the single-request assertion: two HTTP streams were
observed. It remains inconclusive. Runtime source supports auxiliary title
generation as a possible explanation; the first attempt did not independently
classify the second request. A fresh attempt with title generation explicitly
disabled passed the single-request assertion and the remaining acceptance
checks. Exact-session and teardown timing assertions were then added for the
third execution. Private attempt reports are retained independently.

Independent review accepted the third execution's bounded transport chain. Its
report lacks installed file hashes; a separate private audit-time provenance
snapshot records modified tracked runtime paths and hashes, app module hashes
and final fixture hashes. That snapshot is post-run evidence, not a retroactive
at-run source freeze. The final fixture adds hashes to future reports and narrows
failure categories to a fixed allowlist. Those additive reporting changes were
source reviewed and syntax checked; the passing transport was not rerun.

This bounded result does not close overall multiplayer acceptance, prove real
worker execution, prove rendered UI behavior, or establish remote compute halt.
