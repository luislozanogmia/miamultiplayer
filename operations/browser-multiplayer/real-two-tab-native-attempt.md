# Actual two-tab native sequence with stale approval waiting failure

October 10, 2026, mia-dev-aws Linux. Root reports disposable actual app source
bd8125c; later local wait-repair integration was not loaded during this run.
Verification independently observed synthetic localhost work API, inspected
root snapshots and viewed supplied worker capture pixels. Root performed actual
UI approval attempts; verification performed no app/display/API mutation,
model call, secret access, implementation or unchanged suite rerun.

Work a951a22e-17b9-4a03-abee-16151aae3706 has independent Alpha worker 1/tab 2
and Beta worker 0/tab 3, dependencies empty, epochs 0/0. Original goal requires
exact fill literals, selector click, scroll400, screenshot, navigation ?review=1,
one old numbered snapshot click denied as stale, fresh vacuum/read and a sum
using only fresh post-navigation numbers. Final API observation at
1791613033218 finds work done, both workers done and a complete 5090-character
personal Mia synthesis. These transport states are not semantic goal fulfillment.

## Independently established completed native steps

Each worker has exactly eight done native operations, sixteen total:
read, vacuum, fill, selector click, read, scroll, screenshot, navigate. Six
consumed approvals link to the matching fill/click/navigation operations.
No #write or native old numbered click appears. Alpha records before navigation
use generation 2; Beta uses generation 1.

| Worker | Consumed approval | Linked done operation |
|---|---|---|
| Alpha fill | 60b1b955-bb55-400e-b04a-4d0080c6c377 | b68b3d37-9754-44c6-8933-5c68af85d987 |
| Alpha selector click | fe306ec3-3e43-4b9c-bf59-8d48c8816514 | 5412653e-49ca-4e02-a106-09f8f5e924cc |
| Alpha navigation | 352ceeb0-4148-4707-96b6-0d9c48bf6095 | d4cc3950-6e3b-4c31-ad8d-1785b0203bea |
| Beta fill | 8c32ce47-ed2d-48b7-b4d0-df30fd5f6ab8 | 46a4712d-84d1-4b2d-915d-2e938d4ccd7c |
| Beta selector click | f4ffad8d-0343-4131-af77-8ba35df00c16 | 329de8aa-f6e0-4f3f-8e75-b2cfeed3bc7d |
| Beta navigation | a81d1c1e-0055-4d7f-8336-16908f37d897 | 6bfd4180-7e3a-4203-b22e-ce402b1653c5 |

Native fill results contain exactly Alpha acceptance and Beta acceptance.
Pre-navigation read results independently show ALPHA result 17 and BETA result
29 and each Local click counter changing 0 to 1. Body reads do not independently
verify textbox values; the fill results do. No post-fill vacuum is recorded.
Scroll parameters/results report down/400; no physical pre/post delta was
independently measured. Alpha navigate returns its ?review=1 URL/loading true;
Beta returns its ?review=1 URL/loading false. Neither is a fresh page-content read.

Independent viewing of /tmp/mia-a951-worker-1-capture.png (1000x433) and
/tmp/mia-a951-worker-0-capture.png (1440x900) shows correct red Alpha/green Beta
pages with ownership border and working badge. They are scrolled so numeric
result/form content is offscreen; pixels do not verify those values. Different
capture dimensions are recorded as observed, not silently normalized.

## Failed stale and post-navigation gates

Alpha's pre-navigation vacuum snapshot is 2e0c2fd8-5946-4e59-83a3-a603ba31b0b4;
Beta's is e0961698-684b-4bdb-a628-625ae9f78289. Both identify Local click as
choice 2. Post-navigation approval cards a0be645f-d81b-4f16-8441-ff70f737c148
(Alpha, generation 3) and 1eac908c-2c03-4a59-ac00-492a6895849f (Beta, generation
2) request choice 2 with those exact OLD snapshot IDs.

Root reports clicking each stale card's Approve once. Independent API
observations corroborate cards remaining pending, then expiring. Supplied
/tmp/mia-a951-stale-approval-attempts.json retains the earlier pending state.
No native old-snapshot click operation, explicit native STALE_SNAPSHOT denial,
final fresh vacuum or final fresh read was recorded. Worker output receives
generic denied/interrupted messages and reports those later steps incomplete.
Approval expiry proves the operation remained unexecuted, not the requested
coded stale rejection. The stale invalid-approval waiting defect is separate
from safe absence of native dispatch; root assigned coordination diagnosis.

## Final personal Mia synthesis and acceptance limits

The stored synthesis correctly restores the original literal task, counts sixteen
done operations/six consumed and two expired grants, and rejects worker prose
claiming execution bypassed approval. It explicitly says no fresh post-navigation
numbers exist and that 17 + 29 = 46 is only the pre-navigation sum, not fulfillment
of the fresh-number requirement. Exact values are conservatively unverified in
its metadata-only projection; verification separately established the native
fill/read results above.

However, its heading stale-click outcome as required and phrase compliant single
stale-click denial overstate the expired-card outcome. No coded stale rejection
reached the worker; no native stale attempt was recorded. The same synthesis
acknowledges the missing stale code and fresh reads, so its completed status
cannot close those failed gates. Both workers' complete/verified transport
labels likewise do not establish completion of all requested steps.

Root reports returning human tab 1 to exact draft Both bots work while I keep
this draft., caret 8, focused draft, scroll0 after approval interaction. This
is a root-provided endpoint observation, not independent continuous focus proof.
No final rendered synthesis or native focus JSON was independently inspected
for this handoff. Completed native actions and captures are bounded actual
evidence; truthful fresh-number synthesis is incomplete and coded stale-denial
acceptance remains failed/unverified. No full MVP or external production effect
acceptance is claimed. Preserve this candidate when reviewing the later fix.
