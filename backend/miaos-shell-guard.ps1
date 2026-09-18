# Managed by Mia. Keep browser launches inside the app-owned browser.
#
# Windows PowerShell port of backend/hermes-bot-profile.js SHELL_GUARD
# (miaos-shell-guard.sh). Dot-source this file into the session that will run
# agent commands (e.g. ". 'C:\...\miaos-shell-guard.ps1'" from a profile or an
# init command). Running it as a child script (-File) defines the functions in
# a throwaway scope and guards nothing.
#
# Behavior contract (mirrors the .sh guard):
#   - miaos_block_external_browser prints the policy line to stderr and
#     reports exit code 126 (POSIX "found but not executable" convention the
#     .sh guard uses via `return 126`). In PowerShell that surfaces as
#     $LASTEXITCODE = 126 plus a non-terminating error so $? is $false at the
#     call site; nothing is thrown, so `set -e`-less script flow is preserved.
#   - If MIAOS_HERMES_GUARD_BIN names an existing directory, it is prepended
#     to PATH exactly once (case-insensitive, Windows ';' delimiter), so the
#     app-owned command shims win PATH lookups.
#   - Browser/opener commands are shadowed by functions. PowerShell resolves
#     functions before external commands, so `chrome`, `firefox.exe`, etc.
#     hit the blocker even when a real executable is on PATH. `start` and
#     `saps` are built-in aliases of Start-Process and therefore resolve to
#     the Start-Process shadow below; `ii` resolves to the Invoke-Item shadow.
#
# PowerShell 5.1 compatible: no ternary, no null-coalescing, no PS7-only
# parameters.

# Simple (non-advanced) function on purpose: $args absorbs ANY invocation
# shape (`open -a Safari`, `Start-Process -FilePath x -Wait`, ...) without
# parameter-binding errors, exactly like the .sh function's "$@".
function miaos_block_external_browser {
    $message = 'Mia browser policy: external browser launch is disabled. Use ghost-cli and the embedded Mia browser instead.'
    # Plain text on stderr, matching the .sh guard's `echo ... >&2`.
    [Console]::Error.WriteLine($message)
    # Exit-code semantics: the .sh functions `return 126`. External-command
    # style status for callers that check $LASTEXITCODE...
    $global:LASTEXITCODE = 126
    # ...and a suppressed non-terminating error record so $? is $false at the
    # call site without printing a second, decorated copy of the message.
    Write-Error -Message $message -Category PermissionDenied -ErrorAction SilentlyContinue
}

# Prepend the app-owned guard-shim directory to PATH exactly once.
# Mirrors the .sh guard's MIAOS_HERMES_GUARD_BIN block, with Windows PATH
# semantics: ';' delimiter and case-insensitive entry comparison.
$miaosGuardBin = $env:MIAOS_HERMES_GUARD_BIN
if ($miaosGuardBin -and (Test-Path -LiteralPath $miaosGuardBin -PathType Container)) {
    $miaosGuardBinNorm = $miaosGuardBin.TrimEnd('\', '/')
    $miaosAlreadyOnPath = $false
    foreach ($miaosPathEntry in (($env:PATH -split ';') | Where-Object { $_ })) {
        if ([string]::Equals($miaosPathEntry.TrimEnd('\', '/'), $miaosGuardBinNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
            $miaosAlreadyOnPath = $true
            break
        }
    }
    if (-not $miaosAlreadyOnPath) {
        if ($env:PATH) {
            $env:PATH = $miaosGuardBin + ';' + $env:PATH
        } else {
            $env:PATH = $miaosGuardBin
        }
    }
    Remove-Variable -Name miaosGuardBinNorm, miaosAlreadyOnPath, miaosPathEntry -ErrorAction SilentlyContinue
}
Remove-Variable -Name miaosGuardBin -ErrorAction SilentlyContinue

# --- Deny rules ported 1:1 from miaos-shell-guard.sh ---
function open { miaos_block_external_browser }
function open_app { miaos_block_external_browser }
function osascript { miaos_block_external_browser }
function google-chrome { miaos_block_external_browser }
function chromium { miaos_block_external_browser }
function chromium-browser { miaos_block_external_browser }
function firefox { miaos_block_external_browser }
function brave { miaos_block_external_browser }
function brave-browser { miaos_block_external_browser }
function microsoft-edge { miaos_block_external_browser }
function microsoft-edge-stable { miaos_block_external_browser }
function safari { miaos_block_external_browser }
function xdg-open { miaos_block_external_browser }
function playwright { miaos_block_external_browser }

# --- Windows-native launch surface (same guarantee, platform equivalents) ---
# `open` / `xdg-open` are the macOS/Linux generic openers; the .sh guard
# blocks them wholesale. Windows' generic openers are Start-Process (aliases:
# start, saps), Invoke-Item (alias: ii), explorer, and rundll32's url.dll
# handler, so they get the same wholesale block here. Browser executables are
# shadowed under both their bare and .exe-suffixed spellings because
# PowerShell resolves a typed `chrome.exe` to a function of that exact name
# before searching PATH.
function Start-Process { miaos_block_external_browser }
function Invoke-Item { miaos_block_external_browser }
function explorer { miaos_block_external_browser }
function explorer.exe { miaos_block_external_browser }
function rundll32 { miaos_block_external_browser }
function rundll32.exe { miaos_block_external_browser }
function mshta { miaos_block_external_browser }
function mshta.exe { miaos_block_external_browser }
function chrome { miaos_block_external_browser }
function chrome.exe { miaos_block_external_browser }
function google-chrome.exe { miaos_block_external_browser }
function chromium.exe { miaos_block_external_browser }
function msedge { miaos_block_external_browser }
function msedge.exe { miaos_block_external_browser }
function firefox.exe { miaos_block_external_browser }
function brave.exe { miaos_block_external_browser }
function iexplore { miaos_block_external_browser }
function iexplore.exe { miaos_block_external_browser }
function playwright.exe { miaos_block_external_browser }
function playwright.cmd { miaos_block_external_browser }
