import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const YAML = require('yaml');
const dbStore = require('./db.js');
const inference = require('./inference.js');
const { createBotPackageStore } = require('./bot-packages.js');

function tempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bot-packages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dbPath: path.join(root, 'mia.sqlite'),
    dataDir: path.join(root, 'legacy-data'),
    packages: path.join(root, 'bots'),
  };
}

function record(overrides = {}) {
  return {
    id: 'bot-alpha',
    name: 'Alpha / Research',
    owner: 'owner@example.com',
    workspaceId: 'solo',
    instructions: '# Purpose\n\n- Keep this formatting.\n',
    model: 'claude-sonnet-4-5',
    status: 'running',
    automations: [{
      id: 'daily', name: 'Daily', enabled: true, frequency: 'daily', time: '09:00',
      prompt: 'Prepare the brief.', hermesCronJobId: 'secret-live-job', deliveryConversationId: 'conv-private',
    }],
    apiKey: 'never-package-this',
    ...overrides,
  };
}

function onlyPackage(root) {
  const entries = fs.readdirSync(root).filter((name) => !name.startsWith('.'));
  assert.equal(entries.length, 1);
  return path.join(root, entries[0]);
}

test('legacy migration is lossless, portable, retry-safe, and keeps live schedules in SQLite', (t) => {
  const fixture = tempFixture(t);
  fs.mkdirSync(fixture.dataDir);
  let db = dbStore.openDb(fixture.dbPath, fixture.dataDir);
  dbStore.insertOne(db, 'bots', 'bot-alpha', record());
  db.close();

  db = dbStore.openDb(fixture.dbPath, fixture.dataDir, { botPackageDir: fixture.packages });
  const directory = onlyPackage(fixture.packages);
  assert.equal(fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8'), record().instructions);
  const manifest = YAML.parse(fs.readFileSync(path.join(directory, 'bot.yaml'), 'utf8'));
  assert.deepEqual(manifest.requiredCapabilities, []);
  assert.equal(manifest.packageVersion, 1);
  assert.equal(manifest.status, undefined);
  assert.equal(manifest.apiKey, undefined);
  const templates = YAML.parse(fs.readFileSync(path.join(directory, 'automations.yaml'), 'utf8'));
  assert.equal(templates.templates[0].enabled, false);
  assert.equal(templates.templates[0].hermesCronJobId, undefined);
  assert.equal(templates.templates[0].deliveryConversationId, undefined);
  assert.equal(dbStore.loadOne(db, 'bots', 'bot-alpha').automations[0].enabled, true);
  db.close();

  fs.writeFileSync(path.join(directory, 'AGENTS.md'), '# Direct edit\n\nKeep me.\n');
  const raw = new Database(fixture.dbPath);
  raw.prepare("DELETE FROM meta WHERE key = 'bot_packages_v1'").run();
  raw.prepare('INSERT INTO bots (id, json) VALUES (?, ?)').run('bot-beta', JSON.stringify(record({ id: 'bot-beta', name: 'Beta', instructions: '', role: 'Legacy role fallback.\n' })));
  raw.close();

  db = dbStore.openDb(fixture.dbPath, fixture.dataDir, { botPackageDir: fixture.packages });
  assert.equal(dbStore.loadOne(db, 'bots', 'bot-alpha').instructions, '# Direct edit\n\nKeep me.\n');
  assert.equal(dbStore.loadOne(db, 'bots', 'bot-beta').instructions, 'Legacy role fallback.\n');
  db.close();
});

test('manual and scheduled prompts read the same externally edited AGENTS.md without collapsing Markdown', (t) => {
  const fixture = tempFixture(t);
  fs.mkdirSync(fixture.dataDir);
  const db = dbStore.openDb(fixture.dbPath, fixture.dataDir, { botPackageDir: fixture.packages });
  dbStore.insertOne(db, 'bots', 'bot-alpha', record());
  const directory = onlyPackage(fixture.packages);
  const edited = '# Operating guide\n\n1. First line\n2. Second line\n';
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), edited);

  const bot = dbStore.loadOne(db, 'bots', 'bot-alpha');
  assert.equal(bot.instructions, edited);
  const manual = inference.buildBotContext(bot, [], '', '', 'Luis', '');
  const scheduled = inference.buildScheduledBotPrompt(bot, bot.automations[0], { userDisplayName: 'Luis' });
  for (const prompt of [manual, scheduled]) assert.match(prompt, /Purpose:\n# Operating guide\n\n1\. First line\n2\. Second line/);

  const delayed = { ...bot, hermesCronJobId: 'updated-job-id' };
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), '# Newer external edit\n');
  dbStore.saveOne(db, 'bots', delayed.id, delayed);
  assert.equal(dbStore.loadOne(db, 'bots', delayed.id).instructions, '# Newer external edit\n');
  db.close();
});

