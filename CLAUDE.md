# CLAUDE.md — miamultiplayer

This is the one and only Mia repo. Everything committed here is public,
forever (history included). There is no private wrapper, no overlay, no
second repo.

## The secrets contract

**Secrets never touch this repo — and AI agents never touch secrets.**

1. **No secrets. Ever.** No API keys, tokens, signing secrets, customer
   data, or `.env` contents — not in code, comments, docs, tests, or commit
   messages. Real secrets live only in 1Password and in the deployment
   environment (AWS). A human decides on and handles every secret; if a task
   seems to need one here, stop and ask the human.
2. **Agents orchestrate, they don't see.** When a task needs a secret at
   runtime (for example, testing that a stored credential works), write a
   script that reads it from its store and uses it in-process without
   printing it. Secret values must never enter an agent's context or a
   transcript. If a task can't be done that way, hand it to the human.
3. **Public identifiers are not secrets.** The Clerk publishable key,
   issuer, JWKS public key, and the Mia Router endpoint URL are committed
   defaults on purpose: they are the client half of API calls that do
   nothing without a real signed-in user. Admin and server-side
   configuration (Clerk dashboard, AWS Lambda, provisioning keys) lives
   outside this repo entirely — this repo contains only the calls.
4. Before committing, run `git diff --staged` and check rule 1. The
   pre-commit hook (`.githooks/pre-commit`) enforces this mechanically —
   never bypass it with `--no-verify`.

## What lives where

- **This repo** — the entire app, plus `operations/` (how we work:
  engineering practices, product principles, testing playbooks).
- **AWS** — the hosted services (Mia Router minting, budgets) and every
  secret they use. Reachable only with a signed-in user's session token.
- **The user's machine, after install** — everything personal: their
  sign-in, their minted router key, their own provider API keys. Nothing
  personal is pre-baked in the repo; it is all created at install time.

## Repo layout

- `backend/` — Node backend (server, inference, tests as `*.test.mjs`)
- `frontend/` — web UI
- `macos/` — Electron shell
- `modules/` — agent modules and skills
- `operations/` — how we work (engineering, product, testing)
- `scripts/` — install/build scripts
