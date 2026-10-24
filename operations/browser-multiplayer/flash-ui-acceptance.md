# DeepSeek Flash: actual Linux UI acceptance

Observed on mia-dev-aws, October 9, 2026 (America/Monterrey).
Runtime source: `944a8ca`; managed credential helper source: `6d027a4`.

The actual Mia Electron app ran on isolated virtual display `:100` with a
disposable local profile. The existing DCV session was preserved. Chromium's
sandbox and native keyring encryption remained enabled. The credential helper
obtains the test credential from the OS keyring; no credential is stored here.

Manual computer use opened Mia's browser, selected the Multiplayer Test
workspace, entered a read-only goal, selected `deepseek-flash` for personal Mia,
assigned Alpha reader to tab 2 and Beta reader to tab 3, and pressed **Ask Mia
to plan and start**. The human tab remained selected with its unfinished draft
visible. The rendered final synthesis reported Alpha **17**, Beta **29**, sum
**46**, and stated that neither page was modified.

Work ID: `fd0f3c99-4d9e-4d34-8f5d-aa340c73cf2c`. Stored work and both workers
finished `done`. A narrow read-only query of the isolated Hermes session
metadata confirmed `model=deepseek-flash` and `billing_provider=deepseek` for:

- Personal Mia: `20261009_223703_2b295a` (3 API calls).
- Alpha: `20261009_223723_bfb478` (8 API calls).
- Beta: `20261009_223723_bfa368` (5 API calls).

Local screenshot: `/tmp/mia-flash-ui.png`. Disposable profile:
`/tmp/mia-browser-mvp-deepseek-20261009-01`. These temporary artifacts are not
portable repository assets. No raw model reasoning was inspected or copied.

The managed secret-source change passed 49 focused integrated tests; an
independent harmless helper probe verified the pinned Hermes command-source
contract. Provider API probes were diagnosis, not substitutes for this UI run.

Four Docker-hosted virtual displays (`:100`–`:103`) are running. Only `:100`
has been exercised with Mia; this does not establish four-worker UI acceptance.
Stop/resume, reconnect/restart, approval, and the remaining frozen lifecycle
criteria still require their own actual UI evidence. Linux evidence does not
replace native Mac or Windows acceptance. No push, merge, or release occurred.
