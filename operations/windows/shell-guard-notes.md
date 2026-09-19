# Hermes shell guard — Windows wiring notes

Report for the integrator porting the Hermes terminal shell guard
(`miaos-shell-guard.sh`) to Windows. The PowerShell port lives at
`backend/miaos-shell-guard.ps1`. This document lists every place the .sh guard
is generated, referenced, or enforced, what must change for Windows, and what
cannot be ported 1:1. No shared files were modified.

## 1. What the guard actually is

The guard is NOT a checked-in script. It is a template literal,
`SHELL_GUARD`, embedded in `backend/hermes-bot-profile.js:49-77`, written at
runtime to `<HERMES_HOME>/miaos-shell-guard.sh` (mode `0o700`) by
`guardedWorkspaceTerminal()` (`backend/hermes-bot-profile.js:199-212`,
specifically lines 205-206). It does three things when *sourced* into a bash
session:

1. Defines `miaos_block_external_browser()`: prints
   `Mia browser policy: external browser launch is disabled. Use ghost-cli and
   the embedded Mia browser instead.` to stderr and returns **126**.
2. If `MIAOS_HERMES_GUARD_BIN` names an existing directory, prepends it to
   `PATH` exactly once (lines 56-61). That directory is
   `backend/miaos-hermes-bin/`, holding extensionless `sh` shims: `open`
   (exit 126, browser policy) and `gh` (exit 1, provider isolation).
3. Shadows browser/opener commands with functions that call the blocker:
   `open`, `open_app`, `osascript`, `google-chrome`, `chromium`,
   `chromium-browser`, `firefox`, `brave`, `brave-browser`, `microsoft-edge`,
   `microsoft-edge-stable`, `safari`, `xdg-open`, `playwright` (lines 63-76).

## 2. How Hermes consumes it (the part that decides the Windows strategy)

`guardedWorkspaceTerminal()` returns a terminal config that
`runtimeProfileConfig()` (`backend/hermes-bot-profile.js:134-144`) emits into
each managed profile's `config.yaml`:

```yaml
terminal:
  cwd: "<MIAOS_WORKSPACE_DIR>"
  shell_init_files:
    - "<HERMES_HOME>/miaos-shell-guard.sh"
  auto_source_bashrc: false
```

The Hermes agent (external Python CLI, e.g. installed at
`<HERMES_HOME>/hermes-agent/`) consumes this in
`tools/environments/local.py`:

- `_read_terminal_shell_init_config()` / `_resolve_shell_init_files()`
  (local.py:563-595): reads `terminal.shell_init_files` and
  `auto_source_bashrc`; expands `~`/`${VAR}`; drops missing files.
- `_prepend_shell_init()` (local.py:598-605): prepends POSIX
  `[ -r '<file>' ] && . '<file>' 2>/dev/null || true` lines. It is applied
  **only on login invocations** (`_run_bash(..., login=True)`,
  local.py:775-780) — i.e. the `init_session` env snapshot.
- The snapshot bootstrap (`tools/environments/base_session_env.py:80-113`,
  `_snapshot_bootstrap_script`) captures `export -p`, **function definitions**
  (`declare -F | awk | grep -vE '^_[^_]'` then `declare -f`), and aliases into
  `hermes-snap-<session>.sh`. Every subsequent command sources that snapshot.
  This is how the guard's shell functions and its PATH prepend persist into
  every terminal command, not just the login shell.

**Critical Windows fact:** on Windows, Hermes' terminal toolset still executes
every command through **Git Bash**, not cmd or PowerShell. `_find_bash()`
(local.py:363-390) requires Git for Windows (or `HERMES_GIT_BASH_PATH`) and
raises otherwise; `_run_bash` always invokes `bash -c` / `bash -l -c`. There is
no Hermes config knob to select cmd/powershell as the terminal shell.

### Consequence: the .sh guard remains the primary enforcement on Windows

`shell_init_files` entries are sourced with POSIX `.` by Git Bash, so a `.ps1`
file **cannot** be listed there. The correct Windows wiring is:

- Keep provisioning `miaos-shell-guard.sh` into `shell_init_files` exactly as
  today (it is valid Git Bash), with the fixes in section 4.
