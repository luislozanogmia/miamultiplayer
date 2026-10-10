# Actual approval-repair attempt and changed-panel focus

October 10, 2026, mia-dev-aws. Actual disposable Linux app source c077ea8.
Work a8bdea08-520d-4eb6-aed3-f3bc6659bb88 used personal Mia and two independent
DeepSeek Flash workers through the bot UI. This is local provider/native UI
evidence, not production Clerk or Mia Router acceptance.

## Failed full-flow gate

The goal required each worker to read/vacuum, fill its exact acceptance text,
click Local click, read, scroll400, capture, navigate to ?review=2, attempt the
OLD numbered choice with its OLD snapshot, then take a fresh vacuum/read.
Mia was to combine only fresh ALPHA result17 and BETA result29 into46.

The final work and both workers were done, with thirteen done native operations,
four consumed approvals, one expired approval and one manually rejected approval.
Alpha completed navigation and fresh generation2 read17. Beta completed only
initial read/vacuum/fill; its Local click approval
with prefix 212b8439 expired during the panel focus observation. The full
approval identifier remains in the raw work record.

Root initially misidentified a subsequent click as Beta approval. The matching
consumed record instead belongs to Alpha navigation e31c9f4d. That correction
was sent to the independent reviewer. No Beta local click or final read is
claimed.

Alpha requested selector #local with its OLD snapshot instead of the requested
numbered choice. Root rejected card 757f94ac-cfb7-4509-800a-f25d8b078ea4 manually;
it did not execute. This is not a native STALE_SNAPSHOT denial and does not
exercise the new failed-approval settlement marker. Source investigation then
found the selector early return bypassed explicit snapshot checks. Its repair
and acceptance are separate work, not retrospective success for this run.

The complete 4598-character Mia synthesis refused46 because Beta lacked a
fresh result. Its descriptions of the manual rejection as the intended stale
outcome and of no selector mismatch overstate the evidence. Transport completion
does not satisfy the original goal. Preserve this failed candidate.

## Bounded changed-panel focus pass

Before and after snapshots /tmp/mia-real-changed-panel-{before,after}.json
show done-operation count7 changing to10 while the same Beta approval remained
pending. Independently reviewed corresponding PNGs show the same Beta Approve
control with its focus outline, tab3/actor/URL context and reading position,
while a new Alpha navigation approval appears below it. This proves control
focus and visible reading-position preservation across an actual changed
refresh. Context details remained closed; open-details preservation and
continuous human page focus are not established.

Beta expiry occurred after that bounded observation. It does not invalidate
the earlier panel observation, but prevents the full two-worker flow passing.
Human draft setup was Fresh results keep my draft intact., caret8. Root moved
focus deliberately for approval interaction; no continuous page-focus claim.

## Automated evidence limits

The joint c077ea8 approval/coordinator/client/broker/dispatch/UI command recorded
88 tests:87 pass,1 fail,0 skip in /tmp/mia-approval-settlement-integrated.log.
The failure was the existing refresh focus assertion. A focused follow-up
passed3/3 in /tmp/mia-approval-ui-focus-recheck.log. Five bounded diagnostic
runs passed (three baseline, two current); production focus code was unchanged.
The inline fixture ran during readyState loading without asserting its focus
precondition. That is a diagnostic lead, not an established failure cause.
No product fix or weakened assertion was justified; the original failed broad
run remains evidence. The actual changed-panel observation above is separate.

Next gate: integrate independently reviewed explicit-snapshot owner repair,
then exercise actual Approve on the stale request, observe prompt revoked
failurePhase approval and typed STALE_SNAPSHOT, and obtain both fresh results
and Mia's46 without letting valid approvals expire.
