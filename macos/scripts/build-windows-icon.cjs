"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const ICON_SIZES = [32, 64, 128, 256];

// Reuse the branded PNG representations already embedded in our macOS icon.
// PNG entries are supported by Windows Vista and later; no image converter or
// host-specific tooling is needed, and the original pixels stay unchanged.
function windowsIconFromIcns(source) {
  if (source.length < 8 || source.toString("ascii", 0, 4) !== "icns"
      || source.readUInt32BE(4) !== source.length) {
    throw new Error("Invalid ICNS header or length");
  }
  const images = new Map();
  for (let offset = 8; offset < source.length;) {
    if (offset + 8 > source.length) throw new Error("Truncated ICNS entry");
    const length = source.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > source.length) throw new Error("Invalid ICNS entry length");
    const png = source.subarray(offset + 8, offset + length);
    if (png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") {
        throw new Error("Invalid PNG header in ICNS");
      }
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (ICON_SIZES.includes(width) && width === height) {
        if (png[24] !== 8 || png[25] !== 6) throw new Error("Windows icon requires 8-bit RGBA PNGs");
        if (!images.has(width)) images.set(width, png);
      }
    }
    offset += length;
  }
  const header = Buffer.alloc(6 + 16 * ICON_SIZES.length);
  header.writeUInt16LE(1, 2); // ICONDIR type: icon, not cursor.
  header.writeUInt16LE(ICON_SIZES.length, 4);
  let offset = header.length;
  const payloads = ICON_SIZES.map((size, index) => {
    const png = images.get(size);
    if (!png) throw new Error(`ICNS is missing the ${size}px PNG representation`);
    const entry = 6 + 16 * index;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
    return png;
  });
  return Buffer.concat([header, ...payloads]);
}

function buildWindowsIcon(sourcePath, outputPath) {
  const icon = windowsIconFromIcns(fs.readFileSync(sourcePath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, icon);
  return outputPath;
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  process.stdout.write(`${buildWindowsIcon(
    process.argv[2] || path.join(root, "assets", "mia.icns"),
    process.argv[3] || path.join(root, "assets", "mia.ico"),
  )}\n`);
}

module.exports = { buildWindowsIcon, windowsIconFromIcns };
