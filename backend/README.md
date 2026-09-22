# mia-os-backend

## Google Account connector

The active backend routes use the official `gws` CLI through the Hermes-owned
Google Account connector. OAuth credentials stay in that runtime and never
enter Mia SQLite, prompts, logs, or child-process environment variables.
Mia passes only allowlisted operations with bounded structured arguments;
delete, trash, clear, and broad batch-update methods are rejected.

Because the CLI profile is process-scoped, it is bound to exactly one Mia
identity through `MIAOS_GOOGLE_ACCOUNT_OWNER` (the first configured admin is the
local default). Other authenticated users see no connected account and cannot
start, test, disconnect, read, or mutate that profile.

The authenticated connector owner receives a separate agent profile with
bundled, bounded Sheets, Docs, and Slides tools. Existing resources still
require a human-supplied link or ID; broad Drive search and destructive
delete, clear, and trash operations are not exposed. Other Mia users and bots
remain on profiles without these tools. Explicitly linked Sheets, Docs, and
Drive resources may also be read into bounded, untrusted prompt context. The
older direct-OAuth helpers remain unregistered compatibility code and are not
the active connection path.

Mia API server: Express + SQLite (`better-sqlite3`). Instance identity is
environment-configured in `instance.js`.

## Run

```
npm install
DATA_DIR=/path/to/old/server/data npm start
```

