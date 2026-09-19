# Windows Portability Audit — backend/, modules/, frontend/

Scope: runtime code only (tests, docs, and dev scripts excluded). Repo root:
`the engineering workspace`. Report-only; no code changed.

General verdict: the codebase is unusually disciplined about `path.join` /
`path.delimiter` / `os.tmpdir()` — there are **no hardcoded POSIX path joins,
no `/tmp` usage, no symlink creation, and no `sh -c`/`shell: true` spawns** in
backend runtime code. The Windows risk is concentrated in four areas:
(1) spawning the packaged Hermes/gws launchers, which are `.cmd` files on
Windows; (2) the child-process **environment allowlists**, which pass only
Unix variables; (3) the **bash shell guard** and `miaos-hermes-bin` sh shims,
which are the browser/credential security boundary and are inert on Windows;
(4) the **Ghost in-app browser bridge**, which is a Unix domain socket.

---

## BLOCKER — app won't start or a feature is dead

### B1. Every spawn/execFile of `HERMES_BIN` fails on Windows (`.cmd` + no shell)

> **FIXED (0.2.9 dev):** packaged Windows builds now publish the Hermes
> launcher as an argv vector in `MIAOS_HERMES_ARGV_JSON`
> (`macos/src/main.cjs`, `preparePackagedRuntime`), and every backend call
> site launches through `configuredHermesLaunch` (`backend/runtime-paths.js`)
> — `spawnHermesCli`/`execFileHermesCli` in `server.js`, the `launch` vector
> in `hermes-gateway-client.js`, and `runHermes` in `cron-sync.js`. The `gws`
> launcher is a native `.exe` on Windows and spawns directly. No
> `shell: true` anywhere.
On Windows the Electron launcher points `HERMES_BIN`/`HERMES_GWS_BIN` at
`runtime\bin\hermes.cmd` / `gws.cmd` (`macos/src/main.cjs:43-53`,
`runtimeLauncherPath`). Node ≥ 18.20/20.12 (CVE-2024-27980 fix) **throws
`EINVAL` when `spawn`/`execFile` is given a `.bat`/`.cmd` without
`shell: true`**. Every Hermes CLI call in the backend does exactly that:

- `backend/hermes-gateway-client.js:113` — `execFile(binary, ['gateway', 'stop'], {...})`
- `backend/hermes-gateway-client.js:234` — `this.spawnImpl(this.binary, ['serve', '--host', '127.0.0.1', ...])` — the gateway itself; **chat is dead**.
- `backend/server.js:2848` — `spawn(configuredHermesBinary(), ['auth', 'add', provider, ...])`
- `backend/server.js:2903, 2941, 2971, 2993` — auth logout / api-key add / auth status / `--version`
- `backend/cron-sync.js:84` — `execFile(requiredConfiguredExecutable('HERMES_BIN', ...), ['cron', '--accept-hooks', ...])`
- `backend/google-account-connector.js:114, 310` — `execFile(file, args, ...)` / `spawn(file, args, ...)` where `file` is the `gws` launcher.

Why it breaks: `EINVAL` at spawn time; gateway never starts, provider auth,
cron sync, and Google connector all dead.
Fix: don't ship `.cmd` launchers as `HERMES_BIN`. Either point `HERMES_BIN`
at a real `.exe` (the venv `Scripts\hermes.exe` entry point or
`python.exe -m hermes` via `HERMES_PYTHON`), or wrap each call site in a
helper that on win32 rewrites `[bin, args]` → `[HERMES_PYTHON, ['-X', ...,
entrypoint, ...args]]`. Do **not** fall back to `shell: true`: cron prompts
(`cron-sync.js` `--prompt <bot text>`) contain arbitrary user text and
`cmd.exe` metacharacter quoting would become a command-injection surface.

### B2. Child env allowlists omit every Windows-critical variable

