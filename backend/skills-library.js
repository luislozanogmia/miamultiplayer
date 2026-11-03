'use strict';

// The skills library: one folder per skill, <data>/skills/<id>/SKILL.md, in
// the same format Hermes and Claude use. A bot carries skills by listing their
// ids; its folder gets a link to each one (<bot>/skills/<id>), so editing a
// skill in the library changes it for every bot that carries it. Sharing a bot
// copies the text of its skills, because the team has no access to this folder.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const MAX_BOT_SKILLS = 10;
const MAX_SKILL_CHARS = 20000;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 500;
const SKILL_FILE = 'SKILL.md';
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
      updatedAt: stat.mtime.toISOString(),
    };
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
    return { name, description, body };
  }

  function write(id, skill) {
    const directory = directoryOf(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, SKILL_FILE);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const contents = `---\n${YAML.stringify({ name: skill.name, description: skill.description }).trim()}\n---\n\n${skill.body}\n`;
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
    return read(id);
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

  // The skills' text, for a bot's prompt and for sharing it.
  function bundle(ids) {
    return (Array.isArray(ids) ? ids : []).map(read).filter(Boolean)
      .map(({ id, name, description, body }) => ({ id, name, description, body }));
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

  return { root, list, read, create, update, remove, bundle, linkIntoBot };
}

const defaultLibrary = createSkillsLibrary(() => defaultSkillsRoot());

module.exports = {
  MAX_BOT_SKILLS,
  MAX_SKILL_CHARS,
  SkillError,
  createSkillsLibrary,
  defaultLibrary,
  defaultSkillsRoot,
  parseSkillFile,
  skillSlug,
};
