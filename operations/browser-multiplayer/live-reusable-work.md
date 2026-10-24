# Actual saved-step export and retargeted execution

Observed October 9, 2026 on mia-dev-aws. The live app was launched from
`8b50f9f`; subsequent integrated parameter validation requires a new app run.
This is synthetic local Linux acceptance, not production or native Mac/Windows
acceptance.

Root manually clicked **Save reusable steps** for completed Beta worker 0 in
work `8d12dd7f-3923-42ce-9961-8a074edb2948`. The stored reference
`e2a25ed5-83e5-4a81-bfd6-0f9b5eeb9165` contains exactly one read operation
with empty parameters. Its proof references native operation
`15b9ae02-9758-49da-bc94-2f8d8d6b3d4a`; ownership and group are retained.

Root clicked **Choose tab for saved steps**, assigned Alpha to tab 2 with
DeepSeek Flash, explicitly selected that saved reference in the tab's dropdown,
entered a read-only reuse goal, and clicked **Ask Mia to plan and start**.
Personal Mia also had Flash selected. The saved source read Beta's result 29;
the new assigned target is Alpha's page with result 17.

Work `10015722-9ff2-45cd-aa0f-e52aa1a6b6dd` finished done. It retains the exact
source/reference assignment and records fresh native reads
`4dc6c5b8-3f96-4e15-bea4-c8e2fb9d4f2b` and
`82630cfa-035c-41d6-97ef-b29c23de4514`, plus vacuum
`5402392f-f737-4241-82a5-73e57d8cd908`, on tab 2 / document generation 1.
The returned current page is Worker Alpha / ALPHA result 17. The visible worker
answer reports calling run_reusable with the exact reference; the rendered Mia
synthesis reports current Alpha data and does not claim a mutation. The human
tab remained selected with its draft visible.

Local screenshots: `/tmp/mia-reusable-selected.png` shows the manually selected
saved reference; `/tmp/mia-reusable-done-ui.png` shows rendered final synthesis.
These temporary artifacts are not portable repository assets.

Limits: native operation records currently lack an explicit replay/source link.
Fresh reads and the assigned reference prove current target execution, but the
worker's claim alone does not independently identify which read came from
run_reusable. The coordination lane is adding bounded authoritative provenance.
Mia's synthesis also lacks the trusted method-only saved-step definition and
therefore says the steps might be read-only; the stored definition establishes
that they are. Restart persistence of this reference and a fresh post-fix
actual UI replay remain required. No uncertain write replay was exercised.
Criterion 14 is advanced, not complete. No push, merge, release or deployment
occurred.
