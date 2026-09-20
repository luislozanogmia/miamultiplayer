import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';

const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);
const CATALOG_DIR = path.join(BACKEND_DIR, '..', 'bots-catalog');

test('the seed catalog on disk has a valid index and matching manifests', () => {
  const index = JSON.parse(readFileSync(path.join(CATALOG_DIR, 'catalog.json'), 'utf8'));
  assert.equal(index.catalogVersion, 1);
  assert.ok(Array.isArray(index.bots) && index.bots.length >= 3);
  for (const entry of index.bots) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.version, 'string');
    assert.equal(typeof entry.category, 'string');
    assert.equal(entry.manifest, `bots/${entry.id}.json`);
    const manifestPath = path.join(CATALOG_DIR, entry.manifest);
    assert.ok(existsSync(manifestPath), `${manifestPath} exists`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.version, entry.version);
    assert.equal(manifest.author, 'Mia Labs');
    assert.equal(typeof manifest.store.tagline, 'string');
    assert.ok(manifest.store.tagline.length > 0);
    assert.equal(typeof manifest.store.category, 'string');
    assert.match(manifest.store.avatarColor, /^#[0-9a-fA-F]{6}$/);
    assert.ok(Array.isArray(manifest.store.requires.connectors));
    assert.equal(typeof manifest.store.requires.minAppVersion, 'string');
    assert.equal(typeof manifest.bot.name, 'string');
    assert.ok(manifest.bot.instructions.length > 40, 'instructions are real, not one-liners');
    assert.ok(Array.isArray(manifest.bot.departments));
    assert.ok(Array.isArray(manifest.bot.automations));
    for (const automation of manifest.bot.automations) {
      assert.equal(typeof automation.name, 'string');
      // The server's automation schema, not cron strings — POST /api/bots
      // rejects anything else, and the HTTP test below installs for real.
      assert.equal(typeof automation.enabled, 'boolean');
      assert.ok(['none', 'interval', 'daily', 'weekly', 'monthly'].includes(automation.frequency));
      assert.equal(typeof automation.prompt, 'string');
    }
    assert.equal(typeof manifest.welcome, 'string');
    assert.ok(manifest.welcome.includes(manifest.bot.name));
  }
});

test('server registers the fixed catalog routes ahead of the generic bots resource', () => {
  const source = readFileSync(path.join(BACKEND_DIR, 'server.js'), 'utf8');
  const catalogIndexRoute = source.indexOf("app.get('/api/bots/catalog', requireAuth");
  const catalogIdRoute = source.indexOf("app.get('/api/bots/catalog/:id', requireAuth");
  const resourceRegistration = source.indexOf("registerResource({\n  path: 'bots',");
  assert.ok(catalogIndexRoute >= 0, 'catalog index route is registered');
  assert.ok(catalogIdRoute >= 0, 'catalog manifest route is registered');
  assert.ok(resourceRegistration >= 0, 'generic bots resource is registered');
  assert.ok(catalogIndexRoute < resourceRegistration, 'catalog index route precedes the generic :id resource');
  assert.ok(catalogIdRoute < resourceRegistration, 'catalog manifest route precedes the generic :id resource');
  assert.match(source, /BOT_CATALOG_ID_RE = \/\^\[a-z0-9-\]\+\$\//);
});

test('local HTTP catalog endpoints serve the index and manifests, 404 on invalid or unknown ids', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-bots-catalog-test-'));
  await mkdir(path.join(root, 'hermes'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: path.join(root, 'mia.db'),
      DATA_DIR: root,
      MIAOS_ENV_FILE: path.join(root, 'missing.env'),
      HERMES_HOME: path.join(root, 'hermes'),
      MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'),
      MIAOS_NO_AUTH: '1',
      MIAOS_LOCAL_PROFILE: '1',
      MIAOS_CLERK_AUTH: '0',
      HERMES_BIN: '/usr/bin/false',
      MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(root, 'artifacts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    try { ready = (await fetch(`${origin}/healthz`)).ok; } catch (_error) { /* still starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `local server starts: ${logs}`);

  const indexRes = await fetch(`${origin}/api/bots/catalog`);
  assert.equal(indexRes.status, 200);
  const index = await indexRes.json();
  assert.equal(index.catalogVersion, 1);
  assert.ok(index.bots.some((entry) => entry.id === 'inbox-triage'));

  const manifestRes = await fetch(`${origin}/api/bots/catalog/inbox-triage`);
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.id, 'inbox-triage');
  assert.equal(manifest.bot.name, 'Inbox Triage');
  assert.equal(typeof manifest.welcome, 'string');

  const missingRes = await fetch(`${origin}/api/bots/catalog/does-not-exist`);
  assert.equal(missingRes.status, 404);

  for (const badId of ['../catalog', 'inbox_triage', 'Inbox-Triage', 'inbox%2Ftriage', 'inbox.triage']) {
    const res = await fetch(`${origin}/api/bots/catalog/${encodeURIComponent(badId)}`);
    assert.equal(res.status, 404, `rejects ${badId}`);
  }

  // Every catalog manifest's bot object must be installable through the real
  // create endpoint — the store has no schema of its own, POST /api/bots is
  // the contract (this is what catches an automation shape the server rejects).
  for (const entry of index.bots) {
    const entryManifest = await (await fetch(`${origin}/api/bots/catalog/${entry.id}`)).json();
    const createRes = await fetch(`${origin}/api/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(entryManifest.bot),
    });
    const created = await createRes.json();
    assert.equal(createRes.status, 201, `installs ${entry.id}: ${JSON.stringify(created)}`);
    assert.equal(created.bot.name, entryManifest.bot.name);
  }
});
