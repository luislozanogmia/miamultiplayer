# Mia 0.2.18 release candidate

## Scope

This source candidate combines canonical browser PR #46 (2eab142), Google
account identity/replacement fixes, bot-profile model-selector removal,
Claude disconnect fallback prevention, and Claude Code maintenance.
`macos/package.json` is the authoritative version; its package-lock root
metadata agrees at 0.2.18. Merge/release/publication remain separate actions.

Existing Google grants whose current Mia identity cannot be established
require one explicit reconnect after upgrade. The connection's verified Gmail
email is visible only to its authorized owner. Mia and bots invalidate their
Google session bindings on replacement; raw CLI commands use app-scoped config.

Claude Code's tested compatibility floor is 2.1.300. This is a tested Mia policy,
not a promise that an account has a model. Older installations are maintained
using Anthropic's native installer, compatible newer versions are preserved,
and failures surface an in-app retry path. Missing installs require consent.
Credentials and the CLI's external sign-in are preserved. See
[Claude maintenance](CLAUDE_SUBSCRIPTION.md).

## Verification recorded before PR

- Combined frontend, native-browser owner, desktop shell, Claude maintenance,
  Google connector/broker, native-dispatch/inference and packaging-contract
  checks on Linux/Node 22: 516 passed, 0 failed, 3 skipped (519 total). Skips
  cover two optional pinned-gws fixtures and macOS-only DMG staging.
- Baseline regressions reproduced stale Google identity/session reuse,
  disconnected Claude fallback, outdated CLI acceptance and profile model
  overwrite; focused candidate checks pass. Gateway/CLI fixtures use synthetic
  data and do not establish real provider acceptance.
- Manual local frontend/backend checks cover bot profile save/model preservation,
  dependency update/failure/retry/continue, and integrated browser address,
  Hide/Show Mia, idle-footer and Downloads behavior. Native desktop bridges
  were explicitly mocked in these previews.
- Luis reports that the browser changes work on his Mac (2026-10-16).
  This is owner-reported browser acceptance, not proof of the entire combined
  candidate's Google OAuth, installer or native provider lifecycle.
- Prior independent source reviews found no remaining blockers in the Claude
  maintenance and PR #46 integration; final pre-PR source/leak review and the
  repository hook are required for the exact submitted changes.

## Gates after review/merge, before publication

1. Freeze the merged source SHA; do not build or publish a dirty working tree.
2. On disposable native Mac, Windows and supported Linux profiles, test older,
   missing, newer and failed/offline Claude CLI maintenance. Verify selected
   executable/version, refreshed account model inventory, and real Mia/bot replies.
   AWS's official-installer URL returned HTTP403 during development, so fixture
   success is not a successful native download/upgrade.
3. Verify actual Google A-to-B reconnect, displayed email, Gmail/Drive action
   under B from Mia and a bot, and no inheritance across a different Mia login.
   Verify the one-time reconnect migration for previously unbound connections.
4. Verify native Claude disconnect/reconnect, resumed and new Mia/bot chats,
   and alternate connected providers. Independently pinned scheduled/in-flight
   work is outside this application fallback fix.
5. Check native Mac dragging/maximize/window controls and packaged pane behavior
   on the final candidate, plus Windows/Linux browser layout.
6. Build fresh Mac, Windows and Linux artifacts; run the independent Daybreak
   pass over the exact merged source and packaged apps. Verify signing/notary,
   versions, runtime provenance and all checksums. Preserve Windows unsigned
   status disclosure if still applicable.
7. Upload a complete draft asset set, including updater feeds/referenced files
   and stable aliases. Verify public feeds/downloads and actual installed OTA
   after publication is authorized. No release artifacts or publication are
   claimed by this source PR.
