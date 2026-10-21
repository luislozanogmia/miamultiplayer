---
name: miaos-bot-creation
description: Create a Mia bot from chat through the guarded local Mia bot command. Use when the user asks Mia to make, add, set up, or create a bot.
---

# Mia bot creation

In Mia's own chat in the app, follow the turn's "Bot setup" instruction
instead: it opens the setup card the user reviews and accepts. Use
`miaos-bot` only where that instruction is not given.

Create bots through `miaos-bot`; do not inspect the source tree, edit files,
write to SQLite, or improvise a different creation path.

Gather these user-facing fields:

- `name`: a short bot name
- `role`: what the bot is responsible for
- `output`: what a useful result from it looks like
- `departments`: optional labels used to organize it

If essential details are missing, ask a concise question. Then show a compact
proposal and state that nothing has been created. Create the bot only after the
user explicitly confirms that proposal.

After confirmation, run exactly one command with a quoted heredoc so user text
is data rather than shell syntax:

```bash
miaos-bot create --confirmed <<'MIAOS_BOT_JSON'
{"name":"Researcher","role":"Research topics I assign","output":"A concise sourced brief","departments":["Research"]}
MIAOS_BOT_JSON
```

Use valid JSON and preserve the user's meaning. This command never creates
automations: once the bot exists, ask it in its own chat to propose any
schedule the user wants, and the user confirms it there. Treat a result with `status` equal to
`created` or `existing` as success and tell the user the bot's name. If the
command reports that Mia is unavailable or authorization is required, report
that directly; do not attempt to obtain credentials or bypass the API.
