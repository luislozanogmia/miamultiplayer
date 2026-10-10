# Actual group Stop, focus and recovery review

Synthetic work: `741e0178-620a-426b-aad4-c700646cab60`.
Initial run source: `0dc774f`; restart source reported by root: `8b50f9f`.
Actual isolated Mia app/profile/display are the same disposable Flash setup
documented in [the first real run](real-flash-acceptance.md).

Root reports actual UI planning/start, manual human typing and group Stop,
graceful UI Ctrl+Q/relaunch, tab ordering through Move tab, and explicit task
recovery. This lane did not initiate those actions. It independently inspected
the following safe records, screenshots and narrow runtime metadata, without
reading credentials, model configuration, messages or hidden reasoning.

## Human control while real workers were active

`/tmp/mia-human-focus-before.json` and
`/tmp/mia-human-focus-during.json` contain exactly equal DOM observations:
full value `Human draft stays intact during bot work.`, selectionStart 8,
selectionEnd 8, activeElement `draft`, focused true. Root reports native
active_tab_id 1 and both Hermes workers working at the during observation.
This establishes full text/caret/DOM focus preservation in the observed read-only
run, beyond the earlier screenshot's truncated visible input. It does not
establish preservation across browser page reload or every possible mutation.

## Group Stop and retained visible text

Independent inspection of `/tmp/mia-stop-work-observed.json` confirms work
cancelled at epoch 1 and both workers cancelled at worker epoch 1. Original
partial visible text lengths are Alpha 4,625 and Beta 2,669 characters; both
records have status stopped, incomplete true, verified false and originating
epochs 0/0. Each worker performed two successful native `read` operations at
epoch 0/0 before Stop; stopped answers do not promote those reads into completion.
No consequential mutation or uncertain-write record is involved.

Read-only session metadata confirms both interrupted runtime sessions used
`deepseek-flash`, billing provider `deepseek`:

| Worker | Stored session | Messages | Tool calls | API calls |
|---|---|---:|---:|---:|
| Alpha | `20261009_224744_40c47b` | 8 | 3 | 4 |
| Beta | `20261009_224744_bfaaf4` | 8 | 3 | 4 |

Independent visual inspection of `/tmp/mia-stopped-ui.png` shows Alpha's actual
preserved answer with Stopped / Incomplete / Unverified labels and the warning
that it is not current verification. `/tmp/mia-recover-ui.png` shows the stopped
original goal, personal Mia identity and Recover task with fresh page checks.
Beta's stopped partial is confirmed in the stored record; this screenshot does
not independently show Beta's answer labels.

Root reports delayed re-read and post-restart results exactly equal to the
stopped snapshot, with no late overwrite. This lane's first API comparison
occurred during restart and received connection refused; the next occurred
after explicit recovery had already advanced epoch 2. It therefore did not
independently observe the intermediate stopped equality window.

## Reordering and restart

Root reports using the existing Move tab UI control to order the selected
group's tabs [1,3,2] and select Alpha tab 2, then gracefully quitting/relaunching
the app with the same disposable profile. Independent screenshots
`/tmp/mia-tab-order-ui.png` and `/tmp/mia-tab-order-restored.png` show Human / Beta
/ Alpha in that order, Alpha selected, and named groups Mia review / Mia bot
workspace in the same order with Mia bot workspace selected. Native active tab
2 and exact stopped-record retention are root-reported checks. Drag reorder,
per-group selections for every group, legacy-state loading and crash recovery
remain separate gates.

## Explicit recovery and fresh verification

Independent API inspection after root's UI recovery finds the original goal
unchanged, epoch 2, and new stored worker sessions. Both workers completed;
the work was still working with personal synthesis not complete at that check.
Each previousAttempts entry exactly matches its original stopped text and
remains verified false / incomplete true. This independently confirms the
historical text is still available after the root-reported restart/recovery.

| Worker | New Flash session | Successful current read proof (epochs 2/2) |
|---|---|---|
| Alpha | `20261009_225019_f7bd11` | `e9a81ed7-92a4-4e0c-9ef1-cbe4f1c95c84` |
| Beta | `20261009_225019_7e8c5d` | `cc02a624-1b0b-4d66-b234-ef9d3ef71376`, `b6036304-3743-42c5-8175-7941f9728d26` |

Narrow read-only SQLite metadata confirms both new sessions model
`deepseek-flash` / billing provider `deepseek`. Alpha has 4 messages, 1 tool call,
2 API calls; Beta has 6 messages, 2 tool calls, 3 API calls at inspection. The
session IDs differ from interrupted sessions, and fresh read proof is distinct
from old epoch 0/0 history. Root also reports typing a new human draft with
caret/focus retained during recovery; no corresponding independent DOM record
was supplied at this checkpoint, so that observation remains root-reported.

This establishes the exercised actual read-only group Stop and fresh-worker
recovery path, with evidence provenance separated. It does not establish
individual-worker Stop isolation, Stop during personal Mia synthesis, recovered
final synthesis, uncertain-write no-replay, consequential approval UI, or every
group/lifecycle gate. All fifteen frozen criteria must retain those open checks.
