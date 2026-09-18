# ============================================================================
# install-runtimes-win.ps1
# ============================================================================
# Windows port of the runtime-provisioning steps of scripts/install-local-mac.sh
# (steps [1/9]-[5/9]: pinned Hermes + venv, pinned Ghost CLI, pinned Google
# Workspace CLI, credential hygiene check). It does NOT package or install the
# desktop app; it ends by printing the four environment variables the Windows
# packager needs (mirroring the mac script's step [6/9] exports):
#
#   HERMES_BUNDLE_DIR, GHOST_BUNDLE_DIR, GWS_BUNDLE_DIR, HERMES_PYTHON_RUNTIME_DIR
#
# Everything is provisioned into %USERPROFILE%\.miaos, mirroring the mac layout:
#   %USERPROFILE%\.miaos\hermes\hermes-agent   (pinned Hermes checkout + venv)
#   %USERPROFILE%\.miaos\ghost-cli             (pinned Ghost CLI checkout)
#   %USERPROFILE%\.miaos\downloads\gws-<ver>-windows-x64  (gws.exe + LICENSE)
#
# Windows PowerShell 5.1 compatible. This file is deliberately pure ASCII (the
# PS 5.1 parser misreads BOM-less UTF-8); the two non-ASCII characters Hermes'
# SOUL.md needs are injected via [char]0x2014 below.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-runtimes-win.ps1 `
#     -PythonRuntimeDir C:\path\to\python-build-standalone\python
#
# -PythonRuntimeDir must be the root of a provisioned python-build-standalone
# runtime containing python.exe at its top level (Windows layout; the mac/Linux
# equivalent keeps the interpreter under bin/). The Hermes venv is created FROM
# this interpreter so venv\pyvenv.cfg's "home" points into the runtime the
# packager bundles, exactly like the mac script derives HERMES_PYTHON_RUNTIME_DIR
# from pyvenv.cfg.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PythonRuntimeDir,

    # Kept overridable for tests only; release provisioning always uses the
    # default, matching install-local-mac.sh which hardcodes $HOME/.miaos.
    [string]$MiaosHome = (Join-Path $env:USERPROFILE ".miaos")
)

