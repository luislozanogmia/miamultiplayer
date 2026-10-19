"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkDownload } = require("./download-check.cjs");

test("download check: documents pass, programs need review, disguised programs are blocked", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-download-check-"));
  const file = (name, bytes) => { const target = path.join(directory, name); fs.writeFileSync(target, bytes); return target; };
  try {
    assert.equal((await checkDownload(file("report.pdf", "%PDF-1.7\n"))).verdict, "safe");
    assert.equal((await checkDownload(file("notes.txt", "hello"))).verdict, "safe");
    assert.equal((await checkDownload(file("fake.pdf", "<html>"))).verdict, "review");
    const disguised = await checkDownload(file("invoice.pdf", Buffer.from("cffaedfe07000001", "hex")));
    assert.equal(disguised.verdict, "blocked");
    assert.match(disguised.reason, /named like a \.pdf file, but it is a Mac program/);
    assert.equal((await checkDownload(file("photo.jpg", "#!/bin/sh\nrm -rf ~"))).verdict, "blocked");
    assert.equal((await checkDownload(file("install.sh", "#!/bin/sh\n"))).verdict, "review");
    assert.equal((await checkDownload(file("setup.exe", "MZ\x90\x00"))).verdict, "review");
    for (const name of ["invoice.lnk", "invoice.hta", "unknown.custom", "README"]) {
      assert.equal((await checkDownload(file(name, "unrecognized contents"), { platform: "win32" })).verdict, "review", name);
    }

    const calls = [];
    const rejected = await checkDownload(file("Tool.dmg", "koly"), { platform: "darwin", run: (cmd, args, _opts, done) => { calls.push([cmd, args]); done(new Error("rejected")); } });
    assert.equal(rejected.verdict, "review");
    assert.match(rejected.reason, /could not verify who made it/);
    assert.equal(calls[0][0], "/usr/sbin/spctl");
    const accepted = await checkDownload(file("Tool.pkg", "xar!"), { platform: "darwin", run: (_cmd, _args, _opts, done) => done(null) });
    assert.match(accepted.reason, /accepts its signature/);

    assert.equal((await checkDownload(path.join(directory, "gone.pdf"))).verdict, "missing");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
