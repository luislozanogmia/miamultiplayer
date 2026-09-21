'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_FILES = ['bot.yaml', 'AGENTS.md', 'automations.yaml'];

class BotPackageError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'BotPackageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function safeBotId(value) {
  const id = String(value || '').trim();
  if (!BOT_ID_RE.test(id)) throw new BotPackageError('INVALID_BOT_ID', 'bot id is not package-safe', 400);
  return id;
}

function readableSlug(value) {
  const slug = String(value || 'bot').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'bot';
}

function instructionRevision(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function effectiveInstructions(record) {
  for (const value of [record && record.instructions, record && record.role, record && record.output]) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return '';
}

function portableAutomation(value, index) {
  const automation = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {
    id: String(automation.id || `automation-${index + 1}`),
    name: String(automation.name || `Automation ${index + 1}`),
    enabled: false,
    frequency: String(automation.frequency || 'none'),
  };
  for (const key of ['prompt', 'intervalMinutes', 'time', 'day', 'weekdaysOnly', 'utcOffsetMinutes']) {
    if (automation[key] !== undefined) result[key] = automation[key];
  }
  return result;
}

function portableBot(record) {
  const result = {
    schemaVersion: 1,
    packageVersion: 1,
    id: String(record.id),
    name: String(record.name || 'Bot'),
    requiredCapabilities: [],
  };
  for (const key of ['model', 'modelProvider', 'replyAlways', 'avatarColor']) {
    if (record[key] !== undefined && record[key] !== null) result[key] = record[key];
  }
  if (Array.isArray(record.departments)) result.departments = record.departments.slice();
  return result;
}

function createBotPackageStore(rootDirectory) {
  const root = path.resolve(String(rootDirectory || ''));
  if (!rootDirectory) throw new BotPackageError('INVALID_PACKAGE_ROOT', 'bot package root is required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new BotPackageError('INVALID_PACKAGE_ROOT', 'bot package root must be a real directory');
  }

  function assertRegularFile(filePath, label) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BotPackageError('UNSAFE_PACKAGE_ENTRY', `${label} must be a regular file`);
  }

  function assertSafeAssets(directory) {
    const assets = path.join(directory, 'assets');
    if (!fs.existsSync(assets)) return;
    const stat = fs.lstatSync(assets);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BotPackageError('UNSAFE_PACKAGE_ENTRY', 'assets must be a real directory');
  }

  function candidates(id) {
    const suffix = `--${safeBotId(id)}`;
    const matching = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && entry.name.endsWith(suffix));
    if (matching.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new BotPackageError('UNSAFE_PACKAGE_ENTRY', `bot package for ${id} must be a real directory`);
    }
    return matching.map((entry) => path.join(root, entry.name));
  }

  function findDirectory(id) {
    const matches = candidates(id);
    if (matches.length > 1) throw new BotPackageError('PACKAGE_COLLISION', `multiple bot packages exist for ${id}`);
    if (!matches.length) return null;
    const manifestPath = path.join(matches[0], 'bot.yaml');
    let manifest;
    try {
      assertRegularFile(manifestPath, 'bot.yaml');
      assertSafeAssets(matches[0]);
      manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch (error) { throw new BotPackageError('PACKAGE_UNREADABLE', `could not read bot package ${id}: ${error.message}`); }
    if (!manifest || manifest.id !== id) throw new BotPackageError('PACKAGE_ID_MISMATCH', `bot package identity does not match ${id}`);
    return matches[0];
  }

  function readInstructions(record) {
    const directory = findDirectory(safeBotId(record && record.id));
    if (!directory) return null;
    try {
      const agentsPath = path.join(directory, 'AGENTS.md');
      assertRegularFile(agentsPath, 'AGENTS.md');
      const instructions = fs.readFileSync(agentsPath, 'utf8');
      if (!instructions.trim()) throw new Error('AGENTS.md is empty');
      return { instructions, instructionRevision: instructionRevision(instructions) };
    } catch (error) {
      throw new BotPackageError('PACKAGE_UNREADABLE', `could not read instructions for ${record.id}: ${error.message}`);
    }
  }

  function desiredDirectory(record) {
    const id = safeBotId(record && record.id);
    return path.join(root, `${readableSlug(record && record.name)}--${id}`);
  }

  function writeManagedFile(directory, name, contents) {
    const target = path.join(directory, name);
    if (path.dirname(target) !== directory || !MANAGED_FILES.includes(name)) throw new BotPackageError('INVALID_PACKAGE_PATH', 'invalid package file');
    fs.writeFileSync(target, contents, { encoding: 'utf8', mode: 0o600 });
  }

  function prepare(record, options = {}) {
    const id = safeBotId(record && record.id);
    const oldDirectory = findDirectory(id);
    const current = oldDirectory ? readInstructions(record) : null;
    const preparedRevision = current && current.instructionRevision;
    if (options.expectedRevision !== undefined && options.expectedRevision !== null
      && (!current || current.instructionRevision !== String(options.expectedRevision))) {
      throw new BotPackageError('INSTRUCTIONS_CONFLICT', 'Bot instructions changed on disk. Reload before saving.', 409);
    }
    const instructions = options.writeInstructions
      ? String(options.instructions === undefined ? effectiveInstructions(record) : options.instructions)
      : current ? current.instructions : effectiveInstructions(record);
    if (!instructions.trim()) throw new BotPackageError('INVALID_INSTRUCTIONS', 'bot instructions are required', 400);

    if (oldDirectory && !options.writeInstructions && oldDirectory === desiredDirectory(record)) {
      let manifest;
      let templates;
      try {
        assertRegularFile(path.join(oldDirectory, 'automations.yaml'), 'automations.yaml');
        manifest = YAML.parse(fs.readFileSync(path.join(oldDirectory, 'bot.yaml'), 'utf8'));
        templates = YAML.parse(fs.readFileSync(path.join(oldDirectory, 'automations.yaml'), 'utf8'));
      } catch (error) {
        throw error instanceof BotPackageError ? error : new BotPackageError('PACKAGE_UNREADABLE', `could not read bot package ${id}: ${error.message}`);
      }
      const nextManifest = portableBot(record);
      const nextTemplates = { schemaVersion: 1, templates: (record.automations || []).map(portableAutomation) };
      if (JSON.stringify(manifest) === JSON.stringify(nextManifest) && JSON.stringify(templates) === JSON.stringify(nextTemplates)) {
        return { instructionRevision: instructionRevision(instructions), apply() {}, finish() {}, rollback() {} };
      }
    }

    const staging = fs.mkdtempSync(path.join(root, `.staging-${id}-`));
    const target = desiredDirectory(record);
    const backup = path.join(root, `.backup-${id}-${crypto.randomUUID()}`);
    let created = false;
    let moved = false;
    const replaced = [];
    try {
      fs.mkdirSync(path.join(staging, 'assets'), { recursive: true, mode: 0o700 });
      writeManagedFile(staging, 'bot.yaml', YAML.stringify(portableBot(record)));
      writeManagedFile(staging, 'AGENTS.md', instructions);
      writeManagedFile(staging, 'automations.yaml', YAML.stringify({ schemaVersion: 1, templates: (record.automations || []).map(portableAutomation) }));
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error instanceof BotPackageError ? error : new BotPackageError('PACKAGE_WRITE_FAILED', `could not prepare bot package ${id}: ${error.message}`);
    }
    return {
      instructionRevision: instructionRevision(instructions),
      apply() {
        try {
          if (oldDirectory) {
            const latest = readInstructions(record);
            if (!latest || latest.instructionRevision !== preparedRevision) {
              throw new BotPackageError('INSTRUCTIONS_CONFLICT', 'Bot instructions changed on disk. Reload before saving.', 409);
            }
          }
          if (fs.existsSync(target) && target !== oldDirectory) {
            throw new BotPackageError('PACKAGE_COLLISION', `bot package path already exists for ${id}`);
          }
          if (!oldDirectory) {
            fs.renameSync(staging, target);
            created = true;
            return;
          }
          fs.mkdirSync(backup, { mode: 0o700 });
          if (oldDirectory !== target) {
            fs.renameSync(oldDirectory, target);
            moved = true;
          }
          for (const name of MANAGED_FILES) {
            const activeFile = path.join(target, name);
            assertRegularFile(activeFile, name);
            fs.renameSync(activeFile, path.join(backup, name));
            replaced.push(name);
            fs.renameSync(path.join(staging, name), activeFile);
          }
        } catch (error) {
          this.rollback();
          throw error instanceof BotPackageError ? error : new BotPackageError('PACKAGE_WRITE_FAILED', `could not install bot package ${id}: ${error.message}`);
        }
      },
      finish() {
        try {
          if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
          if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        } catch (error) {
          console.error('bot package cleanup failed for', id, error.message);
        }
      },
      rollback() {
        if (created && fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          created = false;
        } else if (oldDirectory) {
          for (const name of replaced.slice().reverse()) {
            const activeFile = path.join(target, name);
            if (fs.existsSync(activeFile)) fs.rmSync(activeFile, { force: true });
            if (fs.existsSync(path.join(backup, name))) fs.renameSync(path.join(backup, name), activeFile);
          }
          replaced.length = 0;
          if (moved && fs.existsSync(target) && !fs.existsSync(oldDirectory)) {
            fs.renameSync(target, oldDirectory);
            moved = false;
          }
        }
        if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      },
    };
  }

  function hydrate(record, options = {}) {
    if (!record) return record;
    let current = readInstructions(record);
    if (!current) {
      if (!options.allowCreate) throw new BotPackageError('PACKAGE_MISSING', `bot package is missing for ${record.id}`);
      const change = prepare(record, { writeInstructions: true, instructions: effectiveInstructions(record) });
      change.apply();
      change.finish();
      current = readInstructions(record);
    }
    return { ...record, instructions: current.instructions, instructionsRevision: current.instructionRevision };
  }

  function prepareDelete(id) {
    const directory = findDirectory(safeBotId(id));
    if (!directory) return { apply() {}, finish() {}, rollback() {} };
    const trashRoot = path.join(root, '.trash');
    const backup = path.join(trashRoot, `${path.basename(directory)}--${crypto.randomUUID()}`);
    let applied = false;
    return {
      apply() { fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 }); fs.renameSync(directory, backup); applied = true; },
      finish() {},
      rollback() { if (applied && fs.existsSync(backup)) fs.renameSync(backup, directory); },
    };
  }

  return { root, hydrate, prepare, prepareDelete, findDirectory };
}

module.exports = {
  BotPackageError,
  createBotPackageStore,
  instructionRevision,
  effectiveInstructions,
  portableAutomation,
  portableBot,
  readableSlug,
};