On first boot, if the SQLite DB is empty and `DATA_DIR` points at legacy
JSON data files, they're imported once (idempotent — recorded in a `meta`
table row, safe to leave `DATA_DIR` set permanently).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4870` | HTTP port |
| `DB_PATH` | `./mia-os.db` | SQLite file path |
| `DATA_DIR` | — | Optional legacy JSON migration directory |
| `STATIC_DIR` | — | If set, serves a frontend build from this dir |
| `INSTANCE_NAME` | `Mia` | Instance display name, used in the LLM system prompt and `GET /api/instance` |
| `INSTANCE_TEAM_DESCRIPTION` | `an internal operations team` | Team descriptor used in the LLM system prompt |
| `INSTANCE_DOMAINS` | `example.com` | Comma-separated list of email domains allowed to log in |
| `INSTANCE_PASSWORD` | *(unset)* | Legacy shared-password mode, only used while the `users` table is empty. No default: when unset, shared-password login is disabled entirely — create real user rows instead |
| `MIAOS_SINGLE_USER_EMAIL` | *(unset)* | Exact owner identity for a single-user Internet release. Other user rows, sessions, and API keys cannot authenticate. On an empty database, the owner can bootstrap its durable admin row with `INSTANCE_PASSWORD`. Requires absolute `MIAOS_ARTIFACT_DIR` and `MIAOS_ATTACHMENT_DIR` paths outside the source tree |
| `MIAOS_BIND_HOST` | single-user: `127.0.0.1`; otherwise all interfaces | Backend listener address. Keep the single-user release on loopback behind the same-host TLS proxy |
| `MIAOS_AGENT_SEARCH_ONLY` | enabled automatically by `MIAOS_SINGLE_USER_EMAIL` | Hosted-safe agent profile: brokered web search plus todo/clarify, without host files, terminal, memory, session search, or browser automation |
| `MIAOS_HERMES_OPENAI_MODEL` | `gpt-5.5` | Hermes model used with the ChatGPT/OpenAI provider selected in Mia |
| `MIAOS_HERMES_XAI_MODEL` | `grok-4.6` | Hermes model used with the Grok/xAI provider selected in Mia |
| `MIAOS_GOOGLE_ACCOUNT_OWNER` | first configured admin | Sole Mia identity allowed to use the process-scoped Hermes/gws Google profile |
| `MIAOS_ARTIFACT_DIR` | `./workspace-artifacts` | Server-owned storage root for immutable workspace artifact bytes |
| `MIAOS_ATTACHMENT_DIR` | `./conversation-attachments` | Server-owned storage root for native conversation attachment bytes; production should use a path outside the checkout |
| `MIAOS_BOT_PACKAGE_DIR` | `bots/` beside `DB_PATH` | Bot package root. Electron sets this to `<userData>/bots` (normally Application Support/Mia/bots) |
| `CLERK_PUBLISHABLE_KEY` | Mia development instance | Public Clerk key. A custom value is accepted only together with `CLERK_ISSUER` and `CLERK_JWT_KEY` |
| `CLERK_ISSUER` | Mia development instance | Exact HTTPS Clerk Frontend API origin; must match the host encoded by the publishable key |
| `CLERK_JWT_KEY` | Mia development instance | Public PEM key used to verify Clerk session JWTs locally |
| `CLERK_OAUTH_CALLBACK_ORIGIN` | shared Clerk callback for development; issuer for production | Optional exact HTTPS callback-origin override |

## Bot packages

Each bot has a readable, stable folder named `<name>--<bot-id>` under
`MIAOS_BOT_PACKAGE_DIR`. `AGENTS.md` is the editable source of truth for the
bot's instructions: direct edits are read for the next interactive chat, and
the editor uses a revision check so it cannot silently overwrite a newer file
edit. Scheduled Hermes jobs use the bot package as their work directory, so
Hermes' native context loader rereads `AGENTS.md` on every run. The scheduled
prompt stores app/global policy and the explicit automation task, but not a
second snapshot of the bot purpose. Editing the automation task or other
schedule settings still uses Mia's normal editor-driven schedule sync.

`bot.yaml` and `automations.yaml` are generated portable snapshots; Mia may
overwrite manual edits to those two files. Automation entries are exported as
disabled templates only. Live enablement, job IDs, deliveries, conversation
history, credentials, and other runtime state stay in SQLite or their owning
credential store. `requiredCapabilities` is currently an empty reserved field
because Mia does not yet have a persisted capability model. Package import or
marketplace installation is not implemented by this storage layer.

Existing SQLite bots migrate on first package-enabled startup. A partial
migration is retry-safe: an existing package is validated and retained instead
of being regenerated from an older SQLite instruction mirror. Managed-file
writes roll back when the corresponding SQLite write fails; cleanup after a
committed write is best-effort and never rolls back committed package data.
Deleting a bot moves its package into the package root's `.trash/` directory
for recovery rather than deleting it recursively. A deletion performed inside
a larger SQLite transaction retains an inactive package in place because a
filesystem move cannot join that transaction; this makes an outer rollback
safe and leaves manual recovery possible after commit. Package roots, managed
files, and `assets/` reject symlinks; corrupt or missing migrated packages fail
closed instead of silently dispatching stale instructions. During Mia sync, an
enabled job whose package is missing or invalid is paused before the error is
reported. Hermes itself falls back to a context-free run if a registered
workdir disappears between Mia syncs; there is no filesystem watcher, so the
job is not guaranteed to pause after an out-of-band deletion until its package
is repaired and Mia can validate/resynchronize it.

## Auth

Production Clerk setup and the Electron origin limitation are documented in
[`../operations/CLERK_PRODUCTION.md`](../operations/CLERK_PRODUCTION.md).

Three doors, one `requireAuth` middleware:

1. **Cookie session** — `POST /api/login` sets a `miaos_sid` cookie. Per-user
   scrypt auth if the `users` table has rows (migrated from `users.json`);
   otherwise legacy domain + shared-password mode.
2. **Bearer API key** — `Authorization: Bearer mia_...`. Mint one via
   `POST /api/keys` (cookie session required):

   ```
   curl -c cookies.txt -X POST localhost:4870/api/login \
     -H 'content-type: application/json' -d '{"email":"you@your-instance-domain.com","password":"your-password"}'
   curl -b cookies.txt -X POST localhost:4870/api/keys \
     -H 'content-type: application/json' -d '{"name":"ops script"}'
   # => {"key":"mia_...", "prefix":"mia_abc123", "name":"ops script"} — key shown once
   curl -H "Authorization: Bearer mia_..." localhost:4870/api/bots
   ```
3. Either grants `req.userEmail`; key management routes (`/api/keys*`) accept
   cookie sessions only.

## Files

- `server.js` — config, auth, conversations, bots, settings, and connected-app routes.
- `instance.js` — instance identity config (name, domains, password), env-driven with neutral defaults.
- `db.js` — SQLite schema, storage helpers, one-time JSON migration.
- `test.sh` — runs the focused Node test suite. The complete product acceptance pass is manual in the browser so it exercises the live local database, harness sign-in, and admin workflows together.

## User-facing chat boundary

Normal Mia chat is final-answer-only. The backend filters accidental
pre-reasoning, hidden wrapper tags, tool/progress plumbing, and unconsumed
routing tokens before native conversation posting. The browser applies the same
filter as a fallback for older stored events.
Internal Hermes/debug traces remain available only when explicitly enabled
locally with MIAOS_EXTERNAL_CHAT=0 and MIAOS_DEBUG_HOOKS=1.

## Local multiplayer artifact slice

The backend exposes an intentionally headless first slice for shared workspaces
and immutable artifact versions. Workspace IDs are generated by the server;
every member and artifact route authorizes the authenticated user against the
normalized `workspace_members` table rather than trusting the workspace
switcher header.

- `POST /api/workspaces` creates a workspace and its owner membership.
- `GET /api/workspaces` lists only the caller's active memberships.
- `GET|POST|DELETE /api/workspaces/:workspaceId/members...` lists, grants, or
  revokes user and bot membership with owner/admin role constraints.
- `GET|POST /api/workspaces/:workspaceId/artifacts` lists or creates artifacts.
- `GET|POST /api/workspaces/:workspaceId/artifacts/:artifactId/versions`
  preserves an append-only version chain. A new version must name the current
  `parentVersionId`, so stale writers receive `409 VERSION_CONFLICT`.
- `GET .../versions/:versionId/content` returns integrity-checked bytes as an
  attachment with `nosniff` enabled.

Artifact bytes default to `workspace-artifacts/` beside the backend and may be
moved with `MIAOS_ARTIFACT_DIR`. The current limit is 8 MiB per version. This
slice has no frontend placement or public-link sharing yet. Workspace creation
and membership mutations require an interactive cookie session; bearer API
keys cannot change that authorization boundary.
