# Bound worker guidance review

Candidate: `187870c2d50c48fb480871f529a8b5a852584580`, clean isolated
`browser-worker-guidance` worktree, base `c84a396`. This review is candidate
preflight evidence, not integrated or live model error-reduction evidence.

Independent read-only review found no acceptance-blocking defect. The canonical
method enum matches existing native actor-supported operations, plus the
coordinator-owned `run_reusable` path. In particular, `stop` stops the assigned
page's loading; it is not permission to interrupt another worker. `eval` and
`tab_close` were already supported by native authority and still require
operation-bound human approval. Native keys and global controls (`tab_open`,
`tab_switch`, `tab_list`, `status`, `file_open`) are excluded. Previously free-form
method input already reached this authority; enumeration does not expand it.

Both the pre-tool guard and executor reject unsupported method names before
broker lookup/request. The executor returns a fixed correction and canonical
supported list without reflecting arbitrary model input or exception text.
Guard/executor permit one `ghost_` prefix for existing callers; the advertised
model schema remains canonical. Double prefixes fail closed. Worker prompts
and tool descriptions give explicit read/vacuum calls and current snapshot
guidance, retain untrusted-context language and approval boundaries, and warn
against repeating uncertain writes. No retry or permission is granted by the
correction.

Independently executed checks:

- Candidate coordinator suite: 35 PASS / 0 FAIL, recorded in
  `/tmp/mia-guidance-independent-node.log`.
- Candidate Python policy/registry test against clean pinned Hermes source
  `eeb220d40c2fb6cb33d61a9b792ca68811408b3a`: PASS, recorded in
  `/tmp/mia-guidance-independent-python.log`. It exercises registered schema,
  unknown denial without broker traffic, narrow CLI policy, capability scrub,
  runtime-injected IDs, read/vacuum/reusable dispatch and alias compatibility.
- Separate disposable native actor-boundary probe against integration
  `154c76bf9ac90824138d06d8ae2f64057fd1316e`: PASS. Unapproved eval/tab_close
  dispatches are denied, keys/global controls are denied, and assigned hidden
  tab stop retains its existing behavior. The probe invokes a disposable
  runtime object, not the live app.

Builder-provided logs also report baseline Node prompt and pinned registered
schema failures, then candidate success. Those are builder evidence, separate
from the independent executions above. Root must review/test combined source
after integration. Actual Flash runs must establish any reduction in
unsupported tool attempts; this review does not claim that outcome or close
any of the remaining fifteen-criterion UI/lifecycle gates. This lane read no
credentials, changed no live UI/runtime/model state and edited no implementation.