> **FIXED (0.2.9 dev):** `HERMES_ENV_ALLOWLIST` (`inference.js`),
> `HERMES_CREDENTIAL_ENV_KEYS` (`server.js`), and gws
> `processEnvironment` (`google-account-connector.js`) now pass the win32
> set (`SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`,
> `USERPROFILE`, `TEMP`/`TMP`, …) plus `PYTHONPATH`/`PYTHONNOUSERSITE` for
> the argv launch vector, and `MIAOS_HERMES_PROCESS_HOME` isolation also
> rewrites `USERPROFILE` on win32.
`backend/inference.js:356-398` (`HERMES_ENV_ALLOWLIST` → `hermesProcessEnv()`)
and `backend/server.js:2775-2790` (`HERMES_CREDENTIAL_ENV_KEYS`) whitelist
only `PATH, HOME, LANG, TMPDIR, USER, SHELL, TERM, XDG_*, ...`.

- `backend/inference.js:358` — `'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', ...`

Why it breaks: on Windows the Hermes/gws/Python children are spawned without
`SystemRoot`, `SYSTEMDRIVE`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`/
`TMP`, `COMSPEC`, `PATHEXT`, `PROGRAMDATA`. CPython on Windows fails hard or
subtly without `SystemRoot` (winsock/ssl/`os.urandom` init errors), `Path.home()`
and keyring/file stores need `USERPROFILE`/`APPDATA`, and any nested `cmd`
needs `COMSPEC`. Effectively every Hermes child is broken even after B1.
Fix: extend both allowlists with the win32 set (gate on `process.platform`),
and map `HOME` → `USERPROFILE` when `MIAOS_HERMES_PROCESS_HOME` isolation is
applied (`inference.js:388-389`, `server.js:2786-2787` set `env.HOME` only).
Same fix for `backend/google-account-connector.js:94-101`
(`processEnvironment()` passes only `PATH`, `HOME`, `TMPDIR`, `LANG…`).

### B3. Bash shell guard + sh shims: browser/credential policy is inert
The runtime security boundary is written in POSIX shell:

- `backend/hermes-bot-profile.js:49` — `const SHELL_GUARD = \`#!/bin/bash …\`` — functions overriding `open`, `osascript`, `xdg-open`, Chrome/Firefox/Edge, `playwright`.
- `backend/hermes-bot-profile.js:205-206` — guard written as `miaos-shell-guard.sh` and injected via Hermes `terminal.shell_init_files` (`hermes-bot-profile.js:138-142`), plus `auto_source_bashrc` — bash-only concepts.
- `backend/miaos-hermes-bin/open`, `backend/miaos-hermes-bin/gh` — `#!/bin/sh` shims prepended to `PATH` (`inference.js:35,394-396`; `server.js:145,2788`). Windows `CreateProcess` does not honor shebangs; extensionless files are not executable at all, so the shims silently do nothing.

Why it breaks: the app may run, but bots get an unguarded terminal — external
browser launches and ambient `gh` credentials are no longer blocked, and the
Hermes terminal toolset may fail outright trying to source a `.sh` init file
under PowerShell/cmd. This is a **security regression**, not just a lost
feature; ship search-only (`MIAOS_AGENT_SEARCH_ONLY`) on Windows until fixed.
Fix: provide a PowerShell profile / cmd doskey equivalent for the guard
(block `start`, `explorer`, `msedge`, `chrome`, `powershell -c Start-Process`)
and `.cmd`+`.exe` shims (`open.cmd`, `gh.cmd`) in `miaos-hermes-bin`; write
`miaos-shell-guard.ps1` and pass it only when the Hermes Windows shell
supports init files. (The `shell-guard-win` agent owns this.)

### B4. Ghost in-app browser bridge is a Unix domain socket
- `macos/src/main.cjs:423` — `process.env.GHOST_MIA_SOCKET = path.join(bridgeRoot, "bridge.sock")` (and `:1605` `socketPath:`), consumed by `backend/miaos-ghost-cli.py:67-78` (`GHOST_IN_APP_BROWSER_SOCKET` → `transport_class(socket_path=...)`) and passed through the backend allowlist (`inference.js:378`).

Why it breaks: Node can listen on `\\.\pipe\...` named pipes, but the pinned
Python transport (`in_app_browser_transport.py` in `GHOST_CLI_HOME`) uses
`AF_UNIX` connect semantics; Windows AF_UNIX support does not interoperate
with Node named pipes, and `bridge.sock` as a filesystem AF_UNIX path only
works on Win10 1803+ **and** only if both ends use AF_UNIX. The embedded
browser toolchain (`ghost-cli`, `ghost_file_open`, the whole
`modules/browser/SKILL.md` contract) is dead otherwise.
Fix: on win32 have Electron listen on AF_UNIX (`server.listen(sockPath)` with
Node supports it on Win10+) and keep the Python side AF_UNIX too — or switch
the bridge to loopback TCP + token file on Windows. Verify the pinned
transport file; it lives in the ghost-cli runtime payload, not this repo.

