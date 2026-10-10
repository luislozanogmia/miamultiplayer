# Actual Linux Stop, recovery, focus and group restoration

October 9, 2026, America/Monterrey; isolated display `:100` and the same
disposable profile used by `flash-ui-acceptance.md`. Stop runtime `0dc774f`;
post-Stop restart and recovery runtime `8b50f9f`. No Clerk/Router claim.

Root manually started work `741e0178-620a-426b-aad4-c700646cab60` through the
Mia browser-work UI, requesting two read-only detailed worker explanations.
During actual worker execution, a manually typed human draft remained exactly
`Human draft stays intact during bot work.` with selection start/end 8,
active element `draft`, document focus true and native active tab 1.
Read-only DOM observations are `/tmp/mia-human-focus-before.json` and
`/tmp/mia-human-focus-during.json`; these probes did not set the draft or focus.

Clicking **Stop all work in this group** cancelled both real workers and
advanced the work epoch to 1. Visible partial answers (4,625 and 2,669
characters) remained stored, explicitly incomplete and unverified. The UI
rendered **Preserved answer**, **Stopped**, **Incomplete**, **Unverified**.
Later API observation found those retained results unchanged. Actual worker
sessions were `20261009_224744_40c47b` and `20261009_224744_bfaaf4`.

Root used the actual **Move selected tab to / Move tab** controls to append
Alpha tab 2 within its existing group, changing tab order from `[1,2,3]` to
`[1,3,2]`, with selected tab 2. Root quit via Ctrl+Q and observed the owned
app process exit 0, then reopened the same profile. The actual UI restored
group order **Mia review**, **Mia bot workspace**, tab order **Human**, **Beta**,
**Alpha**, and selected Alpha tab 2. The earlier restart separately restored
selected human tab 1. Empty Mia review retained null selected tab. Both group
IDs and all tab IDs were preserved. Dragging had failed in two earlier manual
attempts; this evidence establishes ordering through the existing move control,
not drag behavior. Legacy-state loading remains a separate existing test gate.

After that restart, the stopped work remained cancelled and its retained
results exactly matched `/tmp/mia-stop-work-observed.json`. Root selected the
human tab and clicked **Recover task with fresh page checks**. Recovery retained
one historical incomplete/unverified answer per worker, created fresh sessions
`20261009_225019_f7bd11` and `20261009_225019_7e8c5d`, and recorded new successful
native reads at work/worker epochs 2/2 before both workers and Mia finished.
The old epoch-0 reads remained history; they were not the new completion proof.
The recovered human draft `Recovered work keeps human control.` retained its
full value, caret 8, active element `draft`, and document focus through completion.
This does not assert unsaved page form data survives process restart.

Temporary actual UI screenshots: `/tmp/mia-stopped-ui.png`,
`/tmp/mia-recover-ui.png`, `/tmp/mia-tab-order-ui.png`,
`/tmp/mia-tab-order-restored.png`, `/tmp/mia-recovery-complete-ui.png`.
API/DOM/runtime observations supplement manual interactions; they do not
substitute for them. Individual-worker Stop, personal-Mia partial Stop,
approval UI and uncertain-write crash/replay were not exercised in this run.
