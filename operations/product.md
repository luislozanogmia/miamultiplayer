# Mia Multiplayer — Product

## What it is

A desktop OS layer (Electron) that gives users an AI agent (Mia) with chat,
automations, browser control, Google Workspace integration, and bot creation.
Open-source core at github.com/luislozanogmia/miamultiplayer.

## Inference routing

### Current (Beta)

- **Mia Router** = OpenRouter as the backend. We provision a per-user OpenRouter
  API key via Lambda, restrict the model picker to DeepSeek V4.1 Flash only,
  and brand it as "Mia Router." OpenRouter load-balances across upstream
  providers (Relace, Wafer, etc.).

### Next

- **Direct to DeepSeek.** Drop OpenRouter and route directly to DeepSeek's API
  (`api.deepseek.com`). We handle the routing ourselves. Reasons:
  - Cut out the middleman markup — DeepSeek direct pricing is cheaper.
  - Full control over routing, rate limits, and failover.
  - No dependency on OpenRouter's availability or provider selection.
  - Can negotiate volume pricing directly with DeepSeek.
- Still brand as "Mia Router" in the UI — users don't need to know the backend changed.
- Requires: DeepSeek API key management in Lambda, update Hermes provider from
  `openrouter` to `deepseek`, update model allowlist to DeepSeek's native model IDs.

## Model strategy

- Beta: DeepSeek V4.1 Flash only (cheapest reasoning model, ~$0.15/M in, $0.60/M out).
- Future: add model tiers (free tier = Flash, paid tier = unlocks Claude/GPT).

## Roadmap — P3 (future, not scheduled)

Sourced from a Sept 2026 competitive scan of Meta's Muse agent and Alexandr
Wang's public product commentary.

- **Approval gating for autonomous bots.** Extend the existing
  `agent_permissions` model with an "ask first" tier between denied and
  auto-approved: approvals scoped one-time, per-session, per-task, or
  time-bounded, evaluated at action time for connector and browser-mode
  actions (Muse's "Sentinel" pattern). Hermes auto-approve already covers the
  static grant half; this adds the runtime half.
- **Self-healing harness.** Instead of plain in-app bug reporting: when Mia
  detects a bug (error, failed automation, crash), it asks the user "want me
  to fix this?" On yes, a dedicated fixer account — running a stronger model
  on high reasoning — takes the bug report and fixes it with its own harness,
  then verifies. Turns every user into a contributor without leaving the app.
- **Fine-grained, time-boxed automations.** Beyond the current
  interval/daily/weekly/monthly cadences: narrow ad-hoc watches like "monitor
  X tomorrow between 2-4pm and act when it changes."
- **Credential isolation broker.** Connector secrets stored via Electron
  `safeStorage` (Keychain / DPAPI / libsecret — native on all three
  platforms, not implemented today). Bots reference credentials by name only;
  the backend injects values in-process at call time. Product-izes the repo's
  existing no-secrets contract.
