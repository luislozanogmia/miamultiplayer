'use strict';

const fs = require('node:fs');

const PROCESS_SECRETS_MARKER = 'MIAOS_PROCESS_SECRETS_STDIN';

// Receive short-lived process credentials through an anonymous pipe instead
// of argv, disk, or the child's launch environment. The caller supplies the
// exact names this process is allowed to accept.
function loadProcessSecretsFromStdin(allowedNames, { env = process.env, read = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (env[PROCESS_SECRETS_MARKER] !== '1') return false;
  delete env[PROCESS_SECRETS_MARKER];
  const allowed = new Set(allowedNames || []);
  const raw = String(read() || '');
  if (!raw || Buffer.byteLength(raw) > 4096) throw new Error('Invalid process secret payload');
  let values;
  try { values = JSON.parse(raw); } catch (_) { throw new Error('Invalid process secret payload'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid process secret payload');
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name) || typeof value !== 'string' || !value || value.length > 2048) {
      throw new Error('Invalid process secret payload');
    }
    env[name] = value;
  }
  return true;
}

function sendProcessSecrets(child, values) {
  if (!child || !child.stdin || typeof child.stdin.end !== 'function') {
    throw new Error('Process secret pipe is unavailable');
  }
  child.stdin.on?.('error', () => {});
  child.stdin.end(`${JSON.stringify(values)}\n`);
}

module.exports = { PROCESS_SECRETS_MARKER, loadProcessSecretsFromStdin, sendProcessSecrets };
