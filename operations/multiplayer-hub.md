# Shared teams and bots

Mia discovers its hosted Hub at `https://hub.miamultiplayer.com`. This is a public API address, not a credential. Requests require the participant's current production Clerk session; the Hub enforces team membership and administrator permissions.

The repository contains the desktop/client adapters only. Hub service source, AWS provisioning and account details, SSH access, server secrets, production profiles, databases, and private logs belong outside this public repository. Never add credentials to configuration examples or test captures.

## Participant flow

- Create or join teams in Settings → Teams, then choose a shared workspace.
- Share a solo bot with an explicit linked or fork choice. Linked bots can propose updated solo instructions; forks have independent shared instructions.
- The channel displays a pending request. An administrator can Review the exact instructions, Accept them, or Reject them. Acceptance publishes that version and announces that the bot joined.
- Mention an accepted bot to run it on the requesting participant's computer with that participant's own connected providers and tools. A handoff to another participant requires that participant's acceptance.
- The Hub holds shared messages, approved definitions, and dispatch state. The client keeps its local execution journal and private provider credentials locally. Completed shared replies are sent back to the channel.

## Development configuration

The production endpoint works without a configuration file. For a separate local Hub, use `MIA_HUB_URL` or a `hub-connection.json` file in the application's private data directory containing only a `url` property. Endpoints must use HTTPS, except HTTP on loopback for local development. Credentials, query strings, and non-root paths in the endpoint are rejected. Keep private configuration outside the checkout.

## Verification scope

Regression tests cover routing, requester-owned execution, explicit handoff acceptance, durable journals, native authentication transitions, and inline bot admission. Production service deployment and desktop packaging are separate actions from committing these adapters.
