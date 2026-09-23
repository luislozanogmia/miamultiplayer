# AGENTS.md — working on the Mia repo

For AI agents (Claude, Codex) and humans developing Mia. Read `CLAUDE.md`
first: the secrets contract there overrides everything here. This repo is
public, history included.

This file is for developing Mia. It is not the workspace `AGENTS.md` that the
app writes into the user's Mia workspace (`backend/miaos-workspace.js`).

## How we work

- **Commits, not a PR per change.** Commit on a `claude/*` or `codex/*`
  branch. Open one PR with everything only when the maintainer says
  "do the PR for review".
- **No AI attribution** in commits, PRs, or comments.
- **Evidence before claims.** Don't say "fixed" or "works" until you've run
  it. Say what you tested and what you didn't. A guess is labeled as a guess.
- **Test in dev mode before building.** `scripts/dev_mode.sh` runs the app
  from the checkout. Building a release to find a bug costs 20+ minutes.
- **Short answers.** Lead with the result, one line where one line works.
- **Never delete.** Move files to the Trash; the maintainer empties it.
- **Other agents share this checkout.** Several Codex and Claude worktrees run
  at once. Don't assume untracked files are yours, and don't rely on untracked
  files surviving.

## Dev mode vs installed app

| | Dev mode (`scripts/dev_mode.sh`) | Installed `/Applications/Mia.app` |
|---|---|---|
| Data | `~/.miaos` | `~/Library/Application Support/Mia` |
| Bots | `backend/bots` (git-ignored) | `.../Mia/bots` |
| Hermes runtime | `~/.miaos/hermes` | copy in `.../Mia/hermes/hermes-agent` |
| Clerk | production (same as the app) | production |

- Dev mode and the installed app share the Hermes port. Quit one before
  starting the other.
- `backend/bots` holds personal bots when running from the checkout. It is in
  `backend/.gitignore`; never commit it. `bots-catalog/` (repo root) holds the
  public store templates and is tracked.
- Mia Router (AWS) accepts only **production** Clerk sessions. A test-instance
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
  NousResearch/hermes-agent as a PR, tested in a clean venv per their
  contributing guide; Mia carries the patch until upstream merges.
- **Check what the pinned Hermes accepts.** A field Mia sends that Hermes
  rejects (e.g. `artifact_workspace` on `session.create`) breaks every bot
  chat. After changing Hermes calls, test a real bot chat, not just Mia's
  agent.
- **Signed vs unsigned is not the same as pinned.** The installed app copies
  Hermes out of the bundle, and a signed app refuses native modules stamped by
  another team. The copy is refreshed whenever the app build changes; keep it
  that way.
- **Signed builds can need things ad-hoc builds don't.** Mia's Touch ID
  passkey keychain group needs the embedded Developer ID provisioning profile
  plus application and team identifiers in the signature, or macOS kills the
  app at launch. Ad-hoc builds skip it, so the breakage appears only in the
  next signed build.
- **Passkeys:** Touch ID passkeys created in Mia work. iCloud Keychain
  passkeys need Apple's browser public-key credential entitlement (requested,
  pending) plus native code; Electron doesn't ship Chrome's passkey UI. USB
  security keys don't work yet (Electron's Touch ID mode is reported to break
  them). All three come from one native Apple passkey integration.

## Releases (macOS)

Every build that leaves the checkout is signed with the Developer ID,
notarized, stapled, verified, and launch-tested. Unsigned is a failed build,
never a lesser release. Maintainers follow the local `app_release` skill; the
essentials:

1. Merge every branch that belongs in the release into `main`; build from a
   clean `main`. Read `git log v<last>..HEAD -- macos/scripts macos/src` for
   signing-relevant changes.
2. Test in dev mode: Mia's agent, a new bot, a model switch in a resumed chat,
   Mia Router.
3. Bump `macos/package.json` `version` and `CHANGELOG.md`. The updater never
   reinstalls the same version.
4. Build with `scripts/install-local-mac.sh` and all three
   `MIAOS_MAC_SIGN_IDENTITY`, `MIAOS_MAC_NOTARY_PROFILE`,
   `MIAOS_MAC_PROVISIONING_PROFILE`. Use `MIAOS_PACKAGE_ONLY=1` so the
   installed app stays on the old version and can test the over-the-air
   update. Needs ~8 GB free and no mounted `Mia` volume; dev-mode provider
   credentials in `~/.miaos/hermes/auth.json` must be moved aside (step 5/9
   refuses to package them).
5. Publish a GitHub Release (maintainer approval required) with
   `Mia-<ver>-arm64.dmg`, `.dmg.sha256`, `Mia-<ver>-arm64-mac.zip`,
   `latest-mac.yml`, **and the same DMG as `Mia-arm64.dmg`**. Invite links use
   `https://github.com/luislozanogmia/miamultiplayer/releases/latest/download/Mia-arm64.dmg`,
   which breaks if a release lacks that asset.
6. Confirm the installed app updates (log: `.../Mia/miaos-desktop.log`, UTC)
   and retest chat, bots, and passkeys in it.

## Open items (as of 0.2.10, 2026-09-23)

- `package-mac.cjs` should write `Mia-arm64.dmg` itself.
- Updater: check free disk space before downloading and say so when it's
  short; show "Restart and install" only after Squirrel finishes unpacking.
- ChatGPT/Grok subscription sign-in should open the system browser: branch
  `claude/subscription-signin-system-browser` (uncommitted work in a separate
  worktree), tested in isolation but not in the app.
- Chats whose bot was deleted show a "native bot … not found" debug error
  instead of saying the bot is gone.
- Mia Router rejections show "That provider is not connected yet" instead of
  the real reason.
- `operations/browser-cookies.md` (copying a site's sign-in from Chrome) is on
  `claude/developer-id-profile` but not in `main`.
- Mia's browser stores cookie values unencrypted on disk.
