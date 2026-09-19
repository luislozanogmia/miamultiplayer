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
