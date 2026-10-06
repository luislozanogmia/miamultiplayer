"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { prepareWindowsInstallerProgress } = require("./windows-install-progress.cjs");

function windowsInstallerConfig(outputDirectory, iconPath) {
  return {
    appId: "com.miamultiplayer.mia",
    productName: "Mia",
    directories: { output: outputDirectory },
    // The existing packager owns the application payload. electron-builder
    // supplies its maintained NSIS install/update/uninstall implementation.
    npmRebuild: false,
    win: { target: ["nsis"], signAndEditExecutable: false, ...(iconPath ? { icon: iconPath } : {}) },
    nsis: {
      include: path.join(__dirname, "windows-uninstaller.nsh"),
      artifactName: "Mia-Setup-${version}-${arch}.exe",
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      ...(iconPath ? { installerIcon: iconPath, uninstallerIcon: iconPath } : {}),
    },
    publish: [{ provider: "github", owner: "luislozanogmia", repo: "miamultiplayer" }],
  };
}

async function buildWindowsInstaller(packagedRoot, outputDirectory, projectDir, electronVersion, iconPath) {
  const { build, Platform, Arch } = require("electron-builder");
  const progressDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-nsis-progress-"));
  try {
    const config = windowsInstallerConfig(outputDirectory, iconPath);
    const progress = prepareWindowsInstallerProgress(progressDirectory);
    config.nsis.include = progress.include;
    await build({
      projectDir,
      prepackaged: packagedRoot,
      targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
      publish: "never",
      effectiveOptionComputed: async ([, commands]) => {
        Object.assign(commands, progress.compilerCommands);
        return false;
      },
      config: { ...config, electronVersion },
    });
  } finally {
    fs.rmSync(progressDirectory, { recursive: true, force: true });
  }
  const version = require(path.join(projectDir, "package.json")).version;
  const installer = path.join(outputDirectory, `Mia-Setup-${version}-x64.exe`);
  if (!fs.existsSync(installer) || !fs.existsSync(path.join(outputDirectory, "latest.yml"))) {
    throw new Error("Windows installer or OTA manifest was not generated");
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(installer)).digest("hex");
  fs.writeFileSync(`${installer}.sha256`, `${digest}  ${path.basename(installer)}\n`);
  return installer;
}

module.exports = { windowsInstallerConfig, buildWindowsInstaller };
