# Claude subscription DirectSDK (Experimental)

Mia's Claude subscription option is an experimental integration of the official
Nous Research Hermes plugin. It uses the installed Claude Code CLI and its
existing subscription login; Mia does not receive or store the Claude
credential and does not silently fall back to an Anthropic API key.

## Prerequisites

- Mia's bundled Hermes release must be 0.21.4
  (`v2026.9.21`, commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3`).
- The official Claude Code CLI must be installed. Mia reuses an existing
  Claude Code login or starts the CLI's own `claude auth login --claudeai`
  flow from Connect. Upstream qualified Claude Code 2.1.263.
- The vendored plugin is version 0.3.0, reviewed at commit
  `c92c27c9f919178a58974a72333b473c6cb2e71d`. Mia keeps the upstream runtime
  structure under `backend/hermes-plugins/claude-subscription-directsdk-experimental`
  with the documented local context-window policy customization.

Desktop builds search the current `PATH` plus common Homebrew and npm install
locations. Set `CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND` to an explicit Claude
CLI path when discovery is insufficient. Mia passes
`CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR` to the plugin, which maps it to the
CLI's `CLAUDE_CONFIG_DIR`; desktop builds default this to the user's
`~/.claude` rather than Mia's isolated Hermes home.

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
its official authorization URL in the embedded browser and forwards an
optional one-time completion code to its standard input without storing or
logging it. A real subscription turn, real account login, packaged-app launch,
installer/package build, and manual UI flow remain unverified. Do not describe
this integration as production-qualified until those checks pass.
