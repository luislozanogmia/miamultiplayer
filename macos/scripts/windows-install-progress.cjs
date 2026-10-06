"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Insert status text into the pinned templates. Their extraction, retry,
// registry and rollback instructions remain byte-for-byte unchanged.
function insertOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error("Windows installer template changed; review progress hooks before packaging");
  return source.replace(anchor, replacement);
}

function windowsInstallerProgressTemplates(templates) {
  let section = fs.readFileSync(path.join(templates, "installSection.nsh"), "utf8");
  section = insertOnce(section,
    "!insertmacro uninstallOldVersion SHELL_CONTEXT",
    '!insertmacro miaInstallStage "Preparing installation…"\n!insertmacro uninstallOldVersion SHELL_CONTEXT');
  section = insertOnce(section,
    "!insertmacro installApplicationFiles",
    '!insertmacro miaInstallStage "Unpacking Mia…"\n!insertmacro installApplicationFiles\n!insertmacro miaInstallStage "Finishing installation…"');
  let extract = fs.readFileSync(path.join(templates, "include", "extractAppPackage.nsh"), "utf8");
  extract = insertOnce(extract,
    '  Nsis7z::Extract "${FILE}"\n  Pop $R0',
    '  !insertmacro miaInstallStage "Unpacking Mia…"\n  Nsis7z::Extract "${FILE}"\n  Pop $R0');
  extract = insertOnce(extract,
    '    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
    '    !insertmacro miaInstallStage "Copying Mia files…"\n    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR');
  return {
    "installSection.nsh": section,
    "extractAppPackage.nsh": extract,
    "installer.nsh": fs.readFileSync(path.join(templates, "include", "installer.nsh"), "utf8"),
  };
}

const PROGRESS_MACRO = [
  '!macro miaInstallStage text',
  '  Push $2',
  '  StrCpy $2 0',
  '  IfErrors 0 +2',
  '    StrCpy $2 1',
  '  DetailPrint "${text}"',
  '  ${IfNot} ${Silent}',
  '    Push $0',
  '    Push $1',
  '    FindWindow $0 "#32770" "" $hwndparent',
  '    FindWindow $0 "#32770" "" $hwndparent $0',
  '    GetDlgItem $1 $0 1000',
  '    SendMessage $1 ${WM_SETTEXT} 0 "STR:${text}"',
  '    Pop $1',
  '    Pop $0',
  '  ${EndIf}',
  '  ${If} $2 == 1',
  '    SetErrors',
  '  ${Else}',
  '    ClearErrors',
  '  ${EndIf}',
  '  Pop $2',
  '!macroend',
  '',
].join("\n");

function nsisPath(value) {
  if (/[\r\n]/.test(value)) throw new Error("Invalid NSIS include path");
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

function prepareWindowsInstallerProgress(directory) {
  const builder = path.dirname(require.resolve("app-builder-lib/package.json"));
  const version = JSON.parse(fs.readFileSync(path.join(builder, "package.json"), "utf8")).version;
  if (version !== "26.15.3") throw new Error("Review Windows progress hooks before upgrading electron-builder");
  const templateDirectory = path.join(builder, "templates", "nsis");
  const templates = windowsInstallerProgressTemplates(templateDirectory);
  fs.mkdirSync(directory, { recursive: true });
  // Preserve current-directory precedence for upstream root includes too.
  // Otherwise NSIS's built-in MultiUser.nsh shadows builder's multiUser.nsh
  // after !cd, even with the original template directory on the include path.
  for (const entry of fs.readdirSync(templateDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".nsh")) {
      fs.copyFileSync(path.join(templateDirectory, entry.name), path.join(directory, entry.name));
    }
  }
  for (const [name, content] of Object.entries(templates)) fs.writeFileSync(path.join(directory, name), content);
  const include = path.join(directory, "mia-progress.nsh");
  const uninstaller = path.join(__dirname, "windows-uninstaller.nsh");
  fs.writeFileSync(include, `!include "${nsisPath(uninstaller)}"\n${PROGRESS_MACRO}`);
  // The pinned compiler searches its current directory first. Set it for
  // compilation so our status-only copies are consumed; retain the upstream
  // template directory for every other include. This keeps builder's default
  // installer script and its generated uninstaller/signing lifecycle intact.
  return {
    include,
    compilerCommands: {
      "!addincludedir": `"${nsisPath(templateDirectory)}"`,
      "!cd": `"${nsisPath(directory)}"`,
    },
  };
}

module.exports = { prepareWindowsInstallerProgress, windowsInstallerProgressTemplates };
