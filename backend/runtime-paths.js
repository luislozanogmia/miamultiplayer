'use strict';

const fs = require('fs');
const path = require('path');

function requiredConfiguredValue(name, value) {
  const configured = String(value ?? '').trim();
  if (!configured) throw new Error(`Mia requires ${name} to be configured.`);
  return configured;
}

function requiredConfiguredPath(name, value, { mustExist = false, directory = false } = {}) {
  const resolved = path.resolve(requiredConfiguredValue(name, value));
  if (!mustExist) return resolved;
  let stat;
  try { stat = fs.statSync(resolved); } catch (_) {
    throw new Error(`Mia ${name} does not exist: ${resolved}`);
  }
  if (directory && !stat.isDirectory()) throw new Error(`Mia ${name} is not a directory: ${resolved}`);
  return resolved;
}

function requiredConfiguredExecutable(name, value) {
  const configured = requiredConfiguredValue(name, value);
  if (path.isAbsolute(configured) || configured.includes(path.sep)) {
    const resolved = path.resolve(configured);
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) {
      throw new Error(`Mia ${name} does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`Mia ${name} is not a file: ${resolved}`);
    try { fs.accessSync(resolved, fs.constants.X_OK); } catch (_) {
      throw new Error(`Mia ${name} is not executable: ${resolved}`);
    }
    return resolved;
  }

  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, configured);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return configured;
      }
    } catch (_) { /* try the next configured PATH entry */ }
  }
  throw new Error(`Mia ${name} does not resolve on PATH: ${configured}`);
}

// Windows packaged builds cannot spawn the .cmd runtime shims: Node rejects
// them outright (CVE-2024-27980), and routing model- or user-directed
// arguments through cmd.exe would be a shell-injection risk. The desktop
// shell instead publishes the Hermes launcher as an argv vector
// (interpreter + script, both Mia-owned absolute paths) in
// MIAOS_HERMES_ARGV_JSON. Every Hermes call site launches through this
// helper so the vector and plain-binary forms stay interchangeable.
function configuredHermesLaunch(
  binValue = process.env.HERMES_BIN,
  argvJson = process.env.MIAOS_HERMES_ARGV_JSON
) {
  const raw = String(argvJson ?? '').trim();
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      throw new Error('MIAOS_HERMES_ARGV_JSON must be valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0
      || parsed.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error('MIAOS_HERMES_ARGV_JSON must be a non-empty array of strings');
    }
    return {
      command: requiredConfiguredExecutable('MIAOS_HERMES_ARGV_JSON', parsed[0]),
      prefixArgs: parsed.slice(1),
    };
  }
  return {
    command: requiredConfiguredExecutable('HERMES_BIN', binValue),
    prefixArgs: [],
  };
}

module.exports = {
  configuredHermesLaunch,
  requiredConfiguredExecutable,
  requiredConfiguredPath,
  requiredConfiguredValue,
};
