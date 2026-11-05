# Vendored upstream plugin

This directory contains the runtime files from the official Nous Research
`claude-subscription-directsdk` plugin, version 0.3.4, reviewed commit
`83f0a896b3518c7131181838e340c9a80c79524d`.

Source: https://github.com/NousResearch/hermes-official-plugins/tree/83f0a896b3518c7131181838e340c9a80c79524d/claude-subscription-directsdk

Mia provisions this copy into each managed Hermes runtime profile so agent and
bot sessions use Hermes' native model-provider discovery. The provider code is
vendored from that reviewed revision with Mia catalog policy customizations:
`model_catalog.py` caps advertised context metadata at 250,000 tokens for the
offered 1M-capable models (including Haiku 5.5), while retaining Claude Code's
real `[1m]` route selector. `plugin.yaml` differs only in defaulting Claude Code
telemetry to off. `LICENSE` remains unchanged. See `LICENSE`.

The `haiku` alias and saved Haiku 4.5 choices select Haiku 5.5. The `opus`
alias and saved Opus 5/4.8 choices select Opus 5.5. Retired models are omitted
from the offered catalog. Model availability is still checked against the signed-in account’s
Claude Code discovery; a catalog entry does not grant model access.

Haiku 5.5 uses the plain `claude-haiku-5-5` ID; Claude Code 2.1.293+
provides its 1M window without a selector. See the official
[model configuration](https://code.claude.com/docs/en/model-config).

Claude account discovery is authoritative for the picker: successful empty
discovery stays empty and this profile has no curated fallback catalog. A
failed discovery therefore does not advertise models the account never
reported. Metadata remains available for request budgeting.