test('rename preserves unmanaged files and assets while revision guard rejects stale instruction edits', (t) => {
  const fixture = tempFixture(t);
  const store = createBotPackageStore(fixture.packages);
  const initial = record();
  const create = store.prepare(initial, { writeInstructions: true });
  create.apply(); create.finish();
  const oldDirectory = store.findDirectory(initial.id);
  fs.writeFileSync(path.join(oldDirectory, 'NOTES.md'), 'user notes');
  fs.writeFileSync(path.join(oldDirectory, 'assets', 'logo.txt'), 'asset');
  const current = store.hydrate(initial);

  const rename = store.prepare({ ...current, name: 'Renamed Bot' });
  rename.apply(); rename.finish();
  const nextDirectory = store.findDirectory(initial.id);
  assert.notEqual(nextDirectory, oldDirectory);
  assert.equal(fs.readFileSync(path.join(nextDirectory, 'NOTES.md'), 'utf8'), 'user notes');
  assert.equal(fs.readFileSync(path.join(nextDirectory, 'assets', 'logo.txt'), 'utf8'), 'asset');

  fs.writeFileSync(path.join(nextDirectory, 'AGENTS.md'), '# Outside edit\n');
  assert.throws(() => store.prepare({ ...current, name: 'Renamed Bot', instructions: '# Editor edit\n' }, {
    writeInstructions: true,
    instructions: '# Editor edit\n',
    expectedRevision: current.instructionsRevision,
  }), (error) => error.code === 'INSTRUCTIONS_CONFLICT' && error.statusCode === 409);

  const latest = store.hydrate(initial);
  const delayed = store.prepare({ ...latest, instructions: '# Intended edit\n' }, {
    writeInstructions: true,
    instructions: '# Intended edit\n',
    expectedRevision: latest.instructionsRevision,
  });
  fs.writeFileSync(path.join(nextDirectory, 'AGENTS.md'), '# Edit during await\n');
  assert.throws(() => delayed.apply(), (error) => error.code === 'INSTRUCTIONS_CONFLICT');
  assert.equal(fs.readFileSync(path.join(nextDirectory, 'AGENTS.md'), 'utf8'), '# Edit during await\n');
});

test('package installation rolls back on a mid-swap filesystem failure and a later SQL failure', (t) => {
  const fixture = tempFixture(t);
  const store = createBotPackageStore(fixture.packages);
  const original = record();
  let change = store.prepare(original, { writeInstructions: true });
  change.apply(); change.finish();
  const directory = store.findDirectory(original.id);
  const before = Object.fromEntries(['bot.yaml', 'AGENTS.md', 'automations.yaml'].map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));

  change = store.prepare({ ...original, name: 'Changed', instructions: '# Changed\n' }, { writeInstructions: true, instructions: '# Changed\n' });
  const realRename = fs.renameSync;
  fs.renameSync = function(source, target) {
    if (String(source).includes('.staging-') && path.basename(source) === 'AGENTS.md') throw new Error('injected rename failure');
    return realRename.call(fs, source, target);
  };
  try {
    assert.throws(() => change.apply(), /could not install bot package/);
  } finally {
    fs.renameSync = realRename;
  }
  const restored = store.findDirectory(original.id);
  for (const [name, contents] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(restored, name), 'utf8'), contents);

  fs.mkdirSync(fixture.dataDir);
  const db = dbStore.openDb(fixture.dbPath, fixture.dataDir, { botPackageDir: path.join(fixture.root, 'db-bots') });
  dbStore.insertOne(db, 'bots', original.id, original);
  assert.throws(() => dbStore.insertOne(db, 'bots', original.id, { ...original, instructions: '# Should roll back\n' }), /UNIQUE constraint failed/);
  assert.equal(dbStore.loadOne(db, 'bots', original.id).instructions, original.instructions);
  db.close();
});

test('unsafe paths, duplicate package identities, corrupt packages, and deleted packages fail closed', (t) => {
  const fixture = tempFixture(t);
  const store = createBotPackageStore(fixture.packages);
  assert.throws(() => store.prepare(record({ id: '../escape' }), { writeInstructions: true }), (error) => error.code === 'INVALID_BOT_ID');

  let change = store.prepare(record(), { writeInstructions: true });
  change.apply(); change.finish();
  const directory = store.findDirectory('bot-alpha');
  fs.mkdirSync(path.join(fixture.packages, 'duplicate--bot-alpha'));
  assert.throws(() => store.findDirectory('bot-alpha'), (error) => error.code === 'PACKAGE_COLLISION');
  fs.rmSync(path.join(fixture.packages, 'duplicate--bot-alpha'), { recursive: true });

  fs.unlinkSync(path.join(directory, 'AGENTS.md'));
  fs.symlinkSync(path.join(fixture.root, 'outside.md'), path.join(directory, 'AGENTS.md'));
  assert.throws(() => store.hydrate(record()), (error) => error.code === 'PACKAGE_UNREADABLE');
  fs.unlinkSync(path.join(directory, 'AGENTS.md'));
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), record().instructions);

  change = store.prepareDelete('bot-alpha');
  change.apply(); change.finish();
  assert.equal(store.findDirectory('bot-alpha'), null);
  assert.equal(fs.readdirSync(path.join(fixture.packages, '.trash')).length, 1);
  assert.throws(() => store.hydrate(record()), (error) => error.code === 'PACKAGE_MISSING');

  const outsideDirectory = path.join(fixture.root, 'outside-package');
  fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory, path.join(fixture.packages, 'linked--bot-linked'));
  assert.throws(() => store.prepareDelete('bot-linked'), (error) => error.code === 'UNSAFE_PACKAGE_ENTRY');
});

