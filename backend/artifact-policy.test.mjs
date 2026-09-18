import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('./artifact-policy.js');

function descriptor(filename, mimeType, bytes, workspace) {
  return {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    filePath: path.join(workspace, filename),
  };
}

test('artifact policy accepts every supported native extension with an exact MIME', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-artifact-policy-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const formats = [
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['model.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['preview.pdf', 'application/pdf'],
    ['page.html', 'text/html'],
    ['photo.png', 'image/png'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.webp', 'image/webp'],
    ['animation.gif', 'image/gif'],
    ['drawing.svg', 'image/svg+xml'],
    ['rows.csv', 'text/csv'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain'],
    ['readme.md', 'text/markdown'],
    ['bundle.zip', 'application/zip'],
  ];

  for (const [filename, mimeType] of formats) {
    const bytes = Buffer.from(`fixture:${filename}`);
    fs.writeFileSync(path.join(workspace, filename), bytes, { mode: 0o600 });
    const validated = policy.validatedArtifactFile({
      workspace,
      descriptor: descriptor(filename, mimeType, bytes, workspace),
    });
    assert.equal(validated.filename, filename);
    assert.equal(validated.mimeType, mimeType);
    assert.deepEqual(validated.bytes, bytes);
  }
});

test('artifact validation fails closed on MIME, path, integrity, and size violations', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-artifact-policy-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const bytes = Buffer.from('<h1>safe</h1>');
  const valid = descriptor('page.html', 'text/html', bytes, workspace);
  fs.writeFileSync(path.join(workspace, valid.filename), bytes, { mode: 0o600 });

  assert.ok(policy.validatedArtifactFile({ workspace, descriptor: valid }));
  assert.equal(policy.validatedArtifactFile({
    workspace,
    descriptor: { ...valid, mimeType: 'application/zip' },
  }), null);
  assert.equal(policy.validatedArtifactFile({
    workspace,
    descriptor: { ...valid, filePath: path.join(workspace, '..', valid.filename) },
  }), null);
  assert.equal(policy.validatedArtifactFile({
    workspace,
    descriptor: { ...valid, sha256: '0'.repeat(64) },
  }), null);
  assert.equal(policy.validatedArtifactFile({
    workspace,
    descriptor: { ...valid, sizeBytes: policy.ARTIFACT_MAX_BYTES + 1 },
  }), null);

  assert.equal(policy.isSafeArtifactFilename('../page.html'), false);
  assert.equal(policy.isSafeArtifactFilename('.hidden.html'), false);
  assert.equal(policy.isSafeArtifactFilename('bad\u202Egpj.exe'), false);
  assert.equal(policy.mimeTypeMatchesFilename('page.html', 'application/zip'), false);
});

test('Office files require a safe derivative for preview and active previews are sandboxed', () => {
  assert.equal(policy.isSafePreviewMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'), false);
  assert.equal(policy.isSafeDerivativePreviewMime('application/pdf'), true);
  assert.equal(policy.isSafeDerivativePreviewMime('text/html'), true);
  assert.match(policy.previewContentSecurityPolicy('text/html'), /sandbox/);
  assert.match(policy.previewContentSecurityPolicy('image/svg+xml'), /default-src 'none'/);
});
