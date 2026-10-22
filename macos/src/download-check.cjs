"use strict";

// A quick, local look at a file a bot (or Mia) downloaded, before anyone
// opens it. It never runs the file. Verdicts:
//   safe     an ordinary document or media file
//   review   a program, installer or script, or contents that don't match
//            the name; it stays in Downloads but opening asks first
//   blocked  a program dressed up as a document; Mia refuses to open it
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const PROGRAM_EXTENSIONS = new Set([
  "app", "dmg", "pkg", "mpkg", "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "fish",
  "py", "rb", "pl", "php", "scpt", "applescript", "workflow", "action", "jar", "dylib", "kext",
  "prefpane", "plugin", "osax", "iso", "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs",
  "js", "jse", "wsf", "lnk", "hta", "deb", "rpm", "appimage",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "txt", "csv", "tsv", "md", "json",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "pages", "numbers", "key", "html", "htm",
  "mp3", "m4a", "wav", "mp4", "mov", "zip",
]);
// Leading bytes each common document must start with.
const DOCUMENT_SIGNATURES = {
  pdf: ["%PDF"], png: ["\x89PNG"], jpg: ["\xff\xd8\xff"], jpeg: ["\xff\xd8\xff"], gif: ["GIF8"],
  zip: ["PK"], docx: ["PK"], xlsx: ["PK"], pptx: ["PK"],
};
// Gatekeeper can judge these; an unsigned disk image is common, so its
// verdict informs the reason rather than blocking.
const GATEKEEPER_TYPES = { pkg: ["--assess", "--type", "install"], mpkg: ["--assess", "--type", "install"],
  dmg: ["--assess", "--type", "open", "--context", "context:primary-signature"], app: ["--assess", "--type", "execute"] };

function programKind(head) {
  const hex = head.subarray(0, 4).toString("hex");
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(hex)) return "Mac program";
  if (hex === "7f454c46") return "Linux program";
  if (head.subarray(0, 2).toString("latin1") === "MZ") return "Windows program";
  if (head.subarray(0, 4).toString("latin1") === "xar!") return "installer";
  if (head.subarray(0, 2).toString("latin1") === "#!") return "script";
  return "";
}

function readHead(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(16);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return head.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

function gatekeeper(filePath, args, run) {
  return new Promise(resolve => {
    run("/usr/sbin/spctl", [...args, filePath], { timeout: 15000 }, error => resolve(!error));
  });
}

async function checkDownload(filePath, { platform = process.platform, run = execFile } = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { verdict: "missing", reason: "The file is not on disk." }; }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const head = stat.isFile() ? readHead(filePath) : Buffer.alloc(0);
  const kind = programKind(head);
  const label = ext ? `.${ext}` : "extensionless";
  if (kind && DOCUMENT_EXTENSIONS.has(ext)) {
    return { verdict: "blocked", reason: `It is named like a ${label} file, but it is a ${kind}.` };
  }
  const signatures = DOCUMENT_SIGNATURES[ext];
  if (signatures && stat.size > 0 && !signatures.some(sig => head.subarray(0, sig.length).toString("latin1") === sig)) {
    return { verdict: "review", reason: `Its contents don't look like a ${label} file.` };
  }
  if (PROGRAM_EXTENSIONS.has(ext) || stat.isDirectory() || kind) {
    let reason = `It is a ${kind || "program, installer or script"}. Open it only if you meant to download it.`;
    if (platform === "darwin" && GATEKEEPER_TYPES[ext]) {
      reason = (await gatekeeper(filePath, GATEKEEPER_TYPES[ext], run))
        ? `macOS accepts its signature, but it is still a ${kind || "program or installer"}. Open it only if you meant to download it.`
        : `macOS could not verify who made it. Open it only if you trust where it came from.`;
    }
    return { verdict: "review", reason };
  }
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    return { verdict: "review", reason: `Mia does not recognize this ${label} file type. Open it only if you trust where it came from.` };
  }
  return { verdict: "safe", reason: stat.size ? `An ordinary ${label} file.` : "An empty file." };
}

module.exports = { checkDownload, programKind };
