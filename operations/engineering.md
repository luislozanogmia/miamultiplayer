# Engineering — how we ship

## One environment: os.example.com

After each session we need to push to Github. Never keep local ahead of github.

Everything we build ships straight to
**os.example.com** (the Vultr VM). That URL *is* the product, and it is also
our daily working environment. ld

**Why:** The flagship deployment is our own instance. We should always be
in dev mode — and for us, **dev mode = production mode**. Living inside the
thing we're building is how we find what's broken and what's missing; a local
copy that only an engineer sees just hides the product from the people who use
it. If a change is good enough to keep, it's good enough to be live.

**Clients are different.** When we have a client, their instances get a real
dev/production separation (staging, gated deploys, the usual care). We build
that discipline when there's a client to protect — not for ourselves. (Not
built yet; revisit at the first client.)

**Dogfooding is not automatic deployment.** We use Mia to improve Mia, so the
live instance is both our product and our daily QA environment. A commit only
records code in Git; it does not make that code live. Push, bundle deployment,
restart, and live verification remain explicit delivery steps.

## The ship loop

1. Work on `main` (or land a branch into `main` the moment it's real).
2. Push to GitHub (`origin/main` is the source of truth).
3. Deploy to the VM: git bundle → scp → pull → restart `mia-os-v2` (user
   unit, port 4871) → `curl /healthz`. Canonical steps live in the deploy
   notes; the whole loop is a couple of minutes.
4. Verify in the live UI at os.example.com. That check *is* QA.

Old deploys are kept as zips next to the app folder on the VM, not as live
directories — one running version, one rollback archive.

## Logs

`product.md` (this folder) is the single running product log — what shipped
and why. No per-version doc files. This file only holds the engineering
ground rules.

## Clean slate must also reset Hermes (checklist, added 2026-09-11)

Today `Settings → Clean slate` (`POST /api/dev/clean-slate`) only deletes the
Solo bots, automations, conversations, messages, attachments, and the
renderer's localStorage. Everything Hermes-side survives, which is how a
DeepSeek key ended up stored under the OpenAI slot and every resumed
conversation kept dispatching to api.openai.com after a "clean" reset.
A clean slate is not clean until all of these are gone:

- [x] **Harness preference** — `settings.harnessByUser[owner]` (provider,
      apiProvider, model, fast, onboardingComplete). Delete the owner's entry
      so onboarding runs again.
- [x] **Hermes credentials** — every `credential_pool` entry Mia added in
      `<App Support>/Mia/hermes/auth.json` (`hermes auth remove` per provider,
      or drop the file for the Mia-managed HERMES_HOME). Copilot/GitHub tokens
      that Mia did not add stay.
- [x] **Hermes stored sessions** — the per-profile `state.db` rows (sessions,
      messages, session_model_usage) for the `miaos-agent-runtime` and
      `miaos-bot-worker` profiles. A stale row pins the old provider, model,
      and API key as `model_override`; see the resume re-pin in
      `hermes-gateway-client.js#applySessionSelection`.
- [x] **Stored session ids in Mia's DB** — conversations keep
      `storedSessionId`; deleting Solo conversations already drops them, but
      Multiplayer/bot conversations do not, so a Hermes wipe must also clear
      those ids or the next turn resumes a session that no longer exists.
- [x] **Hermes profile config** — nothing to reset: `config.yaml` is static,
      MiaOS-managed, and rewritten from `hermes-bot-profile.js` on every
      backend start (`provisionHermesRuntimeProfiles`). Per-session model,
      reasoning, and tier live on the session rows deleted above.
- [x] **Gateway restart** — clean slate stops the gateway MiaOS started and
      starts a fresh one (`restartHermesGatewayRuntime`), so live agents and
      the in-memory credential pool are gone, not just the files. An external
      gateway is never adopted and therefore never restarted.
- [x] **Model inventory cache** — `rememberNativeChatModelInventory` and the
      renderer's cached composer choice, or the picker keeps showing the old
      provider's models.
- [x] **Confirm copy** — the dialog currently promises "connected apps will
      not be changed"; change it once credentials are included.
- [ ] **Verify** — after the reset, `hermes auth status` shows no Mia-added
      providers, `/api/model/options` returns only unconfigured providers, and
      the first message after reconnecting a key dispatches to that provider
      (check `miaos-server.log` for the dispatch line, not just the UI).

### Scope "everything" (added 2026-09-12)

The Solo-only reset above was still not "from 0": Multiplayer Test bots, the other
workspaces' conversations, connected apps, and a dead API key stored in
`hermes/profiles/miaos-agent-runtime/auth.json` all survived, and the
in-memory backend caches with them. `Settings → Clean slate` now sends
`scope: "everything"` to `POST /api/dev/clean-slate`, which:

- removes every bot's cron job, aborts every active dispatch, and deletes
  conversations for every company id (events, members, dispatches, user
  state cascade) plus bots, agents, rooms, trash, memberships, permissions,
  background tasks, chat history, API keys, Google connections, OAuth states,
  invites, audit log, workspaces and their artifacts; resets `settings` to
  defaults; keeps only the caller's user row and session;
- empties the attachment, workspace-artifact, and automation-artifact
  directories;
- runs `hermes auth logout` for every provider found in any `auth.json`
  (home or profile), stops the owned gateway, wipes the Hermes home
  (`backend/hermes-home-reset.js`: auth files, state.db, projects.db,
  sessions, memories, cron, pairing, logs, media caches, spawn ledger, at the
  top level and in every profile), re-provisions the managed profile
  configs, and starts a fresh gateway. The hermes-agent checkout, install id,
  gateway token, SOUL.md, skills, hooks, and model-catalog caches stay so the
  next boot needs no network. An external gateway is never adopted, so if one
  is running its state.db is left alone and reported in `hermesFailures`;
- in the desktop app, the renderer then clears localStorage/sessionStorage
  and asks the shell (`miaos-reset-relaunch`) to drop Electron storage, the
  renderer/browser state files, and relaunch the app, which restarts the
  backend and clears every in-memory cache. A plain browser session reloads.

`scope` omitted or `"solo"` keeps the older Solo-only behaviour for the
existing tests and API users. Coverage: `backend/hermes-home-reset.test.mjs`
and the "scope everything" case in `backend/local-boundary.test.mjs`.

`scripts/clean_slate_mac.sh` (uninstall-level reset) already removes the
whole Hermes home; the in-app clean slate should converge on the same list
minus the app bundle.
