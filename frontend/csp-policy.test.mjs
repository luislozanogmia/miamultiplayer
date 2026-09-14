import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync as fileExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CSP_DIRECTIVES,
  MIAOS_PAGE_CSP,
  REQUIRED_LOCAL_ASSETS,
  assertRequiredLocalAssets,
} from './csp-policy.mjs';

const htmlUrl = new URL('./index.html', import.meta.url);
const assetsRoot = new URL('./', import.meta.url);
const sourceRoots = [
  fileURLToPath(new URL('./', import.meta.url)),
  fileURLToPath(new URL('../backend/', import.meta.url)),
];
const obsoleteTerms = [
  ['open', 'street', 'map'].join(''),
  ['leaf', 'let'].join(''),
  ['legacy', '-', 'agent'].join(''),
  ['init', 'Map', 'IfNeeded'].join(''),
];

async function listSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const path = new URL(`${encodeURIComponent(entry.name)}${entry.isDirectory() ? '/' : ''}`, `file://${root}/`);
    return entry.isDirectory() ? listSourceFiles(fileURLToPath(path)) : [fileURLToPath(path)];
  }));
  return files.flat();
}

function directive(name) {
  const entry = CSP_DIRECTIVES.find(([directiveName]) => directiveName === name);
  assert.ok(entry, `CSP directive ${name} is declared`);
  return entry[1];
}

test('Mia page declares the exact fail-closed CSP and no remote executable source', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i);
  assert.ok(match, 'index.html has a page CSP meta tag');
  assert.equal(match[1], MIAOS_PAGE_CSP);
  assert.equal(directive('script-src').join(' '), "'self'");
  assert.equal(directive('script-src-elem').join(' '), "'self'");
  assert.equal(directive('script-src-attr').join(' '), "'none'");
  assert.equal(directive('connect-src').join(' '), "'self'");
  assert.deepEqual(directive('worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(directive('img-src'), ["'self'", 'data:', 'blob:']);
  assert.match(MIAOS_PAGE_CSP, /style-src 'self'/);
  assert.match(MIAOS_PAGE_CSP, /style-src-elem 'self' 'unsafe-inline'/);
  assert.match(MIAOS_PAGE_CSP, /style-src-attr 'unsafe-inline'/);
  assert.doesNotMatch(MIAOS_PAGE_CSP, /(?:^|\s)(?:\*|https?:|wss?:)(?:\s|;|$)/);
  assert.doesNotMatch(MIAOS_PAGE_CSP, /unsafe-eval/);
  assert.doesNotMatch(html, /unpkg\.com|cdnjs|jsdelivr/i);
});

test('required local script and font assets exist', () => {
  assertRequiredLocalAssets((assetPath) => fileExistsSync(new URL(assetPath, assetsRoot)));
  assert.equal(REQUIRED_LOCAL_ASSETS.some((assetPath) => /dcv|desktop-layout/i.test(assetPath)), false);
});

test('missing required assets fail loudly instead of using a network fallback', () => {
  assert.throws(
    () => assertRequiredLocalAssets((assetPath) => assetPath !== 'styles.css'),
    /Missing Mia CSP assets:[\s\S]*styles\.css/,
  );
});

test('obsolete map integration has no shipped source references', async () => {
  const files = (await Promise.all(sourceRoots.map(listSourceFiles))).flat();
  const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')]));
  for (const [file, source] of sources) {
    for (const term of obsoleteTerms) {
      assert.doesNotMatch(source, new RegExp(term, 'i'), `${file} contains obsolete term ${term}`);
    }
  }
});
