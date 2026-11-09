'use strict';

// The skills library: one folder per skill, <data>/skills/<id>/, in the same
// format Codex, Claude and Hermes use. SKILL.md says what the skill is and when
// to use it; the folder can hold more files it points to (notes like ICP.md,
// scripts like search.py). A bot carries skills by listing their ids; its
// folder gets a link to each one (<bot>/skills/<id>), so editing a skill in the
// library changes it for every bot that carries it. Sharing a bot copies its
// skills' files, because the team has no access to this folder.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const MAX_BOT_SKILLS = 10;
const MAX_SKILL_CHARS = 20000;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 500;
const SKILL_FILE = 'SKILL.md';
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The other files in a skill folder: plain names, up to four folders deep.
const MAX_SKILL_FILES = 50;
const MAX_FILE_CHARS = 200000;
const MAX_FOLDER_CHARS = 1000000;
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

class SkillError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function defaultSkillsRoot(env = process.env) {
  const packages = path.resolve(env.MIAOS_BOT_PACKAGE_DIR
    || path.join(path.dirname(path.resolve(env.DB_PATH || path.join(__dirname, 'mia-os.db'))), 'bots'));
  return path.join(path.dirname(packages), 'skills');
}

function skillSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'skill';
}

function parseSkillFile(text) {
  const source = String(text || '');
  const match = source.match(FRONT_MATTER);
  let meta = {};
  if (match) {
    try { meta = YAML.parse(match[1]) || {}; } catch (_) { meta = {}; }
  }
  return {
    name: typeof meta.name === 'string' ? meta.name.trim() : '',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    body: (match ? source.slice(match[0].length) : source).trim(),
  };
}