$ErrorActionPreference = "Stop"
# PS 5.1's synchronous progress repaints throttle Invoke-WebRequest downloads
# by 10-100x (same rationale as Hermes' own scripts/install.ps1).
$ProgressPreference = "SilentlyContinue"
# PS 5.1 defaults to TLS 1.0/1.1 which GitHub rejects.
[System.Net.ServicePointManager]::SecurityProtocol = `
    [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

function Read-ReleaseEnv {
    # Parses the bash-style KEY="VALUE" release env files (hermes-release.env,
    # ghost-release.env, gws-release.env) into a hashtable. Comments and blank
    # lines are ignored; quotes are stripped. The mac script `source`s these
    # files directly; PowerShell cannot, so this is the port.
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Release env file not found: $Path" }
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim()
            if ($value -match '^"(.*)"$') { $value = $Matches[1] }
            elseif ($value -match "^'(.*)'$") { $value = $Matches[1] }
            $values[$key] = $value
        }
    }
    return $values
}

function Invoke-Native {
    # Runs a native command and fails the script on a nonzero exit code.
    # PS 5.1 does not stop on native failures even with EAP=Stop, and some
    # hosts convert native stderr into NativeCommandError records, so run
    # with EAP=Continue and gate on $LASTEXITCODE explicitly.
    param(
        [Parameter(Mandatory = $true)][string]$What,
        [Parameter(Mandatory = $true)][scriptblock]$Block,
        [switch]$IgnoreFailure
    )
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = 0
    try {
        & $Block 2>&1 | ForEach-Object { "$_" } | Write-Host
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreFailure) {
        throw "$What failed with exit code $LASTEXITCODE"
    }
    return $LASTEXITCODE
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Remove-Tree {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Write-Utf8NoBom {
    # PS 5.1's Set-Content -Encoding UTF8 writes a BOM; Hermes' runtime and the
    # packager expect plain UTF-8 files, so write via .NET.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-PinnedClone {
    # Port of install-local-mac.sh::pinned_clone: init an empty repo, fetch
    # EXACTLY the pinned commit at depth 1 with all credential lookups
    # disabled, detach onto FETCH_HEAD, verify rev-parse matches the pin, and
    # strip .git so the checkout is a plain source tree.
    #
    # Windows divergences (all required for byte-identical checkouts):
    #  * core.autocrlf=false / core.eol=lf: Git for Windows commonly defaults
    #    autocrlf=true, which would rewrite every text file to CRLF, break the
    #    hermes-noninteractive.patch context, and ship a working tree that is
    #    not byte-identical to the pinned commit.
    #  * core.longpaths=true: node_modules-adjacent paths in the checkout can
    #    exceed MAX_PATH on default Windows configurations.
    #  * GIT_ASKPASS points at a stub cmd that exits 1 (the /bin/false
    #    equivalent), and GIT_CONFIG_GLOBAL=NUL replaces /dev/null.
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Remove-Tree $Destination
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    $askPass = Join-Path $env:TEMP "miaos-git-askpass.cmd"
    Write-Utf8NoBom -Path $askPass -Content "@exit /b 1`r`n"

    $savedGitEnv = @{}
    $gitEnv = @{
        GIT_CONFIG_GLOBAL   = "NUL"
        GIT_CONFIG_NOSYSTEM = "1"
        GIT_TERMINAL_PROMPT = "0"
        GIT_ASKPASS         = $askPass
    }
    foreach ($name in $gitEnv.Keys) {
        $savedGitEnv[$name] = [System.Environment]::GetEnvironmentVariable($name)
        [System.Environment]::SetEnvironmentVariable($name, $gitEnv[$name])
    }
    try {
        $gitConfigArgs = @(
            "-c", "credential.helper=",
            "-c", "core.askPass=$askPass",
            "-c", "core.autocrlf=false",
            "-c", "core.eol=lf",
            "-c", "core.filemode=false",
            "-c", "core.longpaths=true"
        )
        $null = Invoke-Native "git init ($Destination)" { & git init --quiet $Destination }
        $null = Invoke-Native "git remote add" { & git -C $Destination remote add origin $Url }
        $null = Invoke-Native "git fetch pinned commit $Commit" {
            & git @gitConfigArgs -C $Destination fetch --quiet --depth 1 origin $Commit
        }
        $null = Invoke-Native "git checkout FETCH_HEAD" {
            & git @gitConfigArgs -C $Destination checkout --quiet --detach FETCH_HEAD
        }
        $actual = (& git -C $Destination rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $actual) { throw "git rev-parse failed in $Destination" }
        if ($actual -ne $Commit) {
            throw "Commit mismatch in ${Destination}: expected $Commit, got $actual"
        }
    } finally {
        foreach ($name in $savedGitEnv.Keys) {
            [System.Environment]::SetEnvironmentVariable($name, $savedGitEnv[$name])
        }
    }
    Remove-Tree (Join-Path $Destination ".git")
}

# ----------------------------------------------------------------------------
# Release pins and preconditions
# ----------------------------------------------------------------------------

$hermesRelease = Read-ReleaseEnv (Join-Path $scriptDir "hermes-release.env")
$ghostRelease  = Read-ReleaseEnv (Join-Path $scriptDir "ghost-release.env")
$gwsRelease    = Read-ReleaseEnv (Join-Path $scriptDir "gws-release.env")

foreach ($required in @("HERMES_VERSION", "HERMES_TAG", "HERMES_COMMIT", "HERMES_SOURCE_URL")) {
    if (-not $hermesRelease[$required]) { throw "hermes-release.env is missing $required" }
}
foreach ($required in @("GHOST_VERSION", "GHOST_COMMIT", "GHOST_SOURCE_URL")) {
    if (-not $ghostRelease[$required]) { throw "ghost-release.env is missing $required" }
}
if (-not $gwsRelease["GWS_VERSION"]) { throw "gws-release.env is missing GWS_VERSION" }

# Release packaging always provisions fresh pinned runtimes; runtime reuse is
# not supported (parity with the mac script's argument guard).
$hermesHome       = Join-Path $MiaosHome "hermes"
$hermesInstallDir = Join-Path $hermesHome "hermes-agent"
$ghostInstallDir  = Join-Path $MiaosHome "ghost-cli"
$downloadsDir     = Join-Path $MiaosHome "downloads"

$pythonRuntimeRoot = (Resolve-Path -LiteralPath $PythonRuntimeDir).Path
$pythonExe = Join-Path $pythonRuntimeRoot "python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    # python-build-standalone Windows archives put python.exe at the root
    # (unlike the POSIX bin/ layout); some repacks nest it under install\.
    $nested = Join-Path $pythonRuntimeRoot "install\python.exe"
    if (Test-Path -LiteralPath $nested) {
        $pythonRuntimeRoot = Join-Path $pythonRuntimeRoot "install"
        $pythonExe = $nested
    } else {
        throw "PythonRuntimeDir does not contain python.exe: $pythonRuntimeRoot"
    }
}

foreach ($command in @("git", "npm", "node")) {
    if (-not (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $command"
    }
}

if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".hermes")) {
    Write-Host "Preserving existing Hermes installation: $(Join-Path $env:USERPROFILE '.hermes')"
}

New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null

# ----------------------------------------------------------------------------
# [1/6] Pinned Hermes source
# ----------------------------------------------------------------------------

Write-Host "[1/6] Downloading pinned Hermes $($hermesRelease.HERMES_TAG) ($($hermesRelease.HERMES_VERSION))"
$hermesExtractRoot = Join-Path $downloadsDir "hermes-source"
New-PinnedClone -Url $hermesRelease.HERMES_SOURCE_URL -Commit $hermesRelease.HERMES_COMMIT -Destination $hermesExtractRoot

# The patch only changes the Debian build-tools prompt default in the POSIX
# scripts/install.sh (inert at runtime on Windows), but it is applied here too
# so the shipped source tree is identical across platforms. git apply works on
# a plain directory (no .git) exactly as it does in the mac script.
Push-Location $hermesExtractRoot
try {
    $null = Invoke-Native "git apply hermes-noninteractive.patch" {
        & git -c core.autocrlf=false apply (Join-Path $scriptDir "hermes-noninteractive.patch")
    }
} finally {
    Pop-Location
}

Write-Host "[2/6] Installing the pinned Hermes runtime (no provider setup, no skills)"
Remove-Tree $hermesInstallDir
New-Item -ItemType Directory -Path $hermesHome -Force | Out-Null
Move-Item -LiteralPath $hermesExtractRoot -Destination $hermesInstallDir
Write-Utf8NoBom -Path (Join-Path $hermesInstallDir ".miaos-source-commit") -Content "$($hermesRelease.HERMES_COMMIT)`n"

