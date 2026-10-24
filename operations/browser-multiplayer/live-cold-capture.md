# Actual cold hidden capture and canonical scroll

October 9, 2026, mia-dev-aws, integrated app source `83c8454`, pinned Electron
44.2 and Hermes. Root quit the disposable app (confirmed process exit), resumed
the same isolated profile, and manually started work through the Mia bot UI.
Neither worker tab was selected in this app incarnation. Human tab 1 remained
selected. This repeats the actual Beta CAPTURE_UNAVAILABLE failure path.

Work `710bbc4b-9447-4160-9f88-23b203bdade3` finished done. Requested personal
Mia and both workers used DeepSeek Flash; independent narrow runtime session
metadata confirms Flash / DeepSeek for personal `20261009_230855_c16930`,
Alpha `20261009_230906_f65b22`, and Beta `20261009_230906_d3d55d`.

Current native screenshot operations `95151318-18cc-46bc-a3a8-d6c2e62f8eca`
(Beta/tab 3) and `c05ffde6-d87a-4325-b9d5-64459a46637d` (Alpha/tab 2) both
succeeded at generation 1. Independently inspected images show the assigned
green Beta/result29 and red Alpha/result17 pages, never the blue human page.
Both are 1440x900, matching the hidden page viewport. Actual native page owner
borders and labelled working motes are visible. Target regions are not exercised
by reads/screenshots and remain a separate criterion 11 gate.

Beta operation `d52f8779-080b-43ca-9b88-427162c54b8a` used canonical
`direction: down, amount: 400`; native result reports exactly 400. A subsequent
read-only native DOM observation records Beta scrollY400, viewport1440x900 and
visibility hidden. This establishes current position, not an independently
sampled pre/post physical delta. The corrected parameter contract is consumed
by an actual worker; the earlier deltaY/default500 run remains failed evidence.

Root manually entered `Cold capture keeps my draft and caret.` and restored
caret8/focus before the final observations. Saved current-run observation
`/tmp/mia-cold-real-current-focus.json` reports selected human1, full draft,
selectionStart/End8, activeElement draft and focused true. UI setup actions
temporarily took focus, so continuous focus throughout every setup interaction
is not claimed. The final actual UI rendered Mia's completed capture/scroll
synthesis and its verification limits.

Temporary images: `/tmp/mia-cold-real-tab-2.png`,
`/tmp/mia-cold-real-tab-3.png`, `/tmp/mia-cold-real-final-ui.png`. Independent
review matched saved image hashes to native API bytes. Screenshot pixels are
separate from model interpretation; Mia did not independently inspect pixels.

The previously exported saved reference `e2a25ed5-83e5-4a81-bfd6-0f9b5eeb9165`
survived this restart with its exact read-only operation and source proof.
Explicit replay linkage and post-provenance-fix UI replay remain open.
Integrated focused native checks pass56/56; frontend/presence checks pass13/13;
pinned Hermes plugin parameter checks pass. Sandbox and keyring encryption
remain enabled. No production Router, Mac/Windows, release or deployment proof
is inferred. No push or main merge occurred.
