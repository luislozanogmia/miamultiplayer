# Cold restored hidden screenshot regression

Base: 8475b70ad167ee844ea61adae77c21d45f302d1d. Target: pinned Electron
44.2 on mia-dev-aws Linux, isolated DISPLAY :101 and disposable profile.
This is local automated native-owner evidence, not manual Mia UI/model acceptance.

Frozen criterion 10 regression: restore three persisted tabs into a fresh
owner, select human, leave Beta never selected/shown/focused, and obtain current
Beta pixels without changing human selection, draft, DOM focus or caret.
Baseline actual owner failed `CAPTURE_UNAVAILABLE`. The candidate passes:
Beta green pixel RGB 217/255/223; after hidden DOM mutation, fresh blue pixel
0/0/255. Native Beta show/focus calls remain 0; page visibility remains hidden
with no visibilitychange events; sandbox remains enabled. No human capture fallback.

Electron's pinned capturePage implementation rejects an unavailable copyable
surface before requesting frames via IncrementCapturerCount. The hidden path
now requests a frame through that exact WebContents' exclusive debugger session.
See [pinned Electron implementation](https://github.com/electron/electron/blob/v44.2.0/shell/browser/api/electron_api_web_contents.cc#L3704).
The selected visible path retains capturePage. Protocol result and actor
identity contracts remain unchanged. Existing debugger ownership fails closed
with CAPTURE_BUSY; timeout, generation and output bounds remain enforced.

Run `cold-restore-capture.cjs` using the pinned Electron binary with DISPLAY=:101
and MIA_TEST_SOURCE pointing at this checkout. It creates and deletes its own
profile and loopback fixture. It does not use credentials, models or the live
Mia display. Focused native-owner/binding/attachment tests pass 56/56. Three
new mocked transport regressions fail 0/3 on baseline and pass on candidate:
assigned capture plus navigation invalidation; external debugger ownership plus
failure cleanup; concurrent captures serialized with distinct current frames.
Existing native-smoke passes all twelve outcome groups on the candidate,
including approval/queue/revocation and owner restart. Syntax and diff checks pass.

Required next gate: independently review immutable candidate, integrate centrally,
then repeat the original actual Mia model-driven Beta screenshot after cold
restart. Criterion 10 remains partial until that gate passes. Local fixture
results do not satisfy criterion 15 or prove real model execution.
