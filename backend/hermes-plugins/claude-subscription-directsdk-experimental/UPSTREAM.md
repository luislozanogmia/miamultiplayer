# Vendored upstream plugin

This directory contains the runtime files from the official Nous Research
`hermes-plugin-claude-subscription-directsdk` plugin, version 0.3.0, reviewed
commit `c92c27c9f919178a58974a72333b473c6cb2e71d`.

Source: https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/c92c27c9f919178a58974a72333b473c6cb2e71d

Mia provisions this copy into each managed Hermes runtime profile so agent and
bot sessions use Hermes' native model-provider discovery. The provider code is
vendored from that reviewed revision with one narrow policy customization:
`model_catalog.py` caps advertised context metadata at 250,000 tokens for the
listed non-Haiku models and 200,000 for Haiku, while retaining Claude Code's
real `[1m]` route selector. `plugin.yaml` and `LICENSE` remain unchanged. See
`LICENSE`.
