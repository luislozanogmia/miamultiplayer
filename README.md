# Mia

## The vision
**Easy, powerful AI for everyone, regardless of technical ability.**

## Starting point
Mia Solo is the starting point. Mia Multiplayer is where I want to go: humans working together with personal Agents and shared Bots.

## The core principles guiding the development
- AI should become useful to everyone, not only power users, giving everyone the opportunity to contribute with their ideas, knowledge and creativity.
- Forcing people to become tech-savvy before technology becomes useful creates an unnecessary barrier. It increases time-to-action, takes time away from creativity and expertise, and excludes people who simply don't want to make the technical deep dive. I'll share more in the upcoming UX research on the website.

## How it works
**This is the app. Edit it at will — and you can still be part of our ecosystem by signing in. Your choice.**

Mia is open source, model and harness agnostic. Two equally supported ways to run it:

- **Sign in with Mia** (the default): creating an account is the authorization — the app calls the Mia Router and a budget-capped model key is minted for you automatically. No setup, just chat. How that call works is right here in the repo ([backend/server.js](backend/server.js), managed-router section); the service itself runs on our infrastructure and answers only to signed-in users.
- **Bring your own** subscription or API key (OpenRouter, Anthropic, OpenAI, xAI, …): fully standalone, no account, nothing of yours ever touches our servers.

Nothing personal is baked into this repo — every credential is created on your machine at install time. Our working practices live in [`operations/`](operations/) if you want to see how we build and test Mia.

Product information is available at [miamultiplayer.com](https://miamultiplayer.com).
The canonical source repository is
[`luislozanogmia/mia_multiplayer`](https://github.com/luislozanogmia/mia_multiplayer).

## Design decisions
Mia follows a simple hierarchy: **Humans → Agents → Bots.**
- **Humans** are the users.
- **Agents** are each user's private, personalized AI. Only the owner can interact with their Agent.
- **Bots** are shareable. In Multiplayer, anyone in the workspace can interact with and manage shared Bots.

### What this looks like in practice
- Each human starts with one Agent. Multi-agent support may come later.
- The Agent can do everything a Bot can do, but Bots do not have access to the full harness.
- Users and Agents can manage Bots directly. Bots cannot manage other Bots.
- Mia owns each Bot's identity. We do not use the harness' built-in bot capability.
- Bots do not have access to files, durable memory, prior sessions, password management, or general skills.

## Platforms
Mia currently supports:
- macOS on Apple silicon through a signed and notarized DMG
- Ubuntu on x86-64 through a standalone Debian package or local installation

## Source checkout and standalone releases
The Git repository contains Mia's source code and packaging instructions. It does
not vendor Hermes Agent, Ghost CLI, or a Python runtime. When Mia is built from a
fresh clone, the build workflow downloads the exact pinned dependency revisions
directly from their canonical repositories.

The finished macOS DMG and Ubuntu Debian package (`.deb`) bundle the curated,
tested application runtime:

- Hermes Agent (current harness, we'll include codex and others in the next major release)
- Ghost CLI's in-app browser connector (browser automation build by me)
- Python and its required environment
- Electron
- Backend and frontend dependencies
- Mia's bot, automation, browser, and local workspace modules

Installing and starting Mia from the DMG or `.deb` does not download these
components. Internet access is required only for capabilities that inherently use
the network, including online model providers, web browsing, and connected
services.

The exact dependency versions are pinned in:
- `scripts/hermes-release.env`
- `scripts/ghost-release.env`
- `scripts/python-release.env`

No model-provider credentials or personal runtime state are included in release
artifacts.

## Repository structure
- `backend/` — local API, persistence, model dispatch, bots, and automations
- `frontend/` — Mia's application interface
- `macos/` — Electron desktop shell and macOS/Ubuntu packaging
- `modules/` — bundled Mia capabilities
- `scripts/` — clean-slate, installation, packaging, and verification workflows
- `ops/` — optional service deployment resources
- `test-lab/` — isolated interface test harness

## macOS release build
A macOS release build starts from a clean source checkout. During the build —not
during end-user installation— it downloads the pinned dependencies and bundles
them into Mia. It then signs the application, creates the DMG, notarizes it, and
staples the notarization ticket.

```bash
export MIAOS_MAC_SIGN_IDENTITY="Developer ID Application: Luis Lozano (9F277BG847)"
export MIAOS_MAC_NOTARY_PROFILE="miaos-notary"
export MIAOS_MAC_PROVISIONING_PROFILE="/absolute/path/to/Mia_Developer_ID.provisionprofile"
export MIA_GOOGLE_OAUTH_CLIENT_ID="<official Desktop OAuth client ID from the release environment>"
# Also inject MIA_GOOGLE_OAUTH_CLIENT_SECRET from the maintainer's secret store.
# Never paste credential values into source files or shell history.

./scripts/clean_slate_mac.sh --apply
./scripts/install-local-mac.sh
```

The resulting artifact is written to:

```text
macos/dist/Mia-<version>-arm64.dmg
```

For an unsigned local development build, omit the signing and notarization
environment variables. Official builds receive `MIA_GOOGLE_OAUTH_CLIENT_ID`
and `MIA_GOOGLE_OAUTH_CLIENT_SECRET` through the maintainer's approved 1Password
launch/build wrapper. No actual registration values belong in this repository.
The same inputs work in dev mode. Forks supply their own Google Desktop OAuth
registration; builds without a client ID omit Google connection. Official builds
fail closed if either value is missing. Google requires the client secret for
our token exchange and refresh; it is extractable from a distributed desktop app
and does not prove an app is an official release. User tokens are separate and
stored using platform encryption, never included in the build.

## Ubuntu build and installation
To create a fresh local Ubuntu installation from the pinned source revisions:

```bash
./scripts/clean-local-install.sh --apply
./scripts/install-local.sh
```

Mia is then available from the Ubuntu application menu. The internal development
launchers are also installed under `~/.local/bin/`.

The standalone Ubuntu installer is a Debian package (`.deb`). Its builder is:

```bash
npm --prefix macos run package:linux
```

It produces the release package and corresponding SHA-256 and SPDX metadata under
`macos/dist/`.

## Clean-slate verification
The cleanup workflows remove Mia-managed application state, bundled runtimes,
credentials, caches, databases, services, and launchers while preserving source
repositories, GitHub authentication, SSH keys, and unrelated applications.

```bash
./scripts/clean_slate_mac.sh --verify
./scripts/clean-local-install.sh
```

## License

Copyright © 2026 Mia Labs and contributors. Licensed under the MIT License.
[MIT License](LICENSE).

Hermes Agent and Ghost CLI are separate MIT-licensed projects. See
[Third-party notices](THIRD_PARTY_NOTICES.md) for details.
