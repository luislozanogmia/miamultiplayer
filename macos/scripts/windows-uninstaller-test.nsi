Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
OutFile "harness.exe"
!define BUILD_UNINSTALLER
!include "windows-uninstaller.nsh"
!include "LogicLib.nsh"
!define UNINSTALL_FILENAME "uninstall-test.exe"
!define isUpdated '"${TEST_UPDATE}" == "1"'
!insertmacro customHeader
Section
  WriteUninstaller "$EXEDIR\uninstall-test.exe"
SectionEnd
Section "Uninstall"
  InitPluginsDir
  !insertmacro customRemoveFiles
SectionEnd
