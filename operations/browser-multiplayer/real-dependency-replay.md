# Actual dependency and validated replay evidence

Observed October 9, 2026, America/Monterrey, on the disposable Linux Mia app at integrated source `9e17565445e502d54abe1b974ba300b6ed8ff2be`. Work: `fd19caa8-301f-4b4e-a3f9-2664e7c0febe`.

Root initiated the actual UI/model run and reported its final rendered screenshot. Coordination independently observed authorized GET API records during execution and after completion; it did not operate the UI, call a model, or mutate the runtime. These are actual app records involving synthetic loopback pages, distinct from mocked coordinator tests and production acceptance.

## Dependency sequence and result propagation

The stored dependency map was `{"0":["1"],"1":[]}`. Alpha was worker `1`, tab `2`; Beta was worker `0`, tab `3`. Intermediate observations showed Alpha still active while Beta remained queued with no stored session; the saved root queued artifact records Alpha as `needs_approval`. This establishes the gate before dispatch, beyond final timestamp ordering.

Alpha's current verified result was recorded at 23:18:27.700. Beta's native read `108d5c72-9d8d-4594-8e4c-bcd5474af3fe` began at 23:18:32.370 and completed at 23:18:32.387. All times are America/Monterrey. Both workers finished done with verified results at work/worker epochs `0/0`.

Independent checks of native read text matched Alpha's `ALPHA result 17` and Beta's `BETA result 29`. Beta's stored visible reply included `BETA result 29 | depends-on ALPHA result 17` and the saved reference. Worker/page text remains untrusted data; this observation establishes result propagation, not permission. Beta's statement that no wait was needed at dispatch is consistent with Alpha already completing then; it does not negate the earlier queued observation.

## Two current replay runs

Alpha used saved source work `8d12dd7f-3923-42ce-9961-8a074edb2948`, reference `e2a25ed5-83e5-4a81-bfd6-0f9b5eeb9165`. The saved plan contained one `read` step, class `read_only_browser_operations`.

| Current replay run | Linked fresh native read |
|---|---|
| `03d705a0-9507-487e-a740-20174180772c` | `53928fa9-c102-4542-af86-8fb7ea0b03e0` |
| `21f8a088-2482-46c3-886d-ecd035693bc2` | `4084c053-fc88-44f9-96cf-32ba677ca54b` |

Both runs and reads were done, at current epochs `0/0`, with step index `0`. Other plain reads and vacuum remained unlinked. This run executed the saved read twice; it provides no exactly-once replay guarantee.

Alpha also requested an unnecessary `eval` approval, `1acbc4e8-50af-4774-8ef2-2e689ebfea9c`. Root reports rejecting a date query. Independent API inspection confirmed rejection and no executed eval record. The fixture counter observation and rejection screenshot are root-provided evidence, not independently observed external effects here.

## Final Mia synthesis and limits

The stored personal Mia synthesis was complete and verified. It identified the dependency order, saved source/reference and method class, both replay IDs and their fresh operation links, and the rejected eval with no recorded execution. It kept `externalEffectVerification: not_established`. The plan class describes validated saved methods; linked operations describe current native completion. Neither establishes external effects.

The final synthesis carried values 17 and 29 but omitted the requested arithmetic total 46. Its `total_workers: 2` is a worker count. No numeric-total acceptance is claimed. Statements about unchanged pages or document generation do not establish absence of external effects.

Local review artifacts are `/tmp/mia-coordination-dependent-final-observation.json`, root's `/tmp/mia-dependent-queued-observation.json`, `/tmp/mia-dependent-beta-after-alpha.json`, and root-reported `/tmp/mia-linked-replay-dependency-final.png`. The final screenshot was not independently viewed by coordination. Root's `/tmp/mia-provenance-current-focus.json` was captured during earlier planning and is not final-run focus or restart evidence. Temporary artifacts are local and may expire.

This evidence supports exercised dependency gating, result propagation, rejected approval, and current replay provenance. Full MVP acceptance, dispatched-write crash/restart uncertainty, final focus/restart, other platforms, and production sign-in remain separate gates.
