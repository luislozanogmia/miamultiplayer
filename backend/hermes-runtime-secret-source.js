'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Explicit workstation configuration, never request/model input. Hermes owns
// resolution and captures/discards helper output; config stores only a path.
function runtimeSecretSourceLines(helper = process.env.MIAOS_HERMES_SECRET_HELPER) {
  if (!helper) return ['secrets:', '  sources: []'];
  if (typeof helper !== 'string' || !path.isAbsolute(helper) || /[\r\n\0]/.test(helper)) throw new Error('Invalid runtime secret helper');
  const stat = fs.lstatSync(helper);
  if (!stat.isFile() || (stat.mode & 0o022) || !(stat.mode & 0o100) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Runtime secret helper must be owner-controlled and executable');
  const command = "'" + helper.replace(/'/g, "'\\''") + "'";
  return ['secrets:', '  sources:', '    - command', '  command:', '    enabled: true', `    command: ${JSON.stringify(command)}`, '    helper_timeout_seconds: 3'];
}
module.exports = { runtimeSecretSourceLines };
