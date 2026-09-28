$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path $env:TEMP ('mia-nsis-review-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'windows-uninstaller-test.nsi'), (Join-Path $PSScriptRoot 'windows-uninstaller.nsh'), (Join-Path $PSScriptRoot 'windows-uninstaller-fixture.cjs') $taskRoot
$compiler = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis\nsis-3.0.4.1\makensis.exe'
if (-not (Test-Path $compiler)) { throw 'Required pinned NSIS 3.0.4.1 compiler is missing' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MiaFixtureLock {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFileW(string p, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
Push-Location $taskRoot
try {
 foreach ($case in @('update', 'ordinary', 'rollback')) {
  $flag = if ($case -eq 'ordinary') { '0' } else { '1' }
  & $compiler "/DTEST_UPDATE=$flag" 'windows-uninstaller-test.nsi' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "compile failed $case" }
  $install = Start-Process (Join-Path $taskRoot 'harness.exe') -ArgumentList '/S' -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw 'harness write uninstaller failed' }
  $fixture = Join-Path $taskRoot $case
  $env:MIA_NSIS_FIXTURE = $fixture
  & node (Join-Path $taskRoot 'windows-uninstaller-fixture.cjs') create
  if ($LASTEXITCODE -ne 0) { throw 'fixture creation failed' }
  $lock = [IntPtr]::Zero
  if ($case -eq 'rollback') {
   $lock = [MiaFixtureLock]::CreateFileW((Join-Path $fixture 'z-locked.txt'), [uint32]2147483648, 1, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
   if ($lock -eq [IntPtr](-1)) { throw 'lock failed' }
  }
  try {
   $uninstall = Start-Process (Join-Path $taskRoot 'uninstall-test.exe') -ArgumentList @('/S', "_?=$fixture") -PassThru
   if (-not $uninstall.WaitForExit(30000)) { $uninstall.Kill(); throw "fixture uninstall timed out $case" }
   $uninstall.Refresh()
   Write-Output "case=$case exit=$($uninstall.ExitCode)"
   $expectedExit = if ($case -eq 'rollback') { 2 } else { 0 }
   if ($uninstall.ExitCode -ne $expectedExit) { throw "Unexpected exit for $case" }
   & node (Join-Path $taskRoot 'windows-uninstaller-fixture.cjs') verify
   if ($LASTEXITCODE -ne 0) { throw "verification failed $case" }
  } finally { if ($lock -ne [IntPtr]::Zero -and $lock -ne [IntPtr](-1)) { [MiaFixtureLock]::CloseHandle($lock) | Out-Null } }
 }
 Write-Output "PASS fixture evidence retained: $taskRoot"
} finally { Pop-Location }
