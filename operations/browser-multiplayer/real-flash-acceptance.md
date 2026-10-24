# Actual Flash worker and synthesis evidence

Integration source: `944a8ca669a9062bec2c0a8248d1f3d07cc03f2b`.
Synthetic work: `fd0f3c99-4d9e-4d34-8f5d-aa340c73cf2c`.
Isolated app: `http://127.0.0.1:4972`, disposable profile
`/tmp/mia-browser-mvp-deepseek-20261009-01`.

Root reports starting the task through actual Mia's bot UI using xdotool on
isolated display 100. This lane did not witness initiation or mutate the UI.
Direct provider/API probes are diagnosis and do not count as UI initiation.

Independent read-only evidence:

- The work API returned HTTP 200 and final status `done`, owner
  `local-user@localhost`, group `default`, current work epoch 0. Personal
  selection is DeepSeek / `deepseek-flash` / high reasoning effort.
- Worker 0 owns tab 2, Alpha bot, actor
  `2ed2ecd7-9c60-472a-b341-2e82818d0014`. Worker 1 owns tab 3, Beta bot, actor
  `46b6915c-5398-4909-9aaf-0ef244347065`. Both are done at worker epoch 0.
- Both real stored replies are marked verified and complete. Alpha's reply
  reports assigned-page value 17; Beta's reports 29. Each cites a successful
  native `read` operation with work/worker epochs 0 and document generation 1:
  Alpha `bf24e442-b20c-4105-8fce-65310682cbc7`, Beta
  `fafb7e6a-305f-462b-ab2a-5caceb8d8dd0`. No stale-attempt proof is used.
- Alpha first attempted unsupported `read_page`, `snapshot` and `help` methods.
  Those operations failed and are excluded from its successful read evidence.
  This demonstrates eventual completion, not error-free tool use.
- Actual stored personal Mia synthesis is complete, verified, and reports
  Alpha 17, Beta 29 and combined sum 46 with read-only limits.

Actual runtime model evidence comes from read-only SQLite `mode=ro` queries
restricted to known session IDs and six metadata columns. No model_config,
system prompts, messages, reasoning, environment or credential files were read.

| Session | Model | Billing provider | Messages | Tool calls | API calls |
|---|---|---|---:|---:|---:|
| Personal `20261009_223703_2b295a` | deepseek-flash | deepseek | 6 | 1 | 3 |
| Alpha `20261009_223723_bfb478` | deepseek-flash | deepseek | 16 | 7 | 8 |
| Beta `20261009_223723_bfa368` | deepseek-flash | deepseek | 10 | 4 | 5 |

The session IDs match the API's stored personal/worker IDs. This is actual
runtime session/model evidence beyond connected inventory or requested options.
The call counters include each session's history and are not asserted to equal
this work record's operation count.

Independent visual inspection of root's actual screenshot
`/tmp/mia-flash-ui.png` confirms rendered final values 17, 29 and 46 in the
browser-work panel, three named tabs with Human workspace selected, and the
human draft still visible. It does not establish the full untruncated draft,
DOM focus/caret, named-group persistence or close/restart behavior. Screenshot
evidence is separate from root-reported UI initiation and the independent
stored work/runtime metadata checks.

The actual two-worker read and personal synthesis path is evidenced here.
Criterion 15 remains PARTIAL until human focus/draft/caret and group state are
verified through close/restart. Actual Stop/recovery/approval flows are not
established by this read-only successful run. This lane made no start, stop,
approval, profile or native-tab mutation and performed no push or deployment.