- Use `backend/miaos-shell-guard.ps1` for every PowerShell-hosted execution
  surface Mia adds on Windows (installer/watchdog/helper scripts that run
  agent-directed commands, or any future backend path that shells out via
  `powershell.exe`). It must be **dot-sourced** into the session (e.g.
  `powershell -NoExit -Command ". '<path>\miaos-shell-guard.ps1'; <cmd>"` or
  via a Mia-owned `-File` wrapper that dot-sources first). Note that
  `powershell -NoProfile` does not affect it either way — it is not a profile;
  the host must source it explicitly per process.

## 3. Every reference to the guard / guard-bin, file:line

Generation and profile wiring (`backend/hermes-bot-profile.js`):

- `:49-77` — `SHELL_GUARD` template (the .sh source of truth).
- `:56-61` — guard's own `MIAOS_HERMES_GUARD_BIN` PATH prepend (colon-joined —
  see section 4.2).
- `:134-144` — `runtimeProfileConfig` emits `terminal.cwd`,
  `shell_init_files`, `auto_source_bashrc` into config.yaml
  (`JSON.stringify` quoting — see section 4.3).
- `:199-212` — `guardedWorkspaceTerminal`: guard path
  `path.join(path.dirname(path.resolve(profilesRoot)), 'miaos-shell-guard.sh')`
  (`:205`), `writeAtomic(guardPath, SHELL_GUARD, 0o700)` (`:206`),
  `shellInitFiles: [guardPath]` (`:209`), `autoSourceBashrc: false` (`:210`).
- `:225-227, :248, :267` — the three provisioned profiles (bot, agent,
  google-agent) all pass through `guardedWorkspaceTerminal`.
- `:296` — `SHELL_GUARD` exported for tests.
- `writeAtomic` (`:150-159`) and profile dir/env chmods (`:177-186, :188, :191`)
  use POSIX modes — see section 4.4.

Process-env wiring (second, PATH-level guard layer):

- `backend/server.js:29,36` and `:1688` — `provisionHermesRuntimeProfiles()`
  at startup and after a Hermes-home reset (both re-write the guard file).
- `backend/server.js:145` — `MIAOS_HERMES_GUARD_BIN = path.join(__dirname,
  'miaos-hermes-bin')`.
- `backend/server.js:2775-2790` — `hermesCredentialProcessEnv()` prepends the
  guard bin to `PATH` with `path.delimiter` (`:2788`; already
  Windows-correct). Adjacent: the allowlist (`:2775-2779`) passes `HOME` but
  not `USERPROFILE` — the Windows integrator should add
  `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`SystemRoot`/`COMSPEC`/`PATHEXT`
  equivalents for child processes to function.
- `backend/inference.js:35` — same `MIAOS_HERMES_GUARD_BIN` constant.
- `backend/inference.js:355-379` — `HERMES_ENV_ALLOWLIST` includes
  `MIAOS_WORKSPACE_DIR`, `MIAOS_HERMES_GUARD_BIN` (`:370`); same
  `HOME`-vs-`USERPROFILE` caveat (`:358`).
- `backend/inference.js:394-396` — `hermesProcessEnv()` exports
  `MIAOS_HERMES_GUARD_BIN` into the Hermes process env and prepends it to
  `PATH` with `path.delimiter` (Windows-correct as written).
- `backend/inference.js:754` — export of `MIAOS_HERMES_GUARD_BIN`.

Launcher env (macOS reference the Windows launcher must replicate):

- `macos/src/main.cjs:312` — `hermesHomePath()` default
  (`userData/hermes`); `:367` — `miaosWorkspacePath()` default
  (`documents/mia`); `:414` — sets `process.env.HERMES_HOME`.
- `macos/src/main.cjs:687-689` — backend child env: `HERMES_HOME`,
  `MIAOS_WORKSPACE_DIR`, `MIAOS_HERMES_GUARD_BIN:
  path.join(BACKEND_ROOT, "miaos-hermes-bin")`. The Windows launcher must set
  the same three variables (guard-bin path will contain backslashes; that is
  fine for the process env, see 4.2 for the in-bash handling).
- `macos/src/main.cjs:29-34, :472` — `venvBinDir`/`venvPythonPath` are already
  win32-aware (`Scripts\python.exe`); note the *fallback* in
  `startLocalBackend` (`HERMES_PYTHON: ... path.join(hermesHome,
  "hermes-agent", "venv", "bin", "python")`, near `:692`) is POSIX-only and
  needs the win32 variant.

Guard-bin shims:

- `backend/miaos-hermes-bin/open` — `#!/bin/sh`, policy message, exit 126.
- `backend/miaos-hermes-bin/gh` — `#!/bin/sh`, provider-isolation message,
  exit 1.

