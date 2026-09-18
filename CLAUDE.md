# CLAUDE.md — miamultiplayer (open-source)

This is the **public, open-source repo**. Everything committed here is visible to the world, forever (history included).

## Hard rules for agents

1. **No secrets. Ever.** No API keys, tokens, URLs to private infrastructure, customer data, or `.env` contents — not in code, comments, docs, tests, or commit messages. If a task seems to require a secret here, stop and ask.
2. **No private-product code.** Subscription/billing (Clerk), managed routing provisioning, and hosted-service config belong in the private wrapper repo, not here. This repo must build and run standalone with a user's own BYOK provider keys.
3. **No references to private paths or the private repo** in tracked files.
4. Gitignored paths (`.env`, `backend/.env.local`, `AGENTS.md`, `modules/*/SKILL.md`, `docs/`, `ops/`) may be overlaid at runtime by a private wrapper. Never commit files at those paths, never "fix" the gitignore to track them, and treat their contents as private.
5. Before committing, run `git diff --staged` and check nothing matches rule 1–3. The pre-commit hook (`.githooks/pre-commit`) enforces this mechanically — never bypass it with `--no-verify`.

## Repo layout

- `backend/` — Node backend (server, inference, tests as `*.test.mjs`)
- `frontend/` — web UI
- `macos/` — Electron shell
- `modules/` — agent modules (SKILL.md files are gitignored overlay points)
- `scripts/` — install/build scripts
