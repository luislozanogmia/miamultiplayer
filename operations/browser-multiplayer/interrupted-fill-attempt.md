# Unexpected interruption during the shorter fill flow

October 9, 2026, mia-dev-aws Linux. Documentation-only evidence handoff based
on `d8ebcb72a6903ce042af34383f09a4ad93454b97`. Work
`e6061d12-90e0-47ce-acb1-abb0d1b6f49b` requested two independent assigned
bots to read/vacuum, fill with fresh approval, verify the value, scroll 400,
and capture screenshots. The requested flow did not complete.

Root reports starting the actual Mia UI flow, manually approving Beta fill
grant `83cfdc16-7fe9-4baa-8c71-e1d009f13098`, then seeing app execution
session 3039 exit with code 0 during wheel navigation. Root observed API 4972
connection refusal and a black display, then resumed the same disposable
profile in execution session 61380. These process/UI/restart observations are
root-provided, not independently witnessed by verification. The exit cause is
unknown; no intentional Stop, crash trigger, or diagnosis is inferred.

After the API returned, verification independently inspected authorized
synthetic work records. Work and both workers are `waiting_for_user`, at epoch
1. Alpha's pending fill grant `722c3b81-a293-4d63-8acb-e30442554f4c` is revoked,
with no fill dispatch record. Beta grant `83cfdc16` remains consumed and linked
to done fill `6870c222-1487-47c4-89f1-0db40da8cc00`, whose native result reports
`Beta acceptance` in the input. Subsequent Beta reads/vacuum are also done.

All eight stored native operations are done at original work/worker epochs
0/0: Alpha read/vacuum; Beta read/vacuum/fill/read/vacuum/read. They are retained
prior-attempt evidence, not current epoch-1 completion proof. There are zero
dispatching or uncertain operations. No scroll, screenshot or navigation
operation is recorded for this work, and no personal Mia synthesis is present.
Alpha's 295-character partial response is retained as incomplete and unverified
at origin epochs 0/0. No completed Beta result is recorded.

This shows persisted interruption state and partial text after root's reported
same-profile restart. The Beta fill had already been recorded done, so this
does not exercise a crash while a consequential native operation remains
dispatching, nor establish crash-after-write uncertainty or replay prevention.
No durable external write effect is inferred from a native input fill.

Independent inspection of `/tmp/mia-resumed-interrupted.png` shows group names
Mia review and Mia bot workspace, selected Mia bot workspace, tab order Human /
Beta / Alpha, and Human selected. The human page's draft input is empty.
Root reports page navigation during restoration; the screenshot does not
promise unsaved draft persistence or establish why the input is empty. No
continuous focus, exact native IDs, or full recovery flow is claimed from those
pixels alone.

Verification performed no app or display-100 operation, model call, credential
inspection, recovery mutation, or suite rerun. The next action belongs to root:
use shorter fresh flows with timely approvals, and conduct the separately
authorized controlled pending-write interruption gate with explicit dispatch
and durable-effect observations. This unexpected exit cannot substitute for it.
