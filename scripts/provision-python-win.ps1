# Provision the pinned standalone Python runtime for the Windows build.
#
# Reads scripts/python-release-win.env, downloads the python-build-standalone
# archive, verifies its sha256, extracts it, and prints the runtime root to
# export as HERMES_PYTHON_RUNTIME_DIR before running the Windows packager.
#
# Windows runtime layout (install_only flavor) differs from mac/linux:
#   <root>\python.exe   - interpreter at the root, no bin\ directory
#   <root>\Lib\         - standard library (os.py lives here)
#   <root>\DLLs\        - extension modules and bundled DLLs
#   <root>\python311.dll
#
# PowerShell 5.1 compatible. tar.exe ships with Windows 10 1803+.

[CmdletBinding()]
param(
  [string]$DownloadsDir = (Join-Path $env:LOCALAPPDATA "miaos\python-downloads"),
  [string]$RuntimesDir = (Join-Path $env:LOCALAPPDATA "miaos\python-runtimes")
)

$ErrorActionPreference = "Stop"

function Read-ReleaseValue([string]$File, [string]$Key) {
  foreach ($line in Get-Content -LiteralPath $File) {
    if ($line -match ('^' + [regex]::Escape($Key) + '="(.*)"$')) { return $Matches[1] }
  }
  throw "Missing $Key in $File"
}

$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$releaseFile = Join-Path $scriptsDir "python-release-win.env"
if (-not (Test-Path -LiteralPath $releaseFile)) { throw "Missing release file: $releaseFile" }

$pythonVersion = Read-ReleaseValue $releaseFile "PYTHON_VERSION"
$pythonBuild = Read-ReleaseValue $releaseFile "PYTHON_BUILD"
$archiveUrl = Read-ReleaseValue $releaseFile "PYTHON_WIN_ARCHIVE_URL"
$expectedSha256 = (Read-ReleaseValue $releaseFile "PYTHON_WIN_ARCHIVE_SHA256").ToLowerInvariant()

$archiveName = "cpython-$pythonVersion+$pythonBuild-x86_64-pc-windows-msvc-install_only.tar.gz"
$archivePath = Join-Path $DownloadsDir $archiveName

New-Item -ItemType Directory -Force -Path $DownloadsDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimesDir | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
  Write-Host "Downloading $archiveUrl"
  # PowerShell 5.1 defaults to TLS 1.0; GitHub requires TLS 1.2.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tempPath = "$archivePath.partial"
  Invoke-WebRequest -Uri $archiveUrl -OutFile $tempPath -UseBasicParsing
  Move-Item -LiteralPath $tempPath -Destination $archivePath -Force
} else {
  Write-Host "Reusing cached archive: $archivePath"
}

$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  Remove-Item -LiteralPath $archivePath -Force
  throw "Archive checksum mismatch: expected $expectedSha256, received $actualSha256 (deleted the download; rerun to fetch again)"
}
Write-Host "Verified sha256: $actualSha256"

$extractRoot = Join-Path $RuntimesDir "cpython-$pythonVersion+$pythonBuild-x86_64-pc-windows-msvc"
if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

# The archive unpacks to a single top-level "python/" directory.
& tar -xf $archivePath -C $extractRoot
if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }

$runtimeRoot = Join-Path $extractRoot "python"
foreach ($relative in @("python.exe", "Lib\os.py", "DLLs")) {
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot $relative))) {
    throw "Extracted runtime is missing $relative under $runtimeRoot"
  }
}

Write-Host ""
Write-Host "Python $pythonVersion (build $pythonBuild) runtime ready."
Write-Host "Export before packaging:"
Write-Host "  `$env:HERMES_PYTHON_RUNTIME_DIR = `"$runtimeRoot`""

# GitHub Actions contract (see .github/workflows/windows-build.yml): hand the
# runtime path to later workflow steps via GITHUB_ENV when running in CI.
if ($env:GITHUB_ENV) {
  Add-Content -Path $env:GITHUB_ENV -Value "HERMES_PYTHON_RUNTIME_DIR=$runtimeRoot"
}
Write-Output $runtimeRoot
