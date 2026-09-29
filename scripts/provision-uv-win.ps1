param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$DownloadsDir
)
$ErrorActionPreference = 'Stop'
# Same uv version validated on the Windows build host; verify before extraction
# or execution. Never reuse an ambient uv or execute a mutable installer script.
$version = '0.12.19'
$expected = 'dcbc531a96762569bbfe9639b4f45f00aabff51f427540711f63e7c23f225fdf'
$url = 'https://files.pythonhosted.org/packages/c2/5d/8e0b84503b77ead843ef57e4f9305eb32a95cac6806c0e0d54b9404a5f7b/uv-0.12.19-py3-none-win_amd64.whl'
New-Item -ItemType Directory -Force -Path $DownloadsDir | Out-Null
$archive = Join-Path $DownloadsDir "uv-$version-win.zip"
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Pinned uv archive checksum mismatch; refusing extraction or execution'
}
$staging = Join-Path $DownloadsDir ('uv-extract-' + [Guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($name in @('uv.exe', 'uvx.exe', 'uvw.exe')) {
        Copy-Item -LiteralPath (Join-Path $staging "uv-$version.data\scripts\$name") -Destination $Destination -Force
    }
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
