"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareWindowsInstallerProgress, windowsInstallerProgressTemplates } = require("./windows-install-progress.cjs");
const templates = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates", "nsis");

test("status hooks preserve every upstream install, extraction and retry instruction", () => {
  const output = windowsInstallerProgressTemplates(templates);
  for (const [name, file] of [["installSection.nsh", "installSection.nsh"], ["extractAppPackage.nsh", "include/extractAppPackage.nsh"], ["installer.nsh", "include/installer.nsh"]]) {
    const original = fs.readFileSync(path.join(templates, file), "utf8");
    assert.equal(output[name].replace(/^ *!insertmacro miaInstallStage .*\n/gm, ""), original);
  }
});

test("generated include preserves the long-path uninstaller and default builder script", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-nsis-progress-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { include, compilerCommands } = prepareWindowsInstallerProgress(directory);
  const source = fs.readFileSync(include, "utf8");
  assert.equal(compilerCommands["!cd"], `"${directory}"`);
  assert.equal(compilerCommands["!addincludedir"], `"${templates}"`);
  assert.ok(source.includes("windows-uninstaller.nsh"));
  assert.ok(source.includes('SendMessage $1 ${WM_SETTEXT} 0 "STR:${text}"'));
  assert.ok(source.includes("Push $0") && source.includes("Pop $0"));
  assert.ok(source.includes("Push $1") && source.includes("Pop $1"));
  assert.ok(source.includes("Push $2") && source.includes("Pop $2"));
  assert.ok(source.includes("IfErrors 0 +2") && source.includes("SetErrors") && source.includes("ClearErrors"));
  assert.ok(!fs.existsSync(path.join(directory, "installer.nsi")), "do not replace builder's default uninstaller generation");
  for (const entry of fs.readdirSync(templates, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".nsh") && entry.name !== "installSection.nsh") {
      assert.deepEqual(fs.readFileSync(path.join(directory, entry.name)), fs.readFileSync(path.join(templates, entry.name)),
        `preserve current-directory include precedence for ${entry.name}`);
    }
  }
});

test("a changed upstream template cannot silently omit a progress hook", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-nsis-template-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "installSection.nsh"), "changed upstream template\n");
  assert.throws(() => windowsInstallerProgressTemplates(directory), /template changed/);
});
