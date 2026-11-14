'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Remote link: what this computer remembers about the phones paired with it.
// One name the Hub knows this computer by, and for each phone the key the two
// of them share. The keys never leave this file and the app's own page.
const HOST = /^[a-f0-9]{32}$/, SECRET = /^[A-Za-z0-9_-]{43}$/, MAX_PHONES = 10;

// The kept state, or null when there is none or it is not in the shape we wrote.
function clean(value) {
  if (!value || typeof value !== 'object' || !HOST.test(value.host || '')) return null;
  const devices = value.devices;
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) return null;
  const ids = Object.keys(devices);
  if (ids.length > MAX_PHONES || !ids.every(id => HOST.test(id) && devices[id] && SECRET.test(devices[id].secret || ''))) return null;
  return { host: value.host, devices: Object.fromEntries(ids.map(id => [id, { secret: devices[id].secret }])) };
}
function readState(file) {
  try { return clean(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeState(file, value) {
  const state = clean(value);
  if (!state) return null;
  const draft = file + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(draft, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(draft, file);
  return state;
}
module.exports = { readState, writeState };
