# Native legacy tab-state compatibility

Frozen source: b6246d1f0a2a9112629e6891ac50098b1d81e5e6, integrated browser
owner after the reviewed capture and presence repairs. Target: mia-dev-aws
Linux, pinned Electron 44.2.0, DISPLAY :101. This is local automated native
owner evidence for criterion 1's legacy-load clause. Existing native-smoke
covered modern group state and empty-group restoration; its source did not
seed a version-1 legacy file. No unchanged passing suite was rerun.

The actual parser accepts version 1 or 2 with a tabs array. The disposable
fixture uses version 1, activeId 3, and tabs 47 / 3 / 19 in that order, with
loopback Human / Alpha / Beta URLs and no groups or selectedGroupId fields.
Choosing the middle tab and nonsequential IDs detects accidental last-tab
selection, ID regeneration and numeric sorting.

The actual sandboxed WebContentsView owner passes:

- Legacy tab IDs, ordered full URLs and activeId 3 are preserved.
- Group default / Browser contains ordered tabs 47,3,19, selectedTabId 3;
  selectedGroupId is default.
- All three real Chromium pages finish loading. Their actual WebContents URLs
  match their assigned state, and native protocol reads return the distinct
  Human focus marker / ALPHA result 17 / BETA result 29 fixture text.
- Each renderer has no require function; sandbox/context isolation remain enabled.
- Explicit native prepareToClose/persist saves version 2, tab/order/selection
  and group state unchanged, with file permissions 0600.
- The first owner/window is destroyed. A fresh owner/window loads that saved
  version-2 file and repeats the URL/read/group/selection assertions identically.

Run from the isolated evidence checkout:

```bash
DISPLAY=:101 MIA_TEST_SOURCE=/home/mia/.codex/worktrees/browser-legacy-restore/miamultiplayer /home/mia/.codex/worktrees/12c2/miamultiplayer/macos/node_modules/electron/dist/electron operations/browser-multiplayer/legacy-state-restore.cjs
```

The probe uses a hidden disposable BrowserWindow, its own temporary userData
and state file, and an ephemeral loopback server. It removes that profile and
closes its window/server on completion. No actual user profile, credentials,
models, live display, push or deployment is involved. Raw local output is
/tmp/mia-legacy-state-native.log. Syntax/diff/staged leak checks pass.

This successful evidence required only a probe and documentation, no runtime
repair or additional mocked regression. It proves fresh native-owner reopening
within one Electron process, not a full Mia process restart, manual UI flow,
real model execution or Mac/Windows behavior. Root/verifier own the authoritative
criterion ledger and independent integrated acceptance claim.
