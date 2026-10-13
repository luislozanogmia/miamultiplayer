# Actual personal Mia Stop and restart preservation

October 10, 2026, mia-dev-aws Linux. Actual app source `2656430`; isolated local-profile authentication, DeepSeek Flash for personal Mia and both workers. This is not production Clerk/Router or native Mac/Windows acceptance.

## Actual interaction and stored evidence

Work `48161cd7-3739-4e1d-bac3-0b73803e4365` asked two tab-bound bots to read their own Alpha17 and Beta29 once, then personal Mia to compute17+29=46 and begin a1500-word explanation for the human to interrupt. Each worker completed one native read (two total) with stored results before the personal synthesis streamed. Its first paragraph contained46, but the explanation was deliberately interrupted and is not a completed final answer.

A fresh read-only guard established work working, both workers done and personal synthesis nonempty/incomplete before root clicked the actual Stop this task control. The pre-click capture contained7051 characters;11 additional characters arrived before Stop took effect. Stored stoppedAt1791616138537 retained7062 characters, status stopped, incomplete true, verified false. Text SHA256 is `94a52a6aa8409b9e5525e328a73cab1ddef683838bb916fa05e08940c7e3af74`. Current work epoch and synthesis counter advanced to1; retained synthesis evidence remains tagged workEpoch0/synthesisEpoch0. Both done worker results stayed exactly equal, with no new operations/retries/writes. Actual pixels show Mia Personal agent Preserved answer, Stopped/Incomplete/Unverified and the incomplete-context notice. Stop deliberately moves input focus; no continuous focus or unsaved-draft restart retention is claimed.

Independent read-only review observed the same stopped text/results after107765ms. Root subsequently measured489 seconds since Stop with the entire work still structurally equal to the first stopped snapshot and all works terminal. These are bounded app freeze/late-result rejection checks, not indefinite provider halt.

## Actual supported restart

Root stopped only mia-browser-mvp-acceptance.service, observed MainPID0/inactive, then relaunched the same isolated profile through its authorized launcher. Electron PID changed from725683 to730056. The whole stopped work and native tab_list are exactly structurally equal before/after restart, including both results, partial text, epochs and operation records. Actual restarted UI again renders the goal as Stopped and Mia Preserved answer with Stopped/Incomplete/Unverified tags. No Recover, new model turn or replay was requested. The unsaved human draft is empty after restart; that is not claimed as durable.

Raw local artifacts: `/tmp/mia-personal-stop-readiness.json`, `-after.json`, `-later.json`, `-pre-restart.json`, `-post-restart.json`, `/tmp/mia-personal-stop-tabs-pre-restart.json`, `-post-restart.json`, `/tmp/mia-personal-stopped-labels2.png`, `-labels3.png`, `/tmp/mia-personal-stop-restarted-header.png` and `-tags-final.png`. Prefixes on abbreviated filenames refer to the immediately preceding full prefix. Read-only native observations use the existing framed local bridge; no direct API Stop replaced the actual UI click.

## Hermes interruption remains unverified

Source diagnosis confirms matching live session ID propagation through coordinator, adapter and gateway interrupt RPC. There is no established wrong-profile defect. Both coordinator Stop and client abort discard interrupt promise errors; Stop does not record matching acknowledgement or terminal interrupted event. Pinned Hermes compute-host control delivery itself does not await child completion. A gateway acknowledgement would establish a control request, not remote-provider physical compute halt.

The personal session database has an assistant row8329 characters long, while the app froze7062. Its timestamp records row creation, not completion; finish_reason stop and null conversation end fields do not establish interruption timing. This could include queued/in-flight tail or a completion race; it does not prove RPC failure. Thus app preservation/restoration passes the exercised gate, while correlated Hermes interruption and subsequent recovery lifecycle remain open. A separate observability repair is assigned for regression and independent review.