# ----------------------------------------------------------------------------
# [2/6 cont.] Hermes install stages
#
# The mac script drives hermes-agent/scripts/install.sh for the stages
#   venv, python-deps, node-deps, config, complete
# with --skip-setup --skip-browser --skip-computer-use --no-skills
# --non-interactive. That installer is bash-only, so this section replicates
# what those stages do on Windows (cross-checked against hermes-agent's own
# scripts/install.ps1, which is the upstream Windows equivalent but lacks the
# --no-skills / --skip-browser surface the release bundle requires).
# ----------------------------------------------------------------------------

# --- managed uv (install.sh::install_uv) -----------------------------------
# Hermes owns its own uv at $HERMES_HOME\bin\uv.exe; the runtime update path
# (hermes_cli/managed_uv.py) looks in the same place. The astral installer
# honors UV_INSTALL_DIR on Windows (UV_UNMANAGED_INSTALL is the POSIX knob).
$uvCmd = Join-Path $hermesHome "bin\uv.exe"
if (-not (Test-Path -LiteralPath $uvCmd)) {
    Write-Host "Installing managed uv into $hermesHome\bin ..."
    New-Item -ItemType Directory -Path (Join-Path $hermesHome "bin") -Force | Out-Null
    $savedUvInstallDir = $env:UV_INSTALL_DIR
    $env:UV_INSTALL_DIR = Join-Path $hermesHome "bin"
    try {
        $null = Invoke-Native "uv installer (astral.sh)" -IgnoreFailure {
            & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
        }
        if (-not (Test-Path -LiteralPath $uvCmd)) {
            Write-Host "astral.sh installer did not produce uv.exe; trying GitHub releases mirror ..."
            $null = Invoke-Native "uv installer (GitHub mirror)" -IgnoreFailure {
                & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/astral-sh/uv/releases/latest/download/uv-installer.ps1 | iex"
            }
        }
    } finally {
        $env:UV_INSTALL_DIR = $savedUvInstallDir
    }
    if (-not (Test-Path -LiteralPath $uvCmd)) {
        # Last resort: salvage an existing uv.exe into the managed location so
        # the managed-first invariant holds (same rung as upstream install.ps1).
        $existingUv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty Source
        if (-not $existingUv) {
            $defaultUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
            if (Test-Path -LiteralPath $defaultUv) { $existingUv = $defaultUv }
        }
        if ($existingUv) {
            Write-Host "Salvaging existing uv from $existingUv"
            Copy-Item -LiteralPath $existingUv -Destination $uvCmd -Force
        }
    }
    if (-not (Test-Path -LiteralPath $uvCmd)) {
        throw "uv installation failed: $uvCmd not found"
    }
}
$null = Invoke-Native "uv --version" { & $uvCmd --version }

