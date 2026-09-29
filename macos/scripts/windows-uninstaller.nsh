; Based on electron-builder 26.15.3 templates/nsis/uninstaller.nsh (MIT).
; Copyright (c) 2015 Loopline Systems
;
; Permission is hereby granted, free of charge, to any person obtaining a copy
; of this software and associated documentation files (the "Software"), to deal
; in the Software without restriction, including without limitation the rights
; to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
; copies of the Software, and to permit persons to whom the Software is
; furnished to do so, subject to the following conditions:
;
; The above copyright notice and this permission notice shall be included in all
; copies or substantial portions of the Software.
;
; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
; IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
; FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
; LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
; OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
; SOFTWARE.
;
; Preserve its transactional move/rollback, using extended paths so deep
; bundled dependencies remain removable without machine-wide policy changes.
!ifdef BUILD_UNINSTALLER
; electron-builder includes this file before common.nsh. Expand functions
; through its header hook only after LogicLib and filename defines exist.
!macro customHeader
Function un.miaAtomicRMDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "\\?\$INSTDIR$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "\\?\$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "\\?\$PLUGINSDIR\old-install$R0\$R2"

      Push "$R0\$R2"
      Call un.miaAtomicRMDir
      Pop $R3

      ${if} $R3 != 0
        Goto done
      ${endIf}

      Goto continue

    isNotDir:
      ClearErrors
      Rename "\\?\$INSTDIR$R0\$R2" "\\?\$PLUGINSDIR\old-install$R0\$R2"

      # Ignore errors when renaming ourselves.
      StrCmp "$R0\$R2" "${UNINSTALL_FILENAME}" 0 +2
      ClearErrors

      IfErrors 0 +3
      StrCpy $R3 "\\?\$INSTDIR$R0\$R2"
      Goto done

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R3 0

  done:
    FindClose $R1

    StrCpy $R0 $R3

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.miaRestoreFiles
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "\\?\$PLUGINSDIR\old-install$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "\\?\$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "\\?\$INSTDIR$R0\$R2"

      Push "$R0\$R2"
      Call un.miaRestoreFiles
      Pop $R3

      Goto continue

    isNotDir:
      Rename "\\?\$PLUGINSDIR\old-install$R0\$R2" "\\?\$INSTDIR$R0\$R2"

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R0 0
    FindClose $R1

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd


!macroend

!macro customRemoveFiles
    ${if} ${isUpdated}
      CreateDirectory "\\?\$PLUGINSDIR\old-install"

      Push ""
      Call un.miaAtomicRMDir
      Pop $R0

      ${if} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"

        # Attempt to restore previous directory
        Push ""
        Call un.miaRestoreFiles
        Pop $R0

        Abort `Can't rename "\\?\$INSTDIR" to "\\?\$PLUGINSDIR\old-install".`
      ${endif}

    ${endif}

    # Move out of $INSTDIR so it can be removed
    SetOutPath $TEMP
    # Remove all files (or remaining shallow directories from the block above)
    RMDir /r "\\?\$INSTDIR"

!macroend
!endif
