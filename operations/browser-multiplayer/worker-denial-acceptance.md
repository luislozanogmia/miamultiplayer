# Bound worker denial category evidence

October 10, 2026, America/Monterrey. Baseline `d5d74545e4c35abb22e931e18c09f537e7f44bfb`,
candidate `5fc475b68858540d119fcdbbeb9874df81918c4d`, integrated source
`bd8125cbe2d2d8dafc127c44de5586363e148577`. Implementation changes only the
worker plugin and focused Python tests. This document records local and
integrated automated evidence, not actual model stale/navigation acceptance.

## Problem and bounded output

Native errors carry `code` through the desktop client and worker broker. The
baseline plugin caught every exception and returned a generic denial, so a
worker could not distinguish a stale snapshot from revoked ownership. Native
code emission and propagation were reviewed in source; simulated HTTP failures
exercise the registered plugin boundary, not the actual browser owner.

The HTTPError handler reads at most 4097 bytes and discards bodies over 4096.
It parses only the nested JSON `error.code` and maps exact strings to this fixed
allowlist:

| Category | Source-emitted codes |
|---|---|
| Snapshot/document/target | `STALE_SNAPSHOT`, `TAB_NAVIGATED`, `ELEMENT_NOT_FOUND` |
| Assignment/tab/session | `ACTOR_REVOKED`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `TAB_CRASHED`, `WORKER_SESSION_REVOKED` |
| Approval/interruption | `APPROVAL_REQUIRED`, `APPROVAL_TARGET_CHANGED`, `CANCELLED` |

Native categories come from `macos/src/browser.cjs` and `browser-actors.cjs`;
`WORKER_SESSION_REVOKED` comes from the worker broker's missing-session check.
The plugin returns the static code with the unchanged message:
“Bound browser operation denied or interrupted. Check Mia's task status; do not
repeat uncertain writes.” It forwards no broker message, raw body, arbitrary
code, parameters, URLs, result text or capability. HTTP error responses close
after the bounded read.

Unknown codes, malformed JSON, non-string codes, oversized or unreadable bodies,
and non-HTTP/network exceptions retain exactly the generic response. Absent
native code `STALE_ELEMENT`, transport `ABORT_ERR`/`OUTCOME_UNKNOWN`, and fallback
`WORKER_OPERATION_FAILED` are not promoted to categories. No retry, permission,
schema or tool change is introduced. A denial code does not prove a
consequential effect was undone or grant authority to retry it.

## Evidence classes

| Stage | Result | Provenance |
|---|---|---|
| Baseline focused, mocked HTTP errors | Five test methods, 14 failed subchecks: missing categories/bounded reads | `/tmp/mia-worker-denials-baseline.log` |
| Baseline pinned registry, loopback HTTP | Fails first known-code assertion using the baseline plugin with new tests | `/tmp/mia-worker-denials-registry-baseline.log` |
| Candidate focused | Five methods pass, including exact limit, unknown/private/malformed/oversized/unreadable/network negatives and no broker access for invalid operations | `/tmp/mia-worker-denials-candidate.log` |
| Candidate actual pinned registry/policy | Pass: static codes cross registered dispatch; tool policy, runtime-injected identity, aliases and capability scrub retained | `/tmp/mia-worker-denials-registry.log` |
| Independent candidate review/checks | Source review plus both focused and pinned registry checks pass | `/tmp/mia-worker-denials-independent.log`, `/tmp/mia-worker-denials-registry-independent.log` |
| Integrated checks | Root reports focused five methods and pinned registry pass on `bd8125c` using its designated dependency runner | Root-provided integration evidence |

Builder and independent checks verified clean pinned Hermes HEAD
`eeb220d40c2fb6cb33d61a9b792ca68811408b3a` at `/tmp/mia-browser-work-pinned`.
They used bundled `/opt/miaos/python/bin/python3.11` with its installed dependency
path. Root's integrated checks used the designated dependency runner
`/home/mia/.local/share/miamultiplayer-pr39/hermes/hermes-agent/venv/bin/python`.
Tests create synthetic disposable profiles and use synthetic capabilities;
they do not inspect existing profiles or credential stores or call a provider.
Compilation, diff and precommit checks pass. Logs are local temporary evidence
and may expire. No unchanged passing product suite was rerun for this document.

## Outstanding actual gate

Root reports restarting the disposable app on `bd8125c`. Restart alone does not
establish that an actual worker consumed the new plugin or received a truthful
native denial. Root must run the authorized actual Mia UI/model navigation and
stale-target flow, observe the appropriate static code in worker tool output,
confirm no forbidden retry/effect, and independently record stored results and
rendered UI. Criteria 9/12 and the remaining full MVP lifecycle gates stay open
until their own evidence is recorded. No live model, production or other-platform
acceptance is claimed by this handoff.
