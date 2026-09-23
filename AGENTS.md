# AGENTS.md — working on the Mia repo

For anyone developing Mia, human or AI agent. This repo is public, history
included.

This file is for developing Mia. It is not the workspace `AGENTS.md` that the
app writes into the user's Mia workspace (`backend/miaos-workspace.js`).

## Secrets

- No API keys, tokens, signing secrets, customer data, or `.env` contents
  anywhere in the repo: code, comments, docs, tests, or commit messages.
- AI agents never see secret values. When a task needs a secret at runtime,
  use it in-process from its store without printing it, or hand the task to
  a human.
- Public identifiers (Clerk publishable key, issuer, JWKS public key, Mia
  Router endpoint) are committed on purpose; they do nothing without a
  signed-in user.
- The pre-commit hook (`.githooks/pre-commit`) scans for leaks. Never bypass
  it with `--no-verify`.

## How we work

- **No AI attribution** in commits, PRs, or comments.
- **Evidence before claims.** Don't say "fixed" or "works" until you've run
  it. Say what you tested and what you didn't.
- **Test in dev mode before building.** `scripts/dev_mode.sh` runs the app
  from the checkout. Building a release to find a bug costs 20+ minutes.
- Engineering and product practices live in `operations/`.

## Dev mode vs installed app

| | Dev mode (`scripts/dev_mode.sh`) | Installed `/Applications/Mia.app` |
|---|---|---|
| Data | `~/.miaos` | `~/Library/Application Support/Mia` |
| Bots | `backend/bots` (git-ignored) | `.../Mia/bots` |
| Hermes runtime | `~/.miaos/hermes` | copy in `.../Mia/hermes/hermes-agent` |
| Clerk | production (same as the app) | production |

- Dev mode and the installed app share the Hermes port. Quit one before
  starting the other.
- `backend/bots` holds your personal bots when running from the checkout.
  Never commit it. `bots-catalog/` (repo root) holds the public store
  templates and is tracked.
- Mia Router accepts only **production** Clerk sessions. A test-instance
  sign-in gets "invalid session token".
- Never run `scripts/clean_slate_mac.sh --apply` on a machine with real data:
  it wipes `~/Library/Application Support/Mia`.

## Rules learned the hard way

- **The bots folder is the source of truth.** Each bot's folder (`AGENTS.md`,
  schedule) wins over the database copy. No bots folder means 0 bots: create
  it and continue, never crash. Mia's own agent is not a bot and is always
  present.
- **Hermes is pinned** in `scripts/hermes-release.env` and patched at install
  by `scripts/hermes-*.patch`. A new patch must apply cleanly to the pinned
  commit and go into all three installers (`install-local-mac.sh`,
  `install-local.sh`, `install-runtimes-win.ps1`). Upstream fixes go to
  NousResearch/hermes-agent as a PR, tested per their contributing guide;
  Mia carries the patch until upstream merges.
- **Check what the pinned Hermes accepts.** A field Mia sends that Hermes
  rejects (e.g. `artifact_workspace` on `session.create`) breaks every bot
  chat. After changing Hermes calls, test a real bot chat, not just Mia's
  agent.
- **Signed vs unsigned is not the same as pinned.** The installed app copies
  Hermes out of the bundle, and a signed app refuses native modules stamped by
  another team. The copy is refreshed whenever the app build changes; keep it
  that way.
- **Signed builds can need things ad-hoc builds don't.** The Touch ID passkey
  keychain group needs an embedded Developer ID provisioning profile plus
  application and team identifiers in the signature, or macOS kills the app
  at launch. Ad-hoc builds skip it, so the breakage appears only in the next
  signed build.
- **Passkeys:** Touch ID passkeys created in Mia work. iCloud Keychain
  passkeys need Apple's browser public-key credential entitlement plus native
  code; Electron doesn't ship Chrome's passkey UI. USB security keys don't
  work yet. All three come from one native Apple passkey integration.

## Releases (macOS)

Official builds are signed with Mia's Developer ID, notarized, stapled,
verified, and launch-tested by the maintainers. Unsigned is a failed build,
never a lesser release. The essentials:

1. Build from a clean `main` with every intended branch merged. Read
   `git log v<last>..HEAD -- macos/scripts macos/src` for signing-relevant
   changes.
2. Test in dev mode: Mia's agent, a new bot, a model switch in a resumed chat,
   Mia Router.
3. Bump `macos/package.json` `version` and `CHANGELOG.md`. The updater never
   reinstalls the same version.
4. Build with `scripts/install-local-mac.sh` and `MIAOS_MAC_SIGN_IDENTITY`,
   `MIAOS_MAC_NOTARY_PROFILE`, `MIAOS_MAC_PROVISIONING_PROFILE`.
   `MIAOS_PACKAGE_ONLY=1` leaves the installed app alone so it can test the
   over-the-air update. Needs ~8 GB free and no mounted `Mia` volume; step
   5/9 refuses to package dev-mode provider credentials
   (`~/.miaos/hermes/auth.json`).
5. Publish a GitHub Release with `Mia-<ver>-arm64.dmg`, `.dmg.sha256`,
   `Mia-<ver>-arm64-mac.zip`, `latest-mac.yml`, **and the same DMG as
   `Mia-arm64.dmg`**. The public download link
   `https://github.com/luislozanogmia/miamultiplayer/releases/latest/download/Mia-arm64.dmg`
   breaks if a release lacks that asset.
6. Confirm the installed app updates (log: `.../Mia/miaos-desktop.log`, UTC)
   and retest chat, bots, and passkeys in it.