test('an outer SQLite rollback retains both the bot row and its package', (t) => {
  const fixture = tempFixture(t);
  fs.mkdirSync(fixture.dataDir);
  const db = dbStore.openDb(fixture.dbPath, fixture.dataDir, { botPackageDir: fixture.packages });
  dbStore.insertOne(db, 'bots', 'bot-alpha', record());
  const directory = onlyPackage(fixture.packages);

  const transaction = db.transaction(() => {
    assert.equal(dbStore.deleteOne(db, 'bots', 'bot-alpha'), true);
    throw new Error('force outer rollback');
  });
  assert.throws(transaction, /force outer rollback/);
  assert.equal(dbStore.loadOne(db, 'bots', 'bot-alpha').id, 'bot-alpha');
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(path.join(fixture.packages, '.trash')), false);
  db.close();
});

test('HTTP bot create/read/edit enforces revisions and rename preserves direct file edits', async (t) => {
  const fixture = tempFixture(t);
  fs.mkdirSync(fixture.dataDir);
  fs.mkdirSync(path.join(fixture.root, 'hermes'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: fixture.dbPath, DATA_DIR: fixture.dataDir,
      MIAOS_BOT_PACKAGE_DIR: fixture.packages,
      MIAOS_ENV_FILE: path.join(fixture.root, 'missing.env'),
      HERMES_HOME: path.join(fixture.root, 'hermes'),
      MIAOS_WORKSPACE_DIR: path.join(fixture.root, 'workspace'),
      MIAOS_NO_AUTH: '1', MIAOS_LOCAL_PROFILE: '1', MIAOS_CLERK_AUTH: '0',
      GOOGLE_REDIRECT_URI: `${origin}/api/connections/google/callback`,
      HERMES_BIN: '/usr/bin/false', MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(fixture.root, 'artifacts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  let ready = false;
  for (let index = 0; index < 100; index += 1) {
    try { ready = (await fetch(`${origin}/healthz`)).ok; } catch (_) { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, logs);
  const request = (url, options = {}) => fetch(`${origin}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(options.headers || {}) },
  });
  const createdResponse = await request('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name: 'HTTP Bot', instructions: '# Initial\n', model: 'claude-sonnet-4-5', automations: [] }),
  });
  const created = (await createdResponse.json()).bot;
  assert.equal(createdResponse.status, 201);
  const initial = (await (await request(`/api/bots/${created.id}`)).json()).bot;
  assert.match(initial.instructionsRevision, /^[a-f0-9]{64}$/);

  const directory = fs.readdirSync(fixture.packages).filter((name) => name.endsWith(`--${created.id}`))[0];
  const agentsPath = path.join(fixture.packages, directory, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# Direct HTTP fixture edit\n');
  let response = await request(`/api/bots/${created.id}`, {
    method: 'PUT', body: JSON.stringify({ instructions: '# Missing revision\n', name: created.name, model: created.model }),
  });
  assert.equal(response.status, 409);
  response = await request(`/api/bots/${created.id}`, {
    method: 'PUT', body: JSON.stringify({ instructions: '# Stale revision\n', expectedInstructionsRevision: initial.instructionsRevision, name: created.name, model: created.model }),
  });
  assert.equal(response.status, 409);
  const refreshed = (await (await request(`/api/bots/${created.id}`)).json()).bot;
  response = await request(`/api/bots/${created.id}`, {
    method: 'PUT', body: JSON.stringify({ instructions: '# Saved edit\n', expectedInstructionsRevision: refreshed.instructionsRevision, name: created.name, model: created.model }),
  });
  const saved = (await response.json()).bot;
  assert.equal(response.status, 200);
  assert.notEqual(saved.instructionsRevision, refreshed.instructionsRevision);

  fs.writeFileSync(agentsPath, '# Preserve across rename\n');
  response = await request(`/api/bots/${created.id}`, {
    method: 'PUT', body: JSON.stringify({ name: 'Renamed over HTTP', model: created.model }),
  });
  const renamed = (await response.json()).bot;
  assert.equal(response.status, 200);
  assert.equal(renamed.instructions, '# Preserve across rename\n');
  const renamedDirectory = fs.readdirSync(fixture.packages).find((name) => name.endsWith(`--${created.id}`));
  assert.match(renamedDirectory, /^renamed-over-http--/);
  assert.equal(fs.readFileSync(path.join(fixture.packages, renamedDirectory, 'AGENTS.md'), 'utf8'), '# Preserve across rename\n');
});
