# Claude subscription DirectSDK (Experimental)

Mia's Claude subscription option is an experimental integration of the official
Nous Research Hermes plugin. It uses the installed Claude Code CLI and its
existing subscription login; Mia does not receive or store the Claude
credential and does not silently fall back to an Anthropic API key.

## Prerequisites

- Mia's bundled Hermes release must be 0.21.4
  (`v2026.9.21`, commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3`).
- Mia uses a compatible Claude Code CLI (see the desktop maintenance policy below). If absent, Connect
  offers an explicit native confirmation before downloading and running
  Anthropic's installer. Claude Desktop by itself is not the Claude Code CLI.
  Mia then uses the CLI's own `claude auth login --claudeai` flow. Upstream
  qualified Claude Code 2.1.263.
- The vendored plugin is version 0.3.0, reviewed at commit
  `c92c27c9f919178a58974a72333b473c6cb2e71d`. Mia keeps the upstream runtime
  structure under `backend/hermes-plugins/claude-subscription-directsdk-experimental`
  with the documented local context-window policy customization.

Desktop builds search the current `PATH` plus common native, Homebrew, and npm
install locations, including the native Windows `.exe`. Set
`CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND` to an explicit Claude CLI path when
discovery is insufficient. Mia passes `CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR`
to the plugin only when explicitly set; otherwise the CLI chooses its own
credential store. Mia does not copy Claude Desktop credentials.

## Desktop dependency maintenance (0.2.18 candidate)

Mia checks the selected Claude Code executable with a bounded asynchronous
`--version` probe on each launch, before starting its backend. The tested floor
is `2.1.300` in `macos/src/claude-code.cjs` (the CLI used in the successful
0.2.17 Linux model tests). This is Mia's compatibility policy, not a vendor
minimum or a guarantee that every account exposes every model.

An existing older/unreadable installation is repaired with Anthropic's official
native installer targeting that version, then verified again. Compatible newer
versions are preserved. A compatible native launcher is preferred over repairing
an old PATH/npm/Homebrew shim; Mia does not run package-manager upgrades, alter
credentials, or copy login stores. Missing CLI installations still require the
existing explicit in-app confirmation. Failed maintenance offers Install/Update
again in onboarding, even if the Claude account was already connected. The
backend receives the verified executable path, so model discovery starts fresh.
A failed startup update shows a native warning with the in-app retry path.
Installer downloads and execution are bounded; simultaneous requests share the
same maintenance attempt. Downloaded installer evidence is retained in the
system temporary directory.

For every release that changes Claude models or its adapter, review and update
the tested floor here and in code. On **each native platform**, exercise a Mia
upgrade with an older CLI, a missing CLI, a newer CLI and a failed/offline update;
verify the CLI selected by Mia, refreshed account model inventory, and real Mia
and bot replies after repair. Fixture tests do not satisfy native acceptance.
The earlier suggestion that `2.1.293` specifically explains the missing Haiku
entry on Luis's Mac remains unproven; do not treat updating as proof of account
entitlement or fabricate a missing model when discovery excludes it.

Official installer/version semantics: https://code.claude.com/docs/en/setup.

## Operational limits

Each turn uses the account's Claude Agent SDK subscription allowance. Account
extra-usage settings may incur charges, and upstream measured lower throughput
than the interactive Claude Code UI. Disconnecting in Mia preserves the
external Claude Code login. Existing Hermes scheduled jobs are independently
owned by Hermes and may continue until paused from Mia's Automations view.

Automated checks cover missing-CLI behavior, config-directory mapping,
paid-API/custom-endpoint refusal, profile provisioning for ordinary agents and
bots, model validation (including `[1m]` routes), persisted Mia disconnect
state across a backend restart, and the mocked login URL/code/cancel/retry
lifecycle. The login subprocess remains the sole credential owner: Mia opens
its official authorization URL in a separate sandboxed sign-in popup, preserving
Google's child popup and opener. The desktop captures only the exact official
callback with the matching login state and submits its one-time code through
Mia's authenticated session to the CLI's standard input. The backend rejects
callbacks from replaced login attempts. Codes are not logged or persisted;
manual entry is available in a collapsed fallback. An omitted/null model uses
the harness catalog's default; explicit unsupported models remain rejected.

The source-checkout desktop Google login, Claude authorization, automatic code
handoff, and connected-state UI were exercised live on 2026-09-22. A real
subscription inference turn, packaged-app launch, and installer/package build
remain unverified. Do not describe this integration as production-qualified
until those checks pass.
