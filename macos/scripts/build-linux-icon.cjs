"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const sourcePath = path.join(ROOT, "assets", "mia-512.png");
const outputPath = path.join(ROOT, "assets", "mia-512-linux.png");
const chrome = process.env.CHROME_BIN
  || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(fs.existsSync);

if (!chrome) throw new Error("A Chromium-based browser is required to rebuild the Linux icon.");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-linux-icon-"));
try {
  const source = fs.readFileSync(sourcePath).toString("base64");
  const htmlPath = path.join(temporaryRoot, "icon.html");
  fs.writeFileSync(htmlPath, `<!doctype html>
<style>
  html,body{margin:0;width:512px;height:512px;overflow:hidden;background:transparent}
  .tile{position:relative;width:512px;height:512px;border-radius:104px;overflow:hidden;background:#b8b8b6}
  img{position:absolute;inset:0;width:512px;height:512px}
</style>
<div class="tile"><img src="data:image/png;base64,${source}" alt=""></div>`);
  const result = spawnSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    "--window-size=512,512",
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).toString(),
  ], { encoding: "utf8" });
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error(String(result.stderr || result.stdout || "Linux icon rendering failed").trim());
  }
  process.stdout.write(`${outputPath}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
