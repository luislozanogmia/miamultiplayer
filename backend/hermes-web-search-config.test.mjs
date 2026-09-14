import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { provisionHermesWebSearchConfig } = require('./hermes-web-search-config');

test('Mia provisions its gateway URL and installation credential for Hermes cron', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-web-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, [
    'KEEP_ME=present',
    'FIRECRAWL_API_URL=https://stale.example.com',
    'FIRECRAWL_API_KEY=op://vault/stale/key',
    '',
  ].join('\n'), { mode: 0o600 });

  const result = provisionHermesWebSearchConfig({
    envPath,
    gatewayUrl: 'https://search.os.example.com/',
    gatewayToken: 'miaos-installation-token-with-enough-entropy',
  });

  assert.equal(result.changed, true);
  assert.equal(result.configured, true);
  const saved = fs.readFileSync(envPath, 'utf8');
  assert.match(saved, /^KEEP_ME=present$/m);
  assert.match(saved, /^FIRECRAWL_API_URL=https:\/\/search\.os\.example\.com$/m);
  assert.match(saved, /^FIRECRAWL_API_KEY=miaos-installation-token-with-enough-entropy$/m);
  assert.doesNotMatch(saved, /stale\.example|op:\/\//);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);

  const unchanged = provisionHermesWebSearchConfig({
    envPath,
    gatewayUrl: 'https://search.os.example.com',
    gatewayToken: 'miaos-installation-token-with-enough-entropy',
  });
  assert.equal(unchanged.changed, false);
});

test('Mia does not modify Hermes config when installation auth is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-web-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'KEEP_ME=present\n', { mode: 0o600 });

  const result = provisionHermesWebSearchConfig({
    envPath,
    gatewayUrl: 'https://search.os.example.com',
    gatewayToken: '',
  });

  assert.deepEqual(result, { configured: false, changed: false });
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'KEEP_ME=present\n');
});

test('incomplete Mia auth preserves an unmanaged Hermes search configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-web-unmanaged-'));
  const envPath = path.join(root, '.env');
  const original = [
    'FIRECRAWL_API_URL=https://user-managed.example.com',
    'FIRECRAWL_API_KEY=user-managed-token-that-is-long-enough',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, original, { mode: 0o600 });

  const result = provisionHermesWebSearchConfig({
    envPath,
    gatewayUrl: 'https://search.os.example.com',
    gatewayToken: '',
  });

  assert.deepEqual(result, { configured: false, changed: false });
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
});

test('incomplete installation auth removes stale Mia-managed search credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-web-stale-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, [
    'KEEP_ME=present',
    '# Managed by Mia: installation-scoped hosted web-search gateway.',
    'FIRECRAWL_API_URL=https://stale.example.com',
    'FIRECRAWL_API_KEY=stale-installation-token-that-is-long-enough',
    '',
  ].join('\n'), { mode: 0o600 });

  const result = provisionHermesWebSearchConfig({
    envPath,
    gatewayUrl: 'https://search.os.example.com',
    gatewayToken: '',
  });

  assert.deepEqual(result, { configured: false, changed: true });
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'KEEP_ME=present\n');
});

test('default web-search config follows HERMES_HOME instead of the macOS account home', () => {
  const previous = process.env.HERMES_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-web-home-'));
  process.env.HERMES_HOME = root;
  try {
    const result = provisionHermesWebSearchConfig({
      gatewayUrl: 'https://search.os.example.com',
      gatewayToken: 'miaos-installation-token-with-enough-entropy',
    });
    assert.equal(result.configured, true);
    assert.equal(fs.existsSync(path.join(root, '.env')), true);
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
  }
});
