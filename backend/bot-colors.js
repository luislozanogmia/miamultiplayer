'use strict';

// A bot's color is saved on its record, so every view draws the same one.
// A bot saved before colors were keeps the color its name already gave it:
// this is the palette and hash frontend/app.js uses for a bot with no record.
const MOTE_COLOR_PALETTE = Object.freeze([
  337, 355, 12, 27, 44, 61, 84, 112,
  145, 169, 192, 211, 231, 252, 276, 305,
]);

function colorFromHue(hue) {
  const s = 0.72, l = 0.52;
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    const value = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function botColorForName(name) {
  const key = `color:${String(name || '').trim().toLowerCase() || 'general'}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return colorFromHue(MOTE_COLOR_PALETTE[hash % MOTE_COLOR_PALETTE.length]);
}

module.exports = { MOTE_COLOR_PALETTE, colorFromHue, botColorForName };