function createSkillsLibrary(rootDirectory) {
  const root = () => path.resolve(typeof rootDirectory === 'function' ? rootDirectory() : rootDirectory);
  const directoryOf = (id) => path.join(root(), id);

  function isRealDirectory(target) {
    try { return fs.lstatSync(target).isDirectory(); } catch (_) { return false; }
  }

  // Only real folders and real files count: a link planted in the library
  // could otherwise pull an unrelated file into a bot or a share.
  function read(id) {
    if (!SKILL_ID.test(String(id || ''))) return null;
    const directory = directoryOf(id);
    if (!isRealDirectory(directory)) return null;
    const file = path.join(directory, SKILL_FILE);
    let stat;
    try { stat = fs.lstatSync(file); } catch (_) { return null; }
    if (!stat.isFile() || stat.size > MAX_SKILL_CHARS * 4 + 4096) return null;
    const parsed = parseSkillFile(fs.readFileSync(file, 'utf8'));
    if (!parsed.body) return null;
    return {
      id,
      name: parsed.name || id,
      description: parsed.description.slice(0, MAX_DESCRIPTION_CHARS),
      body: parsed.body.slice(0, MAX_SKILL_CHARS),
      files: listFiles(directory),
      folder: directory,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  // The skill's other files, by path, without SKILL.md. Links, hidden files
  // and anything past the limits are left out.
  function listFiles(directory) {
    const files = [];
    const walk = (folder, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_SKILL_FILES || entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 3) walk(full, rel, depth + 1);
        else if (entry.isFile() && FILE_PATH.test(rel) && rel !== SKILL_FILE) {
          let size = 0;
          try { size = fs.lstatSync(full).size; } catch (_) { continue; }
          files.push({ path: rel, size });
        }
      }
    };
    walk(directory, '', 0);
    return files;
  }

  // A file's text, or null when it is missing, too big or not text.
  function readFile(id, rel) {
    const skill = read(id);
    if (!skill || !skill.files.some((file) => file.path === rel)) return null;
    const full = path.join(directoryOf(id), rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { return null; }
    if (!stat.isFile() || stat.size > MAX_FILE_CHARS * 4) return null;
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8').slice(0, MAX_FILE_CHARS);
  }

  function withFileText(skill) {
    return { ...skill, files: skill.files.map((file) => ({ path: file.path, body: readFile(skill.id, file.path) }))
      .filter((file) => file.body !== null) };
  }

  function list() {
    let entries;
    try { entries = fs.readdirSync(root(), { withFileTypes: true }); } catch (_) { return []; }
    return entries
      .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name))
      .map((entry) => read(entry.name))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function clean(input) {
    const name = String(input && input.name || '').replace(/\s+/g, ' ').trim();
    const description = String(input && input.description || '').replace(/\s+/g, ' ').trim();
    const body = String(input && input.body || '').replace(/\r\n/g, '\n').trim();
    if (!name || name.length > MAX_NAME_CHARS) throw new SkillError('invalid_skill', `A skill needs a name of up to ${MAX_NAME_CHARS} characters.`);
    if (description.length > MAX_DESCRIPTION_CHARS) throw new SkillError('invalid_skill', `Keep the description to ${MAX_DESCRIPTION_CHARS} characters.`);
    if (!body) throw new SkillError('invalid_skill', 'A skill needs its instructions.');
    if (body.length > MAX_SKILL_CHARS) throw new SkillError('skill_too_long', `A skill can be up to ${MAX_SKILL_CHARS.toLocaleString('en-US')} characters.`);
    if (input.files === undefined) return { name, description, body };
    if (!Array.isArray(input.files) || input.files.length > MAX_SKILL_FILES) throw new SkillError('invalid_skill_files', `A skill can hold up to ${MAX_SKILL_FILES} files.`);
    const seen = new Set();
    let total = 0;
    const files = input.files.map((file) => {
      const rel = String(file && file.path || '').trim();
      const text = String(file && file.body || '').replace(/\r\n/g, '\n');
      if (!FILE_PATH.test(rel) || rel.toUpperCase() === SKILL_FILE.toUpperCase() || rel.split('/').some((part) => part.startsWith('.') || WINDOWS_DEVICE.test(part))) {
        throw new SkillError('invalid_skill_file', `"${rel || 'A file'}" isn't a file name a skill can hold. Use letters, numbers, dots, dashes and folders.`);
      }
      if (seen.has(rel.toLowerCase())) throw new SkillError('invalid_skill_file', `"${rel}" is in this skill twice.`);
      seen.add(rel.toLowerCase());
      if (text.length > MAX_FILE_CHARS) throw new SkillError('skill_file_too_long', `"${rel}" is too long for a skill file.`);
      total += text.length;
      return { path: rel, body: text };
    });
    if (total > MAX_FOLDER_CHARS) throw new SkillError('skill_too_long', 'This skill\'s files are too big together.');
    return { name, description, body, files };
  }

  function write(id, skill) {
    const directory = directoryOf(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, SKILL_FILE);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const contents = `---\n${YAML.stringify({ name: skill.name, description: skill.description }).trim()}\n---\n\n${skill.body}\n`;
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
    if (skill.files) writeFiles(id, directory, skill.files);
    return read(id);
  }

  // The folder then holds exactly these files; any other moves aside to
  // .removed, so nothing is lost.
  function writeFiles(id, directory, files) {
    const keep = new Set(files.map((file) => file.path));
    for (const old of listFiles(directory)) {
      if (keep.has(old.path)) continue;
      const removed = path.join(root(), '.removed', `${id}-${Date.now()}`, path.dirname(old.path));
      fs.mkdirSync(removed, { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(directory, old.path), path.join(removed, path.basename(old.path)));
    }
    for (const file of files) {
      const target = path.join(directory, file.path);
      if (path.relative(directory, target).startsWith('..')) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      let existing = null;
      try { existing = fs.lstatSync(target); } catch (_) { /* new file */ }
      if (existing && !existing.isFile()) throw new SkillError('unsafe_skill_folder', `"${file.path}" can't be written in this skill.`, 500);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      // Scripts stay runnable, like a skill folder made by hand.
      fs.writeFileSync(temporary, file.body, { encoding: 'utf8', mode: /\.(py|sh|js|mjs)$/i.test(file.path) ? 0o700 : 0o600 });
      fs.renameSync(temporary, target);
    }
  }

  function create(input) {
    const skill = clean(input);
    const base = skillSlug(skill.name);
    let id = base;
    for (let suffix = 2; fs.existsSync(directoryOf(id)); suffix += 1) id = `${base}-${suffix}`;
    return write(id, skill);
  }

  function update(id, input) {
    if (!read(id)) throw new SkillError('skill_not_found', 'That skill is no longer in the library.', 404);
    return write(id, clean(input));
  }

  // A removed skill moves aside rather than disappearing, so it can be recovered.
  function remove(id) {
    if (!read(id)) throw new SkillError('skill_not_found', 'That skill is no longer in the library.', 404);
    const removed = path.join(root(), '.removed');
    fs.mkdirSync(removed, { recursive: true, mode: 0o700 });
    fs.renameSync(directoryOf(id), path.join(removed, `${id}-${Date.now()}`));
  }

  // The skills for a bot's prompt and for sharing it: SKILL.md's text, the
  // folder on this computer, and each other file with its text.
  function bundle(ids) {
    return (Array.isArray(ids) ? ids : []).map(read).filter(Boolean).map(withFileText)
      .map(({ id, name, description, body, files, folder }) => ({ id, name, description, body, files, folder }));
  }

  // Makes <bot folder>/skills hold exactly one link per skill the bot carries.
  // Links are relative so renaming a bot or moving the data folder keeps them
  // working; Windows needs a junction, which takes an absolute path.
  function linkIntoBot(botDirectory, ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => read(id)));
    const folder = path.join(botDirectory, 'skills');
    if (!wanted.size && !fs.existsSync(folder)) return;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!isRealDirectory(folder)) throw new SkillError('unsafe_bot_folder', 'The bot folder has an unexpected skills link.', 500);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() && !wanted.has(entry.name)) fs.unlinkSync(path.join(folder, entry.name));
    }
    for (const id of wanted) {
      const link = path.join(folder, id);
      const target = directoryOf(id);
      let existing = null;
      try { existing = fs.lstatSync(link); } catch (_) { /* not linked yet */ }
      if (existing && !existing.isSymbolicLink()) continue;
      if (existing) {
        if (path.resolve(folder, fs.readlinkSync(link)) === target) continue;
        fs.unlinkSync(link);
      }
      if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction');
      else fs.symlinkSync(path.relative(folder, target), link);
    }
  }

  return { root, list, read, readFile, withFileText, create, update, remove, bundle, linkIntoBot };
}

const defaultLibrary = createSkillsLibrary(() => defaultSkillsRoot());

module.exports = {
  MAX_BOT_SKILLS,
  MAX_SKILL_CHARS,
  MAX_SKILL_FILES,
  SkillError,
  createSkillsLibrary,
  defaultLibrary,
  defaultSkillsRoot,
  parseSkillFile,
  skillSlug,
};
