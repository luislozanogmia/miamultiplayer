# Mounted local authorization and reusable-proof baseline

October 10, 2026, mia-dev-aws Linux. Production source base `1850d989cd758fb498efdea0d86b8622a9d22c66`; candidate changes only add this evidence document and `route-owner-fixture.cjs`. This is actual mounted backend/session authentication, encrypted persistence and native group-owner evidence with synthetic preloaded records. It is not real-model execution, manual UI, Clerk authentication, production customer authorization or completed reusable browser proof.

The bounded fixture ran on reserved DISPLAY102 after a process-environment check found no Electron/Node children there. It preserves the existing Xvfb, current DISPLAY100 app/profile and all other services. Electron uses a hidden sandboxed window, production browser/group/dispatch/broker modules and two fresh native groups. Node22 launches the unmodified server twice against one fixture-owned 0700 root. The backend environment is explicitly whitelisted: fresh HOME/workspace/database/runtime/Hermes/bots paths, loopback bind, `/dev/null` env file, test Clerk configuration and local profile, `MIAOS_NO_AUTH=0`. No Hermes launcher, argv, gateway endpoint or provider credential is inherited. Startup attempts cannot launch Hermes; no model turn is requested.

Production `db.openDb/createUser/createSession` creates an unusable-password synthetic local principal and an in-memory cookie. Production `createBrowserWorkStore.put` writes AES-GCM records with a random in-memory key; ciphertext is mode0600 and contains no result sentinel. Cookies, key and broker capability are passed internally and never included in evidence. All goals/results/proof records are fixture declarations. The foreign owner is a synthetic `.invalid` identity; no second real account is needed. Group-mismatch and reusable-owner-mismatch cases have explicitly synthetic matching operation/proof entries to avoid an earlier proof guard masking the tested condition. These entries establish no actual completed browser execution.

Requests traverse actual `server.js` registration: request boundary, `requireAuth`, cookie-only `requireInteractiveAuth` on POST, selection middleware, routes' `ownerFromRequest=req.userEmail`, then coordinator and encrypted store. Bodies omit model selections/candidates so inventory checks cannot mask authorization. Native `state` commands confirm that allowed local work reaches production group authorization. Foreign work ownership is denied before native state lookup. No route, owner resolver, coordinator or native dispatcher is replaced.

## Final matrix

Final execution report: `/tmp/mia-route-owner-9Dcuft/report.json`; launcher logs `/tmp/mia-route-owner-launch-_x00cpcv/`. Thirteen expectations pass; three fail. The fixture process exits normally after recording all results; its exit0 does not mean the matrix passed.

| Case | Actual observation |
|---|---|
| No cookie | Mounted401 unauthorized on both startups; separate matrix request401. |
| Own work/list | Own200 with exact own record; list excludes exact foreign result and foreign work ID. |
| Foreign results and spoofed owner | GET404; export POST404 despite body/query owner override; no foreign sentinel, native dispatch or store change. |
| Foreign reusable source |404 before native dispatch/store change. |
| Wrong source group |409 reusable proof unavailable after native group checks; synthetic matching proof isolates group condition. |
| Wrong reusable owner |409 after matching synthetic proof/native group checks; no store change. |
| Proof-free export |409 completed execution proof required; no store change. |
| Nonempty invalid proof |409 reusable proof unavailable; no store change. |
| Empty proof with read step |**FAIL**: passes reusable-proof admission and adds incomplete replay record; later409 worker is not executing prevents native execution. It is not a proof-boundary denial. |
| Empty proof and empty plan |**FAIL**:200 results[] adds a done replay with stepCount0 despite no execution proof. |
| Missing proof property |**FAIL**:500 generic request failure instead of intended bounded409; no store change. |
| Uncertain source |409 reusable proof unavailable; no store change. |
| Full backend restart | Own200, foreign404 and normalized encrypted state equality pass after a distinct server process. |

Both proof-admission failures leave durable replay state. Final total native execution dispatches is0; native operation event list is empty. Only native state lookups occur. This establishes absence of native execution in this bounded fixture, not absence of external effects in arbitrary tasks. Seeded terminal target workers are not executable, and startup recovery prevents preloaded active workers remaining live. The fixture does not manufacture a model turn to bypass that guard. Whether an empty-proof read can execute against a genuinely live worker remains unverified; the completed empty replay is already an observed proof-validation failure.

The script records per-request status/error, exact exposure assertions, native command/event deltas, normalized store hashes and replay records; source/fixture module hashes and declared seed hashes/provenance are captured before startup. Module hashes use SHA256 of JSON.stringify(Buffer), including its type/data representation, rather than conventional raw-file SHA256. Independent review recomputed all seven hashes with that encoding and matched the report. Current source inspection identifies `runReusable`'s `proof.some(...)` as accepting an empty proof without requiring a nonempty plan; missing proof throws before the bounded denial. No product repair was made.

## Preserved development attempts and cleanup

First report `/tmp/mia-route-owner-mX4njn/report.json` recorded13/3 but its sentinel substring matched the allowed `foreign-ref` record and the list assertion was incomplete. Second `/tmp/mia-route-owner-rFwM6w/report.json` recorded11/5 because an own-record assertion accidentally applied to names containing owner. Both also used invalid proof in the group/owner cases, so those attempts cannot isolate the intended later conditions. They are preserved as fixture-development evidence. The final execution fixes those controls and isolates owner/group guards; it does not change product source or erase proof failures. No unchanged passing suite was rerun.

Cleanup awaited both exact-owned backend exits, stopped its broker and destroyed its native window. Separate post-run `/tmp/mia-route-owner-9Dcuft/cleanup-audit.json` confirms both backend PIDs absent, its backend port closed and no Electron/Node children on DISPLAY102. Xvfb remains running. Private disposable roots are retained for independent review, including ciphertext/session database; they must never be committed. Public evidence contains no capability/session/key values or account data. Builder syntax check passed. Independent read-only source/raw review accepted the bounded baseline, confirmed13PASS/3FAIL and cleanup, and requested the hash-encoding clarification above; the reviewer did not execute the fixture. Frozen criterion14 remains incomplete because of the observed failures; criterion3/14 mounted local ownership observations do not close real UI/model or production auth acceptance.
