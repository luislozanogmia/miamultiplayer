# Independent actual cold capture review

Reviewed October 9, 2026 on mia-dev-aws Linux. Root reports restarting the
disposable app from integration `83c8454`, leaving human tab 1 selected and
neither worker tab selected during this run. Manual initiation/restart are
root-provided evidence; the checks below independently inspect stored native
operations, their exact image bytes, scoped runtime metadata, and supplied UI
observations. No verifier UI/model mutation or credential access occurred.

Work `710bbc4b-9447-4160-9f88-23b203bdade3` is done. Alpha worker 1/tab 2 and
Beta worker 0/tab 3 have current epoch 0/0, document generation 1 reads and
successful screenshots. Alpha capture `c05ffde6-d87a-4325-b9d5-64459a46637d`
and Beta capture `95151318-18cc-46bc-a3a8-d6c2e62f8eca` each report 1440x900.
SHA-256 comparisons confirm `/tmp/mia-cold-real-tab-2.png` and
`/tmp/mia-cold-real-tab-3.png` exactly match the native API image bytes.
Independent visual inspection shows red Worker Alpha/result 17 and green
Worker Beta/result 29, with distinct assigned-page content rather than human
page pixels. Both images visibly include the page ownership ring and the
correct working bot label/mote. Target-region behavior was not exercised.

Read-only SQLite queries restricted to known session IDs and model/provider/
counts confirm `deepseek-flash` / `deepseek`: Alpha
`20261009_230906_f65b22` (10 messages, 4 tools, 5 API calls), Beta
`20261009_230906_d3d55d` (12/5/6), and personal Mia
`20261009_230855_c16930` (4/0/2). These are real runtime session records,
separate from the earlier disposable native-owner probe.

Beta operation `d52f8779-080b-43ca-9b88-427162c54b8a` uses canonical
`scroll {direction: down, amount: 400}` and reports amount 400. Fresh read
`eab04818-08b2-40bd-b1b7-35ebf0923960` remains on Beta generation 1.
Root's current native observation `/tmp/mia-cold-real-current-focus.json`
reports Beta hidden, viewport 1440x900 and scrollY 400. This proves the observed
endpoint; without an independently recorded initial scrollY it does not
establish a measured 400-pixel delta.

That same observation reports active human tab 1, full draft
`Cold capture keeps my draft and caret.`, selection 8/8, active element draft,
and focused true. `/tmp/mia-cold-real-final-ui.png` independently shows human
selected, focused draft, and rendered final synthesis. The synthesis accurately
reports two assigned captures and the canonical scroll request, with caveats
about unmeasured physical movement and its own lack of pixel inspection.
These are current-run endpoint observations; they do not independently witness
every instant of human focus or the manual restart sequence.

The source work API also retains reusable reference
`e2a25ed5-83e5-4a81-bfd6-0f9b5eeb9165` after root's reported restart: one
read with empty parameters and its original source proof. This establishes
reference availability, not a fresh replay or explicit replay/source linkage.

Criterion 10's original actual cold Beta failure now passes for this exercised
Linux UI/model path, supported by the earlier independent never-selected native
probe. Criterion 11 gains actual page ring/mote pixels; target lifecycle remains
open. Criteria 7/8 gain canonical scroll and current focus evidence; broader
controls remain open. Reusable replay and authoritative approval synthesis
follow-up are separate gates. No full MVP or Mac/Windows acceptance is claimed.
Temporary artifacts remain local, outside the public repository.
