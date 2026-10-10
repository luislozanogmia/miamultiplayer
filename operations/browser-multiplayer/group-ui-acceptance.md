# Named groups: pre-restart Linux UI evidence

Observed October 9, 2026, America/Monterrey, in the actual Mia Electron
runtime reported by root as `c84a396`, isolated display `:100`, disposable
profile `/tmp/mia-browser-mvp-deepseek-20261009-01`. This is a bounded UI
acceptance handoff; it does not close restart or full MVP acceptance.

Manual computer use through observed UI coordinates:

- Renamed the existing Browser group to **Mia bot workspace**.
- Added a second named empty group, **Mia review**.
- Selected Mia review and used **Move earlier**. The rendered group order
  became Mia review, Mia bot workspace.
- Selected Mia bot workspace again. Its three tabs returned, with
  Human workspace selected and its synthetic page visible.
- Two drag attempts from Worker Beta toward the first tab did not produce a
  settled changed tab order. The first showed a drag ghost until Escape;
  the second returned the original order. Tab reorder is unverified; no
  internal command or state-file mutation was used to bypass the UI.

Separate read-only programmatic corroboration from the named browser-state
file under this disposable profile's `desktop` directory:

| Order | Group ID | Name | Tab order | Selected tab |
|---|---|---|---|---|
| 1 | `0be4eff0-a91f-4b42-81b7-34c294cb21e9` | Mia review | empty | null |
| 2 | `default` | Mia bot workspace | 1, 2, 3 | 1 |

Selected group is `default`; active tab is 1. Tab 1 is Human workspace,
tab 2 Worker Alpha, tab 3 Worker Beta. No tabs were removed. No work/model
turn, Stop, approval, or restart was initiated by this lane. Existing real
worker results were outside this UI mutation scope; their durability is not
asserted from these screenshots. The human input was already empty at the
start of this group check, so this check establishes no draft preservation.

Local screenshots include `/tmp/mia-group-ui-named.png`,
`/tmp/mia-group-review-selected.png`, `/tmp/mia-group-order.png`, and
`/tmp/mia-group-selected-return.png`. They are temporary local evidence,
not portable repository artifacts. Persisted state corroborates pre-restart
values only. Root owns closing/restarting the app and observing restoration;
criterion 1 and the lifecycle portion of criterion 15 remain open.
