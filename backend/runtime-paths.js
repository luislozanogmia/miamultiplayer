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

module.exports = {
  requiredConfiguredExecutable,
  requiredConfiguredPath,
  requiredConfiguredValue,
};
