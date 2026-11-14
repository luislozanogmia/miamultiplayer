#!/usr/bin/env node
// Builds Mia's phone page as one static folder: the page that pairs a phone
// with the person's computer and runs AI mode there through the Hub.
//
//   node scripts/build_phone_page.mjs [--hub https://hub.example.com] [--out dist/phone]
//
// The folder is ready for any HTTPS host; opened in Safari on an iPhone it can
// be added to the Home Screen. It also carries capacitor.config.json, so the
// same folder is the web part of a native iOS app. Building that app needs a
// Mac with Xcode and Apple signing; this script does not produce it.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONT = join(REPO, 'frontend');
const MOTES = ['research', 'inbox', 'calendar', 'sales', 'general', 'black'];
// Everything the page loads, and nothing else from the app.
export const PHONE_FILES = [
  'phone.css', 'phone.js', 'phone.webmanifest', 'remote-link-core.js', 'remote-link-phone.js',
  'ai-mode.js', 'ai-mode.css', 'assets/mia-mark.js',
  'assets/fonts/InstrumentSans-Variable.woff2', 'assets/fonts/JetBrainsMono-Variable.woff2',
  'assets/icons/mia-192.png', 'assets/icons/mia-512.png',
  ...MOTES.map(kind => `assets/mote/mote-${kind}.svg`),
];

export async function buildPhonePage({ out, hub = '' }) {
  if (hub && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(hub) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(hub)) {
    throw new Error('--hub must be an https address with no path');
  }
  await rm(out, { recursive: true, force: true });
  for (const file of PHONE_FILES) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await cp(join(FRONT, file), join(out, file));
  }
  let page = await readFile(join(FRONT, 'phone.html'), 'utf8');
  if (hub) {
    const tag = /<meta name="mia-hub" content="[^"]*">/;
    if (!tag.test(page)) throw new Error('phone.html has no mia-hub tag');
    page = page.replace(tag, `<meta name="mia-hub" content="${hub}">`);
  }
  await writeFile(join(out, 'index.html'), page);
  const manifest = JSON.parse(await readFile(join(FRONT, 'phone.webmanifest'), 'utf8'));
  manifest.start_url = './';
  await writeFile(join(out, 'phone.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(out, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.miamultiplayer.mia.phone', appName: 'Mia', webDir: '.',
    ios: { contentInset: 'never', backgroundColor: '#050504' },
  }, null, 2) + '\n');
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = { out: join(REPO, 'dist', 'phone'), hub: '' };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--out' && args[i + 1]) options.out = resolve(args[i + 1]);
    else if (args[i] === '--hub' && args[i + 1]) options.hub = args[i + 1].replace(/\/+$/, '');
    else { console.error('usage: build_phone_page.mjs [--hub https://...] [--out dir]'); process.exit(2); }
  }
  try { console.log(await buildPhonePage(options)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
