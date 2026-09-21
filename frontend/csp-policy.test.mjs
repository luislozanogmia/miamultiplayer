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
  buildPageCsp,
  replacePageCsp,
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

test('Mia page declares the exact fail-closed CSP and only Clerk authentication origins', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i);
  assert.ok(match, 'index.html has a page CSP meta tag');
  assert.equal(match[1], MIAOS_PAGE_CSP);
  assert.deepEqual(directive('script-src'), ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']);
  assert.deepEqual(directive('script-src-elem'), ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']);
  assert.equal(directive('script-src-attr').join(' '), "'none'");
  assert.deepEqual(directive('connect-src'), [
    "'self'",
    'https://*.clerk.accounts.dev',
    'https://clerk-telemetry.com',
    'https://*.clerk-telemetry.com',
    'https://img.clerk.com',
    'https://*.protect.clerk.com:*',
  ]);
  assert.deepEqual(directive('worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(directive('img-src'), ["'self'", 'data:', 'blob:', 'https://img.clerk.com']);
  assert.deepEqual(directive('frame-src'), ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']);
  assert.match(MIAOS_PAGE_CSP, /style-src 'self'/);
  assert.match(MIAOS_PAGE_CSP, /style-src-elem 'self' 'unsafe-inline'/);
  assert.match(MIAOS_PAGE_CSP, /style-src-attr 'unsafe-inline'/);
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

test('production Clerk CSP adds only the configured exact FAPI origin to served HTML', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const policy = buildPageCsp('https://clerk.example.com');
  const rendered = replacePageCsp(html, policy);
  assert.match(policy, /connect-src[^;]* https:\/\/clerk\.example\.com(?:;|$)/);
  assert.doesNotMatch(policy, /https:\/\/\*\.example\.com/);
  assert.match(rendered, /content="[^"]*https:\/\/clerk\.example\.com[^"]*"/);
  assert.doesNotMatch(rendered, new RegExp(`content="${MIAOS_PAGE_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
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