### B5. `requiredConfiguredExecutable` PATH probe ignores `PATHEXT`
- `backend/runtime-paths.js:38-48` — `path.join(directory, configured)` + `fs.statSync(candidate).isFile()` for a bare command name.
- Same pattern: `backend/google-account-connector.js:80-86` (`executableOnPath('gws', ...)`).

Why it breaks: a bare `HERMES_BIN=hermes` (dev/unpackaged config) never finds
`hermes.exe`/`hermes.cmd`; startup throws `Mia HERMES_BIN does not resolve on
PATH`. With absolute packaged paths this is bypassed, so it blocks dev/CI
setups, not the packaged app.
Fix: on win32, try `name + ext` for each ext in
`(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')`. Note
`fs.accessSync(X_OK)` is a no-op on Windows — acceptable, leave as-is.

---

## DEGRADED — feature limps or is intermittently broken

### D1. Google Workspace MCP silently disabled when `HOME` is unset
- `backend/hermes-bot-profile.js:88-89` — `const userHome = String(process.env.HOME || '').trim(); if (!python || !gws || !userHome) return [];`

`HOME` is normally unset on Windows, so `googleWorkspaceMcpConfig()` returns
`[]` and every bot/agent profile is written without the Google MCP server —
no error, feature just vanishes.
Fix: `process.env.HOME || process.env.USERPROFILE`, and pass `USERPROFILE`
in the MCP server env block (`hermes-bot-profile.js:103`).

### D2. SIGTERM/SIGKILL semantics: no graceful gateway shutdown
- `backend/hermes-gateway-client.js:790,794,806` — `child.kill('SIGTERM')` then `SIGKILL` escalation; `backend/server.js:2802,2863,2882,2914,2959`, `backend/google-account-connector.js:323,365` — `SIGTERM` on auth/login children.
- `backend/server.js:5963-5964` — `process.once('SIGTERM'|'SIGINT', shutdownBackend)`.

Why it degrades: on Windows `child.kill()` is an unconditional
`TerminateProcess` — the Hermes gateway never flushes/checkpoints its SQLite
state or runs its own shutdown hooks; the SIGTERM→SIGKILL grace window is
meaningless. Inbound, `SIGTERM` is never delivered on Windows, so
`shutdownBackend()` only runs on Ctrl+C (`SIGINT` emulation); when Electron
stops the backend (`macos/src/main.cjs:646-651` already calls plain `kill()`
on win32) the HTTP server/WebSocket close path is skipped. WAL journaling
makes this survivable but leaves stale `spawn-ledger`/lock files.
Fix: keep as-is but add a cooperative shutdown channel on win32 (e.g. the
gateway's own `gateway stop` RPC before `kill()`, and an IPC/stdin sentinel
from Electron to the backend instead of relying on SIGTERM).

### D3. `runHermesApiKeyAdd` fed the key over a stdin pipe — FIXED (worse than first assessed: every API-key add hung on Windows)
- `backend/server.js` — was `spawn(..., { stdio: ['pipe','ignore','ignore'], detached: true })` + `child.stdin.end(apiKey)`.

The original write-up flagged only the console flash from `detached: true`.
The real failure was a hang: Hermes' secret prompt delegates to Python
`getpass` when stdin is not a tty, and on Windows `getpass` reads the
**console** via `msvcrt.getwch()`, never the stdin pipe — with no console
attached the child blocks forever and Mia's 15s timeout reports
"API credential setup timed out" for every API-key provider (DeepSeek,
OpenAI, Anthropic keys, …). OAuth providers were unaffected.

Fixed by passing the key on Hermes' documented `--api-key` flag with all
stdio discarded — one platform-neutral code path, no dependence on the
harness's prompt internals (the stdin feed was never CLI contract). The
argv value is visible to same-user processes for the sub-second the
command runs; hermes' on-disk credential store has the same trust
boundary. Verified on gawain: `auth add deepseek --type api-key
--api-key …` completes in 0.6s (previously hung indefinitely).

