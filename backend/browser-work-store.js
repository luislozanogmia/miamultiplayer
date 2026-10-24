'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Private product state, never a second Hermes transcript/runtime. The caller
// supplies a 256-bit key from the existing approved runtime secret store.
function createBrowserWorkStore({ filePath, key }) {
  if (!filePath || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('encrypted browser work store requires a runtime key');
  let state = { version: 1, works: {} };
  if (fs.existsSync(filePath)) {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (envelope.version !== 1) throw new Error('unsupported browser work store');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from('mia-browser-work-v1'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    if (state.version !== 1 || !state.works || Array.isArray(state.works)) throw new Error('invalid browser work state');
  }
  const clone = value => structuredClone(value);
  return {
    list: () => Object.values(state.works).map(clone),
    get: id => state.works[id] ? clone(state.works[id]) : null,
    put(work) {
      const next = clone(state);
      next.works[work.id] = clone(work);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('mia-browser-work-v1'));
      const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(fd, envelope);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, filePath);
        const dir = fs.openSync(path.dirname(filePath), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        state = next;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
      return clone(work);
    },
  };
}
module.exports = { createBrowserWorkStore };
