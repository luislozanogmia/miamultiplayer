"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildWindowsIcon, windowsIconFromIcns } = require("./build-windows-icon.cjs");
const sourcePath = path.join(__dirname, "..", "assets", "mia.icns");
const source = fs.readFileSync(sourcePath);

test("Windows ICO preserves the branded PNG pixels at each supported size", () => {
  const icon = windowsIconFromIcns(source);
  assert.deepEqual(icon.subarray(0, 6), Buffer.from([0, 0, 1, 0, 4, 0]));
  let expectedOffset = 70;
  for (const [index, size] of [32, 64, 128, 256].entries()) {
    const entry = 6 + 16 * index;
    assert.equal(icon[entry], size === 256 ? 0 : size);
    assert.equal(icon[entry + 1], icon[entry]);
    assert.equal(icon.readUInt16LE(entry + 2), 0);
    assert.equal(icon.readUInt16LE(entry + 4), 1);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    assert.equal(icon.readUInt32LE(entry + 12), expectedOffset);
    const length = icon.readUInt32LE(entry + 8);
    const png = icon.subarray(expectedOffset, expectedOffset + length);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.ok(source.includes(png), "PNG bytes must be copied unchanged from the existing icon");
    expectedOffset += length;
  }
  assert.equal(icon.length, expectedOffset);
  assert.deepEqual(windowsIconFromIcns(source), icon, "generation is deterministic");
});

test("icon generation writes a staged ICO without changing the source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-win-icon-"));
  try {
    const output = path.join(root, "assets", "mia.ico");
    assert.equal(buildWindowsIcon(sourcePath, output), output);
    assert.deepEqual(fs.readFileSync(output), windowsIconFromIcns(source));
    assert.deepEqual(fs.readFileSync(sourcePath), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed or incomplete icon sources fail before emitting an ICO", () => {
  assert.throws(() => windowsIconFromIcns(Buffer.alloc(0)), /Invalid ICNS/);
  assert.throws(() => windowsIconFromIcns(source.subarray(0, source.length - 1)), /Invalid ICNS/);
  const corrupt = Buffer.from(source);
  corrupt.writeUInt32BE(0, 12);
  assert.throws(() => windowsIconFromIcns(corrupt), /Invalid ICNS entry length/);
  const empty = Buffer.from("69636e7300000008", "hex");
  assert.throws(() => windowsIconFromIcns(empty), /missing the 32px/);
});