### D4. Filename policy allows Windows-invalid/reserved names
- `backend/artifact-policy.js:59-66` — `isSafeArtifactFilename` blocks `/`, `\\`, NUL, controls — but not `< > : " | ? *`, trailing dot, or reserved device names (`CON.txt`, `NUL.md`, `COM1.csv`).

Why it degrades: a model-generated artifact named `results:final.csv` or
`aux.txt` makes `fs.writeFile` fail (`EINVAL`) or silently target a device;
`:` additionally means an NTFS alternate data stream. Attachment/artifact
save then errors per-file.
Fix: extend the check with `/[<>:"|?*]/`, `/[. ]$/`, and
`/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i`.

### D5. Case-sensitive path-containment checks
- `backend/artifact-policy.js:94-98` — `absolute.startsWith(\`${root}${path.sep}\`)`.
- `backend/server.js:361-373` — `runtimeStorageDir` compares `fs.realpathSync` results with `canonical.startsWith(\`${sourceRoot}${path.sep}\`)`.

Why it degrades: NTFS is case-insensitive; `C:\Data` vs `c:\data` (drive
letter casing varies by how the process was launched) makes containment
checks give false negatives — the server.js guard then wrongly **rejects** a
valid `MIAOS_ARTIFACT_DIR` at boot (throws), and the artifact-policy guard
could be sidestepped in adversarial input. Fix: compare
`path.resolve(x).toLowerCase()` on win32 (or use `path.relative` + check for
`..`/absolute).

### D6. Hermes home reset vs. Windows file locking
- `backend/hermes-home-reset.js:98-99` — `fs.rmSync(target, { recursive: true, force: true })` on `state.db`, logs, sessions.
- `backend/server.js` `removeDirectoryContents` (near :1725) — same pattern.

On Windows, deleting a file any process still has open fails with
`EBUSY`/`EPERM` instead of POSIX unlink-while-open. The code already requires
the gateway to be stopped and collects failures, but the stop is
`TerminateProcess` (D2) with a race before handles close; resets will
intermittently report failures. Fix: after `stopOwnedGateway()`, retry
`rmSync` with backoff (`maxRetries`/`retryDelay` options of `fs.rm`).

### D7. Cron scheduler timezone probe assumes a working Python child
- `backend/cron-sync.js:145, 402` — `execFile(HERMES_PYTHON, ['-c', source, ...], { cwd: HERMES_AGENT_ROOT, env: hermesProcessEnv() })`.

Blocked by B2 (env) and fine once fixed — `HERMES_PYTHON` is already
`Scripts\python.exe` on win32 (`macos/src/main.cjs:33-34`). Listed here so
the integrator retests bot automations after B1/B2 land. The
`fs.chmodSync(..., 0o700/0o600)` calls (`cron-sync.js:104,116,132`) are
harmless no-ops on Windows; no code reads mode bits back anywhere in
backend/ (verified).

### D8. `hermesGatewayLooksAlive` PID probe
- `backend/server.js:1717` — `process.kill(pid, 0)`.

Works on Windows (existence check), but PID reuse is more aggressive and the
spawn-ledger is written by Hermes; treat as advisory. No change strictly
required — verify Hermes writes the ledger on Windows at all.

---

## COSMETIC — note and move on

