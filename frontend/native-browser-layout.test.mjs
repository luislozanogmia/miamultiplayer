import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Run with MIAOS_TEST_CHROMIUM=/path/to/chromium. This exercises real layout,
// including classic scrollbars, without requiring a backend or user profile.
const chromium = process.env.MIAOS_TEST_CHROMIUM;
const root = new URL('./', import.meta.url);
const css = readFileSync(process.env.MIAOS_TEST_STYLESHEET || new URL('styles.css', root), 'utf8');
const index = readFileSync(new URL('index.html', root), 'utf8');
const mote = readFileSync(new URL('assets/mote/mote.svg', root), 'utf8');
const row = index.match(/<div class="native-browser-tabs-row"[\s\S]*?<\/div>/)[0];
const script = `(async () => {
  const row = document.getElementById('localBrowserTabsRow');
  const strip = document.createElement('div');
  strip.className = 'native-browser-tabs';
  strip.setAttribute('role', 'tablist');
  row.insertBefore(strip, document.getElementById('localBrowserCloseBtn'));
  const add = document.createElement('button');
  add.className = 'native-browser-new-tab';
  add.textContent = '+';
  row.insertBefore(add, document.getElementById('localBrowserCloseBtn'));
  const image = row.querySelector('img');
  image.src = \`data:image/svg+xml;base64,\${btoa(window.moteSource)}\`;
  await image.decode();
  // Measure the asset's actual alpha bounds, rather than assuming the SVG's
  // viewBox has symmetric transparent padding.
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let top = canvas.height, bottom = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (pixels[(y * canvas.width + x) * 4 + 3] > 20) { top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
  }
  const samples = [];
  for (const mac of [false, true]) for (const width of [420, 1000]) for (const active of [0, 19]) {
    document.documentElement.classList.toggle('mac-inset-titlebar', mac);
    row.style.width = \`\${width}px\`;
    strip.innerHTML = Array.from({ length: 20 }, (_, i) => \`<div class="native-browser-tab\${i === active ? ' active' : ''}"><button role="tab"><span class="native-browser-tab-label">Page \${i + 1}</span></button><button class="native-browser-tab-close">×</button></div>\`).join('');
    const tab = strip.firstElementChild.getBoundingClientRect();
    const mote = image.getBoundingClientRect();
    const button = image.parentElement.getBoundingClientRect();
    const scale = Math.min(mote.width / canvas.width, mote.height / canvas.height);
    const visibleCenter = mote.top + (mote.height - canvas.height * scale) / 2 + (top + bottom) / 2 * scale;
    const tabCenter = tab.top + tab.height / 2;
    strip.scrollLeft = strip.scrollWidth;
    const last = strip.lastElementChild.querySelector('[role=tab]');
    const end = strip.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const scrolled = strip.scrollLeft > 0 && lastRect.right <= end.right + 1;
    strip.scrollLeft = 0;
    last.focus();
    const focusRect = last.getBoundingClientRect();
    const controls = [add, document.getElementById('localBrowserCloseBtn')].map(el => el.getBoundingClientRect());
    samples.push({ mac, width, active, gutter: strip.offsetHeight - strip.clientHeight,
      moteCenterDelta: Math.abs(visibleCenter - tabCenter), buttonCenterDelta: Math.abs(button.top + button.height / 2 - tabCenter),
      overflow: strip.scrollWidth > strip.clientWidth, scrolled,
      focusVisible: document.activeElement === last && focusRect.left >= end.left - 1 && focusRect.right <= end.right + 1,
      controlsVisible: controls.every(rect => rect.width >= 28 && rect.left >= end.right - 1 && rect.right <= row.getBoundingClientRect().right + 1),
      macInsetPreserved: !mac || button.left >= row.getBoundingClientRect().left + 76 });
  }
  const page = document.getElementById('pageScroll');
  document.getElementById('result').textContent = JSON.stringify({ samples, pageGutter: page.offsetWidth - page.clientWidth });
})().catch(error => { document.getElementById('result').textContent = JSON.stringify({ error: error.message }); });
`;

test('browser tab strip hides its scrollbar, centers the visible mote and retains overflow access', {
  skip: !chromium && 'Set MIAOS_TEST_CHROMIUM to run rendered browser layout checks',
}, () => {
  assert.ok(existsSync(chromium), 'Chromium executable must exist');
  const output = mkdtempSync(path.join(tmpdir(), 'mia-browser-layout-'));
  const fixture = path.join(output, 'layout.html');
  writeFileSync(fixture, `<!doctype html><html><head><style>${css}</style></head>
<body class="browser-collab-mode browser-mia-collapsed"><div class="local-browser-overlay open" style="position:relative;display:block">${row}</div>
<div id="pageScroll" style="overflow:auto;width:100px;height:40px"><div style="height:200px">Page scrollbar</div></div>
<pre id="result"></pre><script>window.moteSource=${JSON.stringify(mote)};</script><script>${script}</script></body></html>`);
  const run = spawnSync(chromium, ['--headless', '--disable-gpu', '--window-size=1280,800', '--disable-features=OverlayScrollbar',
    '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', `file://${fixture}`], { encoding: 'utf8', timeout: 20000, maxBuffer: 3e6 });
  assert.equal(run.status, 0, run.stderr);
  const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
  assert.ok(match, `Missing layout results; fixture retained at ${fixture}`);
  const results = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.ok(!results.error, results.error);
  for (const sample of results.samples) {
    const label = JSON.stringify(sample);
    assert.equal(sample.gutter, 0, `No tab scrollbar gutter: ${label}`);
    assert.ok(sample.moteCenterDelta < 0.75, `Visible mote centers on tabs: ${label}`);
    assert.ok(sample.buttonCenterDelta < 0.5, `Mote hit target centers on tabs: ${label}`);
    assert.ok(sample.overflow, `Fixture must overflow: ${label}`);
    assert.ok(sample.scrolled, `Horizontal scrolling must reach last tab: ${label}`);
    assert.ok(sample.focusVisible, `Keyboard focus must reveal last tab: ${label}`);
    assert.ok(sample.controlsVisible, `Tab controls must remain available: ${label}`);
    assert.ok(sample.macInsetPreserved, `Mac window-button inset remains clear: ${label}`);
  }
  assert.ok(results.pageGutter > 0, 'Other page scrollbars must remain visible');
});