Tests:

- `backend/hermes-bot-profile.test.mjs:112-148` — asserts config wiring, guard
  contents, and `mode & 0o777 === 0o700` (`:130`) — the mode assertion cannot
  pass on Windows (see 4.4).
- `backend/hermes-bot-profile.test.mjs:150-166` — executes the guard via
  hardcoded `'/bin/bash'` (`:157`) with `-lc` and `PATH: '/usr/bin:/bin'` —
  needs a Git Bash path and a Windows-shaped PATH on Windows.

Sibling copies (same code, out of scope but will need the same changes when
synced): `backend/hermes-bot-profile.js`
and the packaged copy under `macos/dist/.../Resources/backend/`.

## 4. Required changes for Windows (for the integrator; not applied here)

### 4.1 Shell selection

No change possible or needed in Hermes profile config: the terminal toolset is
bash-only on all platforms; Git for Windows is a hard runtime dependency
(`_find_bash` raises without it; `HERMES_GIT_BASH_PATH` overrides discovery).
The Windows installer must guarantee Git Bash and should consider setting
`HERMES_GIT_BASH_PATH` to the bundled copy. Do NOT switch the Hermes terminal
to cmd/powershell — there is no such option; the `.ps1` guard covers
PowerShell-hosted surfaces only (section 2).

### 4.2 The guard's in-bash PATH prepend is broken with a Windows-style value

`SHELL_GUARD` lines 56-61 do
`PATH="${MIAOS_HERMES_GUARD_BIN}:${PATH}"`. On Windows the env var is a
native path (`C:\...\miaos-hermes-bin`); the `C:` drive colon corrupts a
colon-separated bash PATH (bash would see entry `C` plus
`\...\miaos-hermes-bin`). Fix inside `SHELL_GUARD` (hermes-bot-profile.js:56):
convert before prepending, e.g.

```sh
miaos_guard_bin="${MIAOS_HERMES_GUARD_BIN:-}"
if command -v cygpath >/dev/null 2>&1 && [ -n "$miaos_guard_bin" ]; then
  miaos_guard_bin="$(cygpath -u "$miaos_guard_bin" 2>/dev/null || printf %s "$miaos_guard_bin")"
fi
```

then use `$miaos_guard_bin` in the `case`/prepend. (`[ -d "C:\..." ]` itself
works under MSYS; only the colon-joined PATH assignment is unsafe.) On
macOS/Linux `cygpath` is absent and behavior is unchanged. The Node-side
prepends (server.js:2788, inference.js:396) already use `path.delimiter` and
need no change; Git Bash converts the process-level PATH to POSIX form at
startup, so the guard-bin dir also arrives correctly that way — the in-guard
prepend is a re-assertion layer.

### 4.3 config.yaml path quoting: OK as-is

`JSON.stringify` of the Windows guard path / cwd produces a double-quoted
scalar with escaped backslashes (`"C:\\Users\\..."`), which YAML parses back
to single backslashes; Hermes then `os.path.isfile()`s the native path
(local.py:588-593) and single-quotes it for bash sourcing
(local.py:598-605) — MSYS bash opens `C:\...` paths. No change required, but
do not "simplify" the quoting to single-quoted YAML or raw scalars.

### 4.4 POSIX modes are advisory on Windows

`writeAtomic(..., 0o700)` / `0o600` and `fs.chmodSync`/`mkdirSync({mode})`
(hermes-bot-profile.js:150-159, 177-186, 206) only toggle the read-only bit on
Windows; they will not fail, but they protect nothing. If the profile dir and
guard must be owner-only, the integrator should apply an ACL (e.g. `icacls
<path> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`) after provisioning.
The test assertion `mode & 0o777 === 0o700`
(hermes-bot-profile.test.mjs:130) must be gated on `process.platform !==
'win32'`.

### 4.5 miaos-hermes-bin shims are invisible to native Windows lookups

