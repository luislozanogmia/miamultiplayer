# Native presence owner regression

Base: 99f81555ce5eaf8d7eda2e1b1f300647ad3831a2. Isolated Linux Electron
44.2.0, DISPLAY :101, disposable profile and loopback pages. Root authorized
browser owner/test/probe scope. This is local automated native evidence;
manual integrated Mia UI/model acceptance remains required centrally.

Frozen failures: body-appended status text contaminated page reads; fixed
highlights survived scroll/new mutations/layout/navigation/error and were
measured before synchronous click/fill handlers. Baseline native probe reports
readUnchanged false, postHandlerRect false, scrollCleared false,
newMutationCleared false, layoutCleared false, errorCleared false,
resizeCleared false, navigationCleared false, fillPostHandlerRect false,
generatedVisibleLabel false, emptyFallbackUnchanged false. It exits failing.
Human preservation, successful target creation and revoke removal already passed.

Repair: owner-generated CSS label (one bounded static stylesheet per document,
128-character bot name), with no label text nodes. Page reads retain their
existing live DOM logic; no filtering, cloning, cached text, or page content
removal. Label, mote and ownership border remain rendered. Presence lives in
the existing isolated script world. Native generation checks before and after
stylesheet installation, plus renderer generation checks and serial presence
updates, reject old-document events. SPA navigation updates the guard too.

Only a successful runtime target event creates a highlight. Click/fill measure
a connected, visible target after synchronous handlers; disconnected/hidden
results have null target. Clear on new mutations/errors, navigation/revoke,
scroll (including capture-phase nested scroll), resize, outside-marker DOM
changes (including head stylesheet changes), resource loads, font completion,
animation/transition starts. Read/screenshot and marker's own DOM/style updates
retain the current highlight. This clears conservatively rather than projecting
an old rectangle onto a changed layout. Pure ongoing layout animation is not
tracked geometrically; starting transitions/animations clears instead.

Candidate native probe passes 18 assertions: unchanged body reads even when
real page text equals bot label; empty fallback unchanged; visible generated
label; successful target creation; post-handler click/fill rects; scroll,
resize, layout, mutation and error clearing; read retains target; SPA clearing;
disconnected target denied; full navigation restores marker with clean reads;
revoke removes marker; human selected tab/draft/DOM focus/caret preserved.
The hidden scroll probe requests an assigned screenshot to pump compositor
frames before inspecting the captured scroll event. It never selects the worker.
Visual inspection of /tmp/mia-native-presence.png confirms label, mote, border
and current fill target. Probe cleanup removes its own profile/window/server.

Focused browser/binding/attachment tests pass 57/57, including a delayed-CSS
navigation regression proving stale marker suppression and per-document rule
reuse. Cold-restored never-selected Beta capture still passes green then fresh
blue, hidden/no visibility events, zero show/focus and sandbox preservation.
Syntax, diff and staged leak checks are handoff gates.

Run native-presence.cjs with DISPLAY=:101 and MIA_TEST_SOURCE set to the tested
source, using the existing pinned Electron binary. No live display, credentials
or models are used. Criterion 11 is not integrated/manual accepted by this probe.
