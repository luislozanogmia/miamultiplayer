# Actual rejection and asymmetric capture review

Reviewed synthetic work `ce745ad1-1c9b-4394-b626-c7996ba1e1fe` through read-only
isolated-app API inspection. Integration at review: `8475b70`. Root reports
actual UI initiation and Reject interaction; this lane did not perform them.

Independent observations:

- Approval `84e0a914-9375-414a-a107-1c0d29edc1fe` for Alpha's `click #write` is
  durably rejected. No native click operation is recorded for this work. Root
  observed Docker fixture `/evidence` at zero writes after rejecting. That
  counter observation is root-reported and belongs to the new Docker fixture
  incarnation on port 44177, whose baseline was zero before the decision. The
  earlier fixture process had exited; cumulative counters from that process
  cannot be substituted. This lane did not sample the counter during the
  decision window, and concurrent later acceptance work must be kept separate.
- Alpha worker 1/tab 2 has successful current-epoch read, vacuum and screenshot
  operations. Screenshot proof `34b61272-1eb0-42a3-98bc-8bb57eeea83d` corresponds
  to root's saved actual native image `/tmp/mia-actual-alpha-capture.png`.
  Independent visual inspection shows the red Alpha page and value 17,
  1000 by 693 pixels, rather than the human page.
- Beta worker 0/tab 3 has three failed screenshot operations
  (`5f6a5c8d-1939-4ebe-98bf-f19901056318`,
  `b3987c25-2a04-4512-8e12-a78e442778f5`,
  `05b9c729-21d9-4953-97c7-8178d7e9980c`). Its successful reads and scroll do
  not validate those captures. Root's assigned-tab native diagnostic reports
  `CAPTURE_UNAVAILABLE` on the cold-restored, never-selected hidden page. The
  runtime lane is preparing a separate fix/regression; no fix or Beta image
  acceptance is established here. No fallback image was supplied or accepted.
- Actual runtime metadata for Alpha `20261009_225311_ac6602` and Beta
  `20261009_225311_a26aea` confirms `deepseek-flash`, billing provider `deepseek`,
  through narrow read-only session queries, separate from requested options.

Two material limits must remain visible in claims:

1. Work and workers report done, and Beta's stored result has verified true /
   incomplete false, despite its visible answer explicitly reporting partial
   status and missing screenshot. The coordinator's minimum successful-read
   provenance gate is not semantic proof of the whole task. Mia's visible
   synthesis reports Goal status partial, but describes the capture failure as
   an owner/policy denial needing approval and says no retries, despite three
   durable failed captures. Native `CAPTURE_UNAVAILABLE` is not an approval
   denial; these model explanations do not override native evidence.
2. Beta scroll operation `b5abf940-43d0-446f-a975-08b9624b5c4d` sent
   `{deltaY:400}`. Native result reports down / amount 500. `browser.cjs`
   accepts `params.amount` and defaults to 500, so deltaY was ignored. No exact
   400-pixel movement is evidenced. Actual scroll position was not independently
   measured; this review records the command/result mismatch.

Criterion 10 remains open for cold-restored Beta capture. Rejection evidence
advances criterion 12 only for the exercised path; approve-once, target
revocation/revalidation and uncertain-write recovery require separate evidence.
This lane made no UI/API mutation, credential read, model call or deployment.
