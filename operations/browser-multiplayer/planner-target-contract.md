# Planner candidate target contract

October 10, 2026, mia-dev-aws. Actual work9aabc6c8-876f-449d-81fa-c0306aa831dc
exposed swapped Alpha/Beta goal prose with otherwise correct authoritative
candidate IDs and tab bindings. Both workers retained their real boundaries and
flagged the mismatch; their fresh17/29 and Mia46 evidence remain valid for that
bounded path. The delegation wording defect remains failed history.

The source owner mapped IDs correctly. Its planner contract returned only
id/goal/needs and omitted server-resolved bot names from candidate inventory.
The model's internal cause is not known. Candidate4eaa06d, based2056016 and
integrated e750ca0, adds authoritative botName and explicit immutable
id/botId/tabId association to planning input. Output must echo the exact string
candidate ID and numeric tabId. Missing, unknown, duplicate or mismatched tuples
are rejected before work creation, browser binding or work persistence. Target
echoes are consistency checks, not model-supplied execution authority.

Reversed valid output order, dependencies and exact goal literals remain valid.
Direct creation, existing stored work and reusable paths are unchanged. Four
backend planning fixtures and the authorized model-selection fixture were
updated for the required tabId. There are no prose heuristics, remapping,
fallbacks, retries, expanded tools or provider changes.

## Evidence and limits

- Same focused regressions on baseline:3 pass,9 fail. Candidate:12/12 pass.
- Builder coordinator/model-selection suite:74/74 pass,0 skip.
- Independent immutable candidate review and focused suite:74/74 pass,0 skip.
- Root integrated coordinator/model-selection suite:74/74 pass,0 skip,
  /tmp/mia-planner-target-integrated.log.
- Independent personal-options checks:4 pass. Separate server registration
  initially failed before readiness because the new checkout lacked dotenv.
  An ignored pinned dependency symlink allowed the single server check to pass;
  the initial environmental failure is retained separately.
- Root dependency-ready integrated server/personal-options suite:5/5 pass,
 0 skip, /tmp/mia-planner-target-compatibility-integrated.log. Its disposable
  server child used a test-only https://mia-test.invalid/callback redirect to
  avoid the existing live app callback listener. Source and auth gates were
  unchanged; this is local registration/auth coverage, not Router sign-in.

The fix cannot mechanically verify arbitrary goal prose. A fresh actual planner
run must still show that each generated goal agrees with its bot/tab binding,
then execute through the actual bot UI and synthesize current results. The live
disposable app remains on2056016 until that controlled restart and acceptance;
e750ca0 is integrated source, not yet live UI acceptance. Full15 remains open.