# --- stage venv (install.sh::setup_venv) -----------------------------------
# Created FROM the provisioned python-build-standalone interpreter (this is
# the port's key divergence: the mac flow lets uv resolve Python 3.11 itself
# and later reads the runtime location back out of venv\pyvenv.cfg; on Windows
# the runtime is an explicit input). --no-python-downloads pins uv to that
# interpreter; the venv lands at hermes-agent\venv with the Windows Scripts\
# layout instead of bin/.
Push-Location $hermesInstallDir
try {
    Remove-Tree (Join-Path $hermesInstallDir "venv")
    Write-Host "Creating virtual environment from $pythonExe ..."
    $null = Invoke-Native "uv venv" {
        & $uvCmd venv venv --python $pythonExe --no-python-downloads --no-config
    }
    $venvPython = Join-Path $hermesInstallDir "venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        throw "venv creation did not produce $venvPython"
    }
    # Neutralize any inherited UV_PYTHON and pin every subsequent uv command
    # onto the venv interpreter (mirrors setup_venv/install_deps).
    $env:UV_PYTHON = $venvPython
    $env:VIRTUAL_ENV = Join-Path $hermesInstallDir "venv"

    # --- stage python-deps (install.sh::install_deps) -----------------------
    # Tier 0: hash-verified `uv sync --extra all --locked` against uv.lock
    # (NOT --all-extras: [matrix] needs python-olm which has no Windows wheel).
    # UV_PROJECT_ENVIRONMENT pins the sync target to venv\ (modern uv ignores
    # VIRTUAL_ENV for sync). Like install.sh::run_locked_uv_sync, ambient uv
    # config is hidden (XDG redirect + cleared UV_CONFIG_FILE/UV_NO_CONFIG)
    # while the project's own [tool.uv] stays discoverable, so --locked
    # resolves under the same policy uv.lock was created with.
    $installed = $false
    if (Test-Path -LiteralPath (Join-Path $hermesInstallDir "uv.lock")) {
        Write-Host "Trying tier: hash-verified (uv.lock) ..."
        $isolatedUvConfig = Join-Path $env:TEMP ("miaos-uv-config-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $isolatedUvConfig -Force | Out-Null
        $savedEnv = @{}
        foreach ($name in @("UV_NO_CONFIG", "UV_CONFIG_FILE", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "UV_PROJECT_ENVIRONMENT")) {
            $savedEnv[$name] = [System.Environment]::GetEnvironmentVariable($name)
        }
        try {
            Remove-Item Env:\UV_NO_CONFIG -ErrorAction SilentlyContinue
            Remove-Item Env:\UV_CONFIG_FILE -ErrorAction SilentlyContinue
            $env:XDG_CONFIG_HOME = $isolatedUvConfig
            $env:XDG_CONFIG_DIRS = $isolatedUvConfig
            $env:UV_PROJECT_ENVIRONMENT = Join-Path $hermesInstallDir "venv"
            $syncExit = Invoke-Native "uv sync --extra all --locked" -IgnoreFailure {
                & $uvCmd sync --extra all --locked
            }
            if ($syncExit -eq 0) {
                Write-Host "Main package installed (hash-verified via uv.lock)"
                $installed = $true
            } else {
                Write-Warning "uv.lock sync failed (lockfile may be stale), falling back to PyPI resolve..."
            }
        } finally {
            foreach ($name in $savedEnv.Keys) {
                [System.Environment]::SetEnvironmentVariable($name, $savedEnv[$name])
            }
            Remove-Tree $isolatedUvConfig
        }
    } else {
        Write-Host "uv.lock not found -- falling back to PyPI resolve (no hash verification)"
    }
    if (-not $installed) {
        # Fallback tiers, as in install.sh::install_deps. The intermediate
        # "[all] minus known-broken" tier is omitted: its broken-extras list
        # is empty at this pin, which makes it byte-identical to tier ".[all]".
        foreach ($tier in @(
            @{ Name = "all";                    Spec = ".[all]" },
            @{ Name = "core only (no extras)";  Spec = "." }
        )) {
            Write-Host "Trying tier: $($tier.Name) ..."
            $tierExit = Invoke-Native "uv pip install -e $($tier.Spec)" -IgnoreFailure {
                & $uvCmd pip install -e $tier.Spec
            }
            if ($tierExit -eq 0) {
                Write-Host "Main package installed ($($tier.Name))"
                if ($tier.Name -ne "all") {
                    Write-Warning "Installed via fallback tier ($($tier.Name)); optional features may be missing."
                }
                $installed = $true
                break
            }
        }
    }
    if (-not $installed) {
        throw "Hermes Python package installation failed even with no extras."
    }

    # --- stage node-deps (install.sh::install_node_deps) --------------------
    # Scoped to the workspaces a CLI install needs (node_deps_workspace_args)
    # so apps/desktop's node-pty is never built here. Playwright/Chromium and
    # the computer-use driver are intentionally NOT installed: the mac release
    # flow passes --skip-browser --skip-computer-use. The bash installer
    # time-boxes npm; here a hung registry fetch surfaces as a hung install
    # (no run_with_timeout equivalent) -- an accepted divergence.
    if (Test-Path -LiteralPath (Join-Path $hermesInstallDir "package.json")) {
        Write-Host "Installing Node.js dependencies (browser tools)..."
        $workspaceArgs = @()
        if (Test-Path -LiteralPath (Join-Path $hermesInstallDir "ui-tui\package.json")) { $workspaceArgs += @("--workspace", "ui-tui") }
        if (Test-Path -LiteralPath (Join-Path $hermesInstallDir "web\package.json"))    { $workspaceArgs += @("--workspace", "web") }
        if ($workspaceArgs.Count -eq 0) { $workspaceArgs = @("--workspaces=false") }
        else { $workspaceArgs += "--include-workspace-root" }
        $null = Invoke-Native "npm install (hermes root)" { & npm install @workspaceArgs --silent }
        Write-Host "Skipping Playwright/Chromium install (--skip-browser parity)"
        Write-Host "Skipping computer-use driver install (--skip-computer-use parity)"
    }
    if (Test-Path -LiteralPath (Join-Path $hermesInstallDir "ui-tui\package.json")) {
        Write-Host "Installing TUI dependencies..."
        Push-Location (Join-Path $hermesInstallDir "ui-tui")
        try {
            $null = Invoke-Native "npm install (ui-tui)" { & npm install --silent }
        } finally {
            Pop-Location
        }
    }

    # --- stage config (install.sh::copy_config_templates, --no-skills) ------
    foreach ($sub in @("cron", "sessions", "logs", "pairing", "hooks", "image_cache", "audio_cache", "memories", "skills")) {
        New-Item -ItemType Directory -Path (Join-Path $hermesHome $sub) -Force | Out-Null
    }
    $hermesEnvFile = Join-Path $hermesHome ".env"
    if (-not (Test-Path -LiteralPath $hermesEnvFile)) {
        $envExample = Join-Path $hermesInstallDir ".env.example"
        if (Test-Path -LiteralPath $envExample) {
            Copy-Item -LiteralPath $envExample -Destination $hermesEnvFile
        } else {
            Write-Utf8NoBom -Path $hermesEnvFile -Content ""
        }
    }
    # POSIX chmod 600 has no direct equivalent; restrict the credential file
    # to the current user via an explicit ACL instead.
    try {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", "Allow")
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $hermesEnvFile -AclObject $acl
    } catch {
        Write-Warning "Could not restrict ACL on ${hermesEnvFile}: $_"
    }
    $configYaml = Join-Path $hermesHome "config.yaml"
    if (-not (Test-Path -LiteralPath $configYaml)) {
        $configExample = Join-Path $hermesInstallDir "cli-config.yaml.example"
        if (Test-Path -LiteralPath $configExample) {
            Copy-Item -LiteralPath $configExample -Destination $configYaml
        }
    }
    $soulPath = Join-Path $hermesHome "SOUL.md"
    if (-not (Test-Path -LiteralPath $soulPath)) {
        # Must match DEFAULT_SOUL_MD in hermes_cli/default_soul.py (drift is
        # self-healing at runtime, but keep it identical). {EMDASH} keeps this
        # script pure ASCII for the PS 5.1 parser.
        $emdash = [string][char]0x2014
        $soulText = ('You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask {EMDASH} a one-line question gets a one-line answer, and finished work gets a short report of what changed, what''s verified, and what''s left, never a replay of the process. No filler ("Great question," "I''d be happy to"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it''s right, not because the user said it. Depth is earned {EMDASH} give it when the user asks for detail, teaches, or the stakes demand it, not by default.' -replace '\{EMDASH\}', $emdash)
        Write-Utf8NoBom -Path $soulPath -Content ($soulText + "`n")
    }
    # Blank-slate install (--no-skills): write the opt-out marker and skip
    # seeding. skills_sync.py and `hermes update` both honor this marker.
    Write-Utf8NoBom -Path (Join-Path $hermesHome ".no-bundled-skills") -Content (
        "This profile opted out of bundled-skill seeding (installed with --no-skills).`n" +
        "Delete this file to re-enable sync on the next 'hermes update'.`n")

    # --- stage complete (install.sh::write_bootstrap_marker) ----------------
    # Schema mirrors install.ps1's Write-BootstrapMarker: schemaVersion 1 +
    # pinnedCommit are what the desktop validator requires.
    $completedAt = [System.DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    $markerJson = "{`n" +
        "  `"schemaVersion`": 1,`n" +
        "  `"pinnedCommit`": `"$($hermesRelease.HERMES_COMMIT)`",`n" +
        "  `"pinnedBranch`": `"main`",`n" +
        "  `"completedAt`": `"$completedAt`"`n" +
        "}`n"
    Write-Utf8NoBom -Path (Join-Path $hermesInstallDir ".hermes-bootstrap-complete") -Content $markerJson

    # --- post-stage pins (install-local-mac.sh lines 79-82) -----------------
    # Hermes otherwise downloads these optional dependencies while building the
    # first Mia agent; keep the tested versions inside the shipped venv.
    $null = Invoke-Native "uv pip install boto3/edge-tts" {
        & $uvCmd pip install --quiet --python $venvPython "boto3==1.42.89" "edge-tts==7.2.7"
    }
    Write-Utf8NoBom -Path (Join-Path $hermesInstallDir ".install_method") -Content "miaos-bundle`n"
} finally {
    Pop-Location
    Remove-Item Env:\VIRTUAL_ENV -ErrorAction SilentlyContinue
    Remove-Item Env:\UV_PYTHON -ErrorAction SilentlyContinue
}

# ----------------------------------------------------------------------------
# [3/6] Pinned Ghost CLI
# ----------------------------------------------------------------------------

Write-Host "[3/6] Downloading pinned Ghost CLI $($ghostRelease.GHOST_VERSION)"
$ghostExtractRoot = Join-Path $downloadsDir "ghost-cli-source"
New-PinnedClone -Url $ghostRelease.GHOST_SOURCE_URL -Commit $ghostRelease.GHOST_COMMIT -Destination $ghostExtractRoot
if (-not (Test-Path -LiteralPath (Join-Path $ghostExtractRoot "in_app_browser_transport.py"))) {
    throw "Pinned Ghost CLI does not contain the in-app browser connector."
}
Remove-Tree $ghostInstallDir
Move-Item -LiteralPath $ghostExtractRoot -Destination $ghostInstallDir
Write-Utf8NoBom -Path (Join-Path $ghostInstallDir ".miaos-source-commit") -Content "$($ghostRelease.GHOST_COMMIT)`n"

# ----------------------------------------------------------------------------
# [4/6] Pinned Google Workspace CLI (Windows x64)
# ----------------------------------------------------------------------------

$gwsVersion = $gwsRelease.GWS_VERSION
Write-Host "[4/6] Downloading pinned Google Workspace CLI $gwsVersion"
# Asset name verified against the googleworkspace/cli v0.22.5 GitHub release:
# google-workspace-cli-x86_64-pc-windows-msvc.zip (contains gws.exe, LICENSE,
# README.md, CHANGELOG.md at the archive root).
$gwsInstallDir = Join-Path $downloadsDir "gws-$gwsVersion-windows-x64"
$gwsArchive    = Join-Path $downloadsDir "google-workspace-cli-x86_64-pc-windows-msvc-$gwsVersion.zip"
$gwsUrl        = "https://github.com/googleworkspace/cli/releases/download/v$gwsVersion/google-workspace-cli-x86_64-pc-windows-msvc.zip"
Remove-Tree $gwsInstallDir
if (Test-Path -LiteralPath $gwsArchive) { Remove-Item -LiteralPath $gwsArchive -Force }
New-Item -ItemType Directory -Path $gwsInstallDir -Force | Out-Null
Invoke-WebRequest -Uri $gwsUrl -OutFile $gwsArchive -UseBasicParsing

$gwsArchiveSha = Get-Sha256 $gwsArchive
$pinnedArchiveSha = $gwsRelease["GWS_WINDOWS_X64_ARCHIVE_SHA256"]
if ($pinnedArchiveSha) {
    if ($gwsArchiveSha -ne $pinnedArchiveSha.ToLowerInvariant()) {
        throw "Google Workspace CLI archive checksum mismatch: expected $pinnedArchiveSha, got $gwsArchiveSha"
    }
} else {
    # ==========================================================================
    # WARNING: gws-release.env has NO Windows sha256 pin (it only carries the
    # darwin-arm64 pins). This install computed the archive hash at download
    # time, which verifies nothing against the tested release. Before ANY
    # Windows release build, add these keys to scripts/gws-release.env and
    # verify them against a trusted download:
    #   GWS_WINDOWS_X64_ARCHIVE_SHA256="<archive sha256>"
    #   GWS_WINDOWS_X64_SHA256="<gws.exe sha256>"
    # This script then verifies instead of warning. Observed archive sha256 for
    # v0.22.5 on 2026-09-16 (matches the release's published .sha256 asset):
    #   407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2
    # ==========================================================================
    Write-Warning "gws-release.env has no GWS_WINDOWS_X64_ARCHIVE_SHA256 pin."
    Write-Warning "UNVERIFIED download. Computed archive sha256: $gwsArchiveSha"
    Write-Warning "Add GWS_WINDOWS_X64_ARCHIVE_SHA256=`"$gwsArchiveSha`" to scripts/gws-release.env before release builds."
}

Expand-Archive -LiteralPath $gwsArchive -DestinationPath $gwsInstallDir -Force
$gwsBinary = Join-Path $gwsInstallDir "gws.exe"
if (-not (Test-Path -LiteralPath $gwsBinary) -or -not (Test-Path -LiteralPath (Join-Path $gwsInstallDir "LICENSE"))) {
    throw "Google Workspace CLI archive is missing gws.exe or LICENSE"
}
$gwsBinarySha = Get-Sha256 $gwsBinary
$pinnedBinarySha = $gwsRelease["GWS_WINDOWS_X64_SHA256"]
if ($pinnedBinarySha) {
    if ($gwsBinarySha -ne $pinnedBinarySha.ToLowerInvariant()) {
        throw "Google Workspace CLI binary checksum mismatch: expected $pinnedBinarySha, got $gwsBinarySha"
    }
} else {
    Write-Warning "gws-release.env has no GWS_WINDOWS_X64_SHA256 pin."
    Write-Warning "Computed gws.exe sha256: $gwsBinarySha"
    Write-Warning "Add GWS_WINDOWS_X64_SHA256=`"$gwsBinarySha`" to scripts/gws-release.env before release builds."
}

# ----------------------------------------------------------------------------
# [5/6] Credential hygiene (install-local-mac.sh step [5/9])
# ----------------------------------------------------------------------------

Write-Host "[5/6] Verifying the installation has no persisted provider credentials"
foreach ($credentialFile in @(
    (Join-Path $hermesHome "auth.json"),
    (Join-Path $hermesHome "profiles\miaos-agent-runtime\.env"),
    (Join-Path $hermesHome "profiles\miaos-bot-worker\.env")
)) {
    if (-not (Test-Path -LiteralPath $credentialFile)) { continue }
    if ($credentialFile -like "*.env") {
        $meaningful = @(Get-Content -LiteralPath $credentialFile -ErrorAction SilentlyContinue |
            Where-Object { $_ -notmatch '^\s*(#|$)' })
        if ($meaningful.Count -eq 0) { continue }
    }
    throw "Unexpected configured credential file: $credentialFile"
}

# ----------------------------------------------------------------------------
# [6/6] Packager inputs (install-local-mac.sh step [6/9] exports)
# ----------------------------------------------------------------------------

# On the mac, HERMES_PYTHON_RUNTIME_DIR is re-derived from venv/pyvenv.cfg and
# symlink-resolved; here the runtime was an explicit input and Windows venvs
# hold no interpreter symlinks, so the resolved parameter is authoritative.
# Sanity-check that the venv actually points at it before handing it over.
$pyvenvCfg = Join-Path $hermesInstallDir "venv\pyvenv.cfg"
if (-not (Test-Path -LiteralPath $pyvenvCfg)) { throw "Missing $pyvenvCfg" }
$venvHome = (Get-Content -LiteralPath $pyvenvCfg |
    Where-Object { $_ -match '^\s*home\s*=\s*(.+)$' } |
    ForEach-Object { $Matches[1].Trim() } | Select-Object -First 1)
if (-not $venvHome) { throw "Cannot determine Python runtime from venv\pyvenv.cfg" }
$normalizedVenvHome = [System.IO.Path]::GetFullPath($venvHome).TrimEnd('\')
$normalizedRuntime  = [System.IO.Path]::GetFullPath($pythonRuntimeRoot).TrimEnd('\')
if ($normalizedVenvHome -ne $normalizedRuntime) {
    throw "venv home ($normalizedVenvHome) does not match -PythonRuntimeDir ($normalizedRuntime)"
}

$env:HERMES_BUNDLE_DIR         = $hermesInstallDir
$env:GHOST_BUNDLE_DIR          = $ghostInstallDir
$env:GWS_BUNDLE_DIR            = $gwsInstallDir
$env:HERMES_PYTHON_RUNTIME_DIR = $normalizedRuntime

# GitHub Actions contract (see .github/workflows/windows-build.yml): hand the
# bundle paths to later workflow steps via GITHUB_ENV when running in CI.
if ($env:GITHUB_ENV) {
  Add-Content -Path $env:GITHUB_ENV -Value "HERMES_BUNDLE_DIR=$hermesInstallDir"
  Add-Content -Path $env:GITHUB_ENV -Value "GHOST_BUNDLE_DIR=$ghostInstallDir"
  Add-Content -Path $env:GITHUB_ENV -Value "GWS_BUNDLE_DIR=$gwsInstallDir"
  Add-Content -Path $env:GITHUB_ENV -Value "HERMES_PYTHON_RUNTIME_DIR=$normalizedRuntime"
}

Write-Host ""
Write-Host "[6/6] Runtime provisioning complete. Packager environment:"
Write-Host "HERMES_BUNDLE_DIR=$env:HERMES_BUNDLE_DIR"
Write-Host "GHOST_BUNDLE_DIR=$env:GHOST_BUNDLE_DIR"
Write-Host "GWS_BUNDLE_DIR=$env:GWS_BUNDLE_DIR"
Write-Host "HERMES_PYTHON_RUNTIME_DIR=$env:HERMES_PYTHON_RUNTIME_DIR"
Write-Host ""
Write-Host "Hermes: $($hermesRelease.HERMES_COMMIT) (no provider credentials configured)"
Write-Host "Ghost CLI: $($ghostRelease.GHOST_COMMIT)"
Write-Host "Google Workspace CLI: $gwsVersion"