The extensionless `open`/`gh` shims work under Git Bash (shebang + PATH
lookup), so the in-terminal layer holds. But the Node-side PATH prepend
(server.js:2788 for `gh` credential isolation, inference.js:396) is
ineffective for Win32 `CreateProcess`/`where`/PowerShell resolution — those
only find `PATHEXT` extensions. Add Windows companions in
`backend/miaos-hermes-bin/`: at minimum `gh.cmd` (exit 1, provider-isolation
message) and `open.cmd` (exit 126, browser policy), e.g.

```bat
@echo Mia provider isolation: ambient GitHub CLI credentials are unavailable to Hermes. 1>&2
@exit /b 1
```

Optionally `gh.ps1`/`open.ps1` too (PowerShell prefers `.ps1` over `.cmd` on
PATH). Keep the extensionless originals — Git Bash prefers them.

### 4.6 Windows launcher env

Replicate `macos/src/main.cjs:687-689` in the Windows main process:
`HERMES_HOME`, `MIAOS_WORKSPACE_DIR`, `MIAOS_HERMES_GUARD_BIN`
(`path.join(BACKEND_ROOT, "miaos-hermes-bin")`). Fix the POSIX-only
`HERMES_PYTHON` fallback (`venv/bin/python` near main.cjs:692) to use the
existing `venvPythonPath()` helper (main.cjs:33-35).

### 4.7 Guard function-name constraint (applies to any future additions)

The snapshot keeps only functions whose names do NOT start with a single
underscore (`grep -vE '^_[^_]'`, base_session_env.py:96). All current guard
names (`miaos_*`, browser names) survive. Never rename the blocker to
`_miaos_*` — it would be dropped from the snapshot and every shadow function
would break on the second command.

## 5. Behavior that cannot be ported 1:1 (and why)

1. **`return 126` / `$?` semantics.** PowerShell has no numeric function
   return status. The port writes the identical message to stderr, sets
   `$global:LASTEXITCODE = 126`, and emits a suppressed non-terminating error
   so `$?` is `$false`. Callers checking `$LASTEXITCODE -eq 126` match the
   bash contract; callers checking `$?` see failure; a caller reading a
   *process* exit code of a wrapper script must propagate `$LASTEXITCODE`
   themselves.
2. **Sourcing model.** Bash `shell_init_files` + `declare -f` snapshot makes
   the guard persist across every Hermes command automatically. PowerShell has
   no equivalent injected by Hermes; the `.ps1` must be dot-sourced by
   whatever Mia-owned code hosts the PowerShell session, once per process.
   Running it with `-File` guards nothing (documented in the file header).
3. **Deny-list names.** The original 14 names are ported verbatim (harmless
   no-ops where the binary does not exist on Windows). Equivalence on Windows
   additionally requires shadowing the native launch surface: `Start-Process`
   (covers `start`/`saps` aliases), `Invoke-Item` (covers `ii`), `explorer`,
   `rundll32`, `mshta`, and `.exe`-suffixed browser spellings. This is the
   same wholesale-block tradeoff the .sh guard already makes with `open` and
   `xdg-open` (generic openers, not just browsers). Not portable at all:
   `osascript` (macOS-only automation escape hatch; `mshta`/`rundll32` are the
   closest Windows analogues and are blocked).
4. **Bypass honesty.** As on macOS, this is a policy speed bump, not a
   sandbox: in PowerShell an agent can call `& (Get-Command chrome.exe
   -CommandType Application)`, `[Diagnostics.Process]::Start(...)`, or
   `cmd /c start`. The bash guard has the same property (`command open`,
   `/usr/bin/open`, `env open`). Parity is preserved; anything stronger needs
   OS-level controls (AppLocker/SRP), out of scope here.
5. **`chmod 0o700` on the guard file.** No POSIX execute/owner bits on
   Windows; see 4.4.

## 6. Suggested verification on a Windows machine

```powershell
powershell -NoProfile -Command ". .\backend\miaos-shell-guard.ps1; open x.html; \"exit=$LASTEXITCODE\"; Start-Process notepad; \"exit=$LASTEXITCODE\""
# expect: two policy lines on stderr, exit=126 twice
"C:\Program Files\Git\bin\bash.exe" -lc '. "$HERMES_HOME/miaos-shell-guard.sh"; open x.html; echo status=$?'
# expect: policy line, status=126, and $PATH not corrupted (echo "$PATH")
```
