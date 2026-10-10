# Actual exact native waits with page-number synthesis mismatch

October 10, 2026, mia-dev-aws Linux. Root reports supported restart of the
same disposable app profile on source 8e36af9, loading behavior repair 994d336.
Work 3b6ca46e-86df-44cd-a495-59f035289a32 has independent Flash Alpha worker
1/tab 2 and Beta worker 0/tab 3, no dependencies, current epochs 0/0. Root
started the actual UI run; verification independently read synthetic localhost
work API and viewed the supplied current UI screenshot. No verifier app/display,
model, API mutation, secret, implementation or unchanged suite rerun occurred.

Original task requires each worker to read, emit a preliminary finding, call
bound native wait with exactly ms120000, read fresh, then Mia combine the fresh
results and calculate their sum. Earlier e3c01 failed waits and 8ff omitted Alpha
wait remain failures in real-active-sibling-stop.md; this fresh success does not
erase those candidates.

Independent initial observation finds both workers working with visible
incomplete preliminary answers and native waits dispatching. Later independent
API establishes these actual native operation results, not elapsed time alone:

| Worker | Native wait | Started | Completed | Returned result |
|---|---|---|---|---|
| Alpha 1 | 23760b31-4cd8-4e1b-8c7e-664d90a97924 | 1791613110161 | 1791613230187 | waited_ms: 120000 |
| Beta 0 | 8572cefd-993e-4691-99e9-b484b9d6f58a | 1791613110783 | 1791613230802 | waited_ms: 120000 |

Both are done, read-only and at epochs 0/0. Durations are approximately 120026
and 120019 ms; native returned waited_ms120000 separately establishes the literal
value. Fresh Alpha read 7847eaa8 starts 1791613232361/completes1791613232385;
fresh Beta read b8c1fe7d starts1791613232753/completes1791613232775. Both follow
their completed waits, return assigned tabs at generation 1 and respectively
ALPHA result 17 and BETA result 29 from their ?review=1 pages. Six operations
are done, no approvals, mutations, Stop, retries or uncertain writes occur.
Actual exact-wait/fresh-read acceptance passes for this bounded Linux run.

## Final synthesis fails the requested page-result sum

Final independent observation at1791613293584 finds work done and both workers
done, with complete message.complete personal synthesis of2998 characters.
The synthesis cites linked done waits and fresh reads, correctly limits values
in its metadata-only projection, and acknowledges Alpha's reported current
page number2 is its tab ID rather than ALPHA result17. Nevertheless it computes
120000 +120000 =240000 ms and offers2 +29 =31 as an alternative. It does not
compute the requested fresh page-result sum17 +29 =46. This semantic mismatch
remains incomplete fulfillment despite complete/verified transport labels.
Verification's native read results independently establish17/29; the model's
conservative projection limits do not change those observations. No overall
Mia sum46 acceptance is claimed.

Root reports human draft Native waits keep my draft intact., caret8, focused
active draft at the endpoint and no refocus after initial setup. Independent
viewing of /tmp/mia-exact-wait-current-ui.png corroborates the human page and
focused draft prefix; the field clips the full value. This image displays a
historical stopped work card, not the current run's completed synthesis. No
continuous focus sampling, full value/caret verification from pixels, final
rendered sum or restart draft persistence is established. Actual native waits
and fresh reads are separate from the failed final arithmetic/task semantics.
Root owns the next explicit page-result disambiguation and fresh model retest;
no full fifteen-criterion MVP, external effect or other-platform pass follows.
