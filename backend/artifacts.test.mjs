import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const artifacts = require('./artifacts.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mia-artifacts-'));
}

test('lists pages, documents and images in the Mia folder, newest first, with the bot that made them', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'bots', 'finance'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'old.pdf'), 'pdf');
  fs.writeFileSync(path.join(root, 'bots', 'finance', 'report.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'skip');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.html'), 'skip');
  fs.writeFileSync(path.join(root, '.hidden', 'a.html'), 'skip');
  fs.symlinkSync(path.join(root, 'old.pdf'), path.join(root, 'link.pdf'));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, 'old.pdf'), past, past);

  const files = artifacts.listArtifactFiles(root);
  assert.deepEqual(files.map(file => file.name), ['report.html', 'old.pdf']);
  assert.equal(files[0].kind, 'page');
  assert.equal(files[0].from, 'finance');
  assert.equal(files[0].folder, 'bots/finance');
  assert.equal(files[1].kind, 'document');
  assert.equal(files[1].from, '');
});

test('a missing Mia folder lists nothing', () => {
  assert.deepEqual(artifacts.listArtifactFiles(path.join(tempDir(), 'missing')), []);
});

test('live apps accept only plain http and https addresses', () => {
  assert.equal(artifacts.normalizeLinkUrl('http://localhost:3000'), 'http://localhost:3000/');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com', 'not a url', '']) {
    assert.equal(artifacts.normalizeLinkUrl(bad), null, bad);
  }
});

test('live apps are saved per workspace, can be removed, and are checked when local', async () => {
  const data = tempDir();
  const local = artifacts.addLink(data, 'solo', { url: 'http://localhost:3000', name: 'Sales dashboard' });
  const web = artifacts.addLink(data, 'solo', { url: 'https://example.com/app' });
  assert.equal(local.local, true);
  assert.equal(web.local, false);
  assert.equal(web.name, 'example.com');
  assert.throws(() => artifacts.addLink(data, 'solo', { url: 'file:///tmp/x' }), /http or https/);

  const probed = [];
  const listed = await artifacts.listArtifacts({ workspaceDir: tempDir(), dataDir: data, workspaceId: 'solo', probe: async url => { probed.push(url); return true; } });
  assert.deepEqual(listed.artifacts.map(item => [item.name, item.type, item.running]), [
    ['example.com', 'Web app', null],
    ['Sales dashboard', 'Localhost', true],
  ]);
  assert.deepEqual(probed, ['http://localhost:3000/']);

  assert.equal(artifacts.removeLink(data, 'solo', local.id), true);
  assert.equal(artifacts.removeLink(data, 'solo', local.id), false);
  assert.deepEqual(artifacts.readLinks(data, 'solo').map(link => link.id), [web.id]);
});

test('a local address that does not answer is not running', async () => {
  assert.equal(await artifacts.probeLink('http://127.0.0.1:9/', 300), false);
});

test('reads a listed file for attaching, and refuses anything the listing would not show', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'bots', 'finance'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'bots', 'finance', 'report.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'skip');
  fs.writeFileSync(path.join(root, '.hidden', 'a.html'), 'skip');
  fs.symlinkSync(path.join(root, 'bots', 'finance', 'report.pdf'), path.join(root, 'link.pdf'));
  const outside = path.join(tempDir(), 'secret.pdf');
  fs.writeFileSync(outside, 'secret');

  const id = artifacts.listArtifactFiles(root)[0].id;
  assert.deepEqual(artifacts.readArtifactFile(root, id), {
    filename: 'report.pdf', mimeType: 'application/pdf', size: 8, contentBase64: Buffer.from('%PDF-1.4').toString('base64'),
  });
  for (const bad of ['file:notes.txt', 'file:.hidden/a.html', 'file:link.pdf', 'file:missing.pdf',
    `file:${path.relative(root, outside)}`, `file:${outside}`, 'report.pdf', '', null]) {
    assert.throws(() => artifacts.readArtifactFile(root, bad), error => error.status === 400 || error.status === 404, String(bad));
  }
});

test('deleting a listed file moves it to the Trash with a free name, and refuses anything else', () => {
  const root = tempDir();
  const home = tempDir();
  fs.mkdirSync(path.join(home, '.Trash'));
  fs.writeFileSync(path.join(home, '.Trash', 'report.html'), 'older');
  fs.writeFileSync(path.join(root, 'report.html'), 'newer');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not listed');
  artifacts.trashArtifactFile(root, 'file:report.html', { platform: 'darwin', home });
  assert.equal(fs.existsSync(path.join(root, 'report.html')), false);
  assert.equal(fs.readFileSync(path.join(home, '.Trash', 'report 2.html'), 'utf8'), 'newer');
  assert.equal(fs.readFileSync(path.join(home, '.Trash', 'report.html'), 'utf8'), 'older');
  for (const bad of ['file:notes.txt', 'file:../x.html', 'file:report.html', 'link:abc']) {
    assert.throws(() => artifacts.trashArtifactFile(root, bad, { platform: 'darwin', home }), error => error.status === 400 || error.status === 404, bad);
  }
  assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
});

test('on Windows the file goes to the Recycle Bin through PowerShell, and on Linux to the freedesktop Trash', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.pdf'), 'x');
  const seen = [];
  artifacts.trashArtifactFile(root, 'file:a.pdf', { platform: 'win32', runPowerShell: full => seen.push(full) });
  assert.deepEqual(seen, [fs.realpathSync(path.join(root, 'a.pdf'))]);
  const home = tempDir();
  const previous = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    artifacts.trashArtifactFile(root, 'file:a.pdf', { platform: 'linux', home });
  } finally { if (previous !== undefined) process.env.XDG_DATA_HOME = previous; }
  assert.equal(fs.readFileSync(path.join(home, '.local/share/Trash/files/a.pdf'), 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(home, '.local/share/Trash/info/a.pdf.trashinfo'), 'utf8'), /^\[Trash Info\]\nPath=.*a\.pdf\nDeletionDate=/);
});