- `backend/admin.js:156` — `execSync('git rev-parse --short HEAD')`: already wrapped in try/catch → `null` when git absent. No action.
- `backend/speech-service.py:28-31` — `MODEL_DIR + "/encoder.int8.onnx"`: forward slashes are accepted by Win32 APIs; also this service is **not wired to anything** in backend/ or macos/src (no spawner, no port-4875 client found) — dead code for now.
- `backend/db.js:203`, `backend/hermes-bot-profile.js:150-190`, `backend/miaos-workspace.js:37-59`, `backend/hermes-web-search-config.js:70-79`, `backend/hermes-gateway-client.js:84` — `chmod 0o600/0o700`: no-ops on Windows, already commented "best effort on Windows". Real Windows privacy would need ACLs (`icacls`) — out of alpha scope; note that the DB/token files are world-readable to other local users only in multi-user setups.
- `backend/admin-cli.js:1`, `modules/bot-creation/scripts/miaos-bot.js:1` — `#!/usr/bin/env node` shebangs: both are invoked as `node <file>`; harmless.
- `backend/chat-security.js:47` — debug log at `path.join(os.tmpdir(), ...)`: correct pattern, fine.
- `backend/test.sh`, `scripts/*.sh` — dev/CI only (mac install/start scripts); Windows needs equivalents but nothing runtime imports them.
- `modules/browser/SKILL.md:38` — prompt text says "Never use macOS `open`…"; add Windows wording (`start`, `explorer`) when the guard (B3) is ported. Prompt-only; no code impact.
- `frontend/` — clean: keyboard shortcuts already accept `metaKey || ctrlKey` (`frontend/app.js:686`); no platform assumptions found in served JS.
- Symlinks: **no `fs.symlinkSync`/`linkSync` anywhere in runtime code** — only defensive `lstat().isSymbolicLink()` rejection (`cron-sync.js:100-124`, `miaos-workspace.js:33-58`), which works fine on Windows.
- `writeAtomic` temp-file + `renameSync` (`hermes-bot-profile.js:150`, `miaos-workspace.js:40`, `hermes-web-search-config.js:76-82`): `rename` over an existing file works on Windows in Node (MoveFileEx replace), but fails if a reader holds the destination open — low risk, config files are read briefly.

### better-sqlite3 (note only)
`backend/package.json` pins `better-sqlite3 ^13.0.3`. Prebuilt binaries exist
for win-x64 Node; but the backend runs under the Electron-bundled Node
(spawned by `main.cjs`), so the ABI must match whatever `node.exe` the
Windows package ships. If the backend runs under Electron's own runtime
instead of a bundled node.exe, `electron-rebuild` (or the module's Electron
prebuilds) is required, and the packager must not sign-then-mutate. Also
verify the Hermes `fts5_cjk` native SQLite extension
(`runtime/hermes/native/fts5_cjk/build.sh` in the payload) has a Windows
build — that's the runtimes-win-installer agent's territory.

---

## Prioritized fix list

1. **B1** — spawn strategy for `.cmd` launchers (or ship `.exe` entry points). Everything else is unreachable until this works.
2. **B2** — Windows env passthrough in `hermesProcessEnv`, `hermesCredentialProcessEnv`, `processEnvironment` (google connector), `googleWorkspaceMcpConfig` env block.
3. **B4** — Ghost bridge transport on Windows (AF_UNIX both ends, or TCP+token).
4. **B3** — Windows shell guard + `.cmd` shims; until then force `MIAOS_AGENT_SEARCH_ONLY` on win32 builds (security).
5. **D1** — `HOME || USERPROFILE` (one-line, unblocks Google MCP).
6. **B5** — PATHEXT-aware executable resolution (unblocks dev setups/CI).
7. **D4 + D5** — filename policy and case-insensitive containment (correctness + security hygiene).
8. **D2 + D3 + D6** — shutdown/detached/rm-retry polish.

## Files the integrator must touch

Backend (this audit's scope):
- `backend/inference.js` (B2)
- `backend/server.js` (B1 call sites, B2, D2, D3, D5, D6)
- `backend/cron-sync.js` (B1 call sites)
- `backend/hermes-gateway-client.js` (B1, D2)
- `backend/google-account-connector.js` (B1, B2, B5)
- `backend/hermes-bot-profile.js` (B3, D1)
- `backend/miaos-hermes-bin/` (B3 — add `open.cmd`, `gh.cmd`, ps1 equivalents)
- `backend/runtime-paths.js` (B5)
- `backend/artifact-policy.js` (D4, D5)
- `backend/hermes-home-reset.js` (D6)
- `backend/miaos-ghost-cli.py` (B4, jointly with the ghost-cli transport payload)

Adjacent (owned by other agents, listed for coordination):
- `macos/src/main.cjs` (already partially win32-aware: launcher paths, venv python, TerminateProcess comment; needs the bridge-socket and backend-shutdown pieces — `main-cjs-win`)
- Hermes runtime payload / `setup-hermes.sh`, `fts5_cjk/build.sh` (`runtimes-win-installer`, `win-packager`)
- Shell guard port (`shell-guard-win`)
