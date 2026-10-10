'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Use Chromium's actual cascade, including the production tab styles and
// decorator. A selector-text assertion would miss competing active-tab rules.
test('selected owned tabs retain their ring and mote while human styling stays intact', t => {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
  if (!chrome) return t.skip('Chromium is required for computed CSS acceptance');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-tab-presence-css-'));
  try {
    const css = ['styles.css', 'browser-work.css'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
    const source = fs.readFileSync(path.join(__dirname, 'browser-work.js'), 'utf8');
    const html = `<!doctype html><style>${css}</style>
      <div id="strip"><div class="native-browser-tab active" data-tab-id="1"><button role="tab">Human</button></div>
      <div class="native-browser-tab active" data-tab-id="2"><button role="tab">Alpha</button></div>
      <div class="native-browser-tab" data-tab-id="3"><button role="tab">Beta</button></div></div>
      <script>${source.replace(/<\/script/gi, '<\\/script')}</script>
      <script>
      const strip=document.getElementById('strip');
      const inspect=id=>{const tab=strip.querySelector('[data-tab-id="'+id+'"]'),s=getComputedStyle(tab),m=tab.querySelector('.browser-worker-mote');return {shadow:s.boxShadow,background:s.backgroundColor,motes:tab.querySelectorAll('.browser-worker-mote').length,label:m?.getAttribute('aria-label'),moteWidth:m?getComputedStyle(m.firstChild).width:null};};
      const humanBefore=inspect(1);
      MiaBrowserWork.decorateTabs(strip,{ownership:[{tabId:2,name:'Alpha',status:'working'},{tabId:3,name:'Beta',status:'idle'}]});
      const owned={human:inspect(1),selected:inspect(2),background:inspect(3)};
      MiaBrowserWork.decorateTabs(strip,{ownership:[]});
      const cleared={human:inspect(1),selected:inspect(2),background:inspect(3)};
      document.body.innerHTML='<pre id="result">'+encodeURIComponent(JSON.stringify({humanBefore,owned,cleared}))+'</pre>';
      </script>`;
    const page = path.join(dir, 'presence.html'); fs.writeFileSync(page, html);
    const output = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'profile'), '--dump-dom', pathToFileURL(page).href], { encoding:'utf8', timeout:20000, maxBuffer:2*1024*1024, stdio:['ignore','pipe','pipe'] });
    const match = output.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(match, 'Chromium must execute the production decorator');
    const result = JSON.parse(decodeURIComponent(match[1]));
    assert.deepEqual(result.owned.human, result.humanBefore);
    for (const tab of [result.owned.selected, result.owned.background]) {
      assert.match(tab.shadow, /inset/, 'every owned tab needs a visible ownership ring');
      assert.equal(tab.motes, 1); assert.equal(tab.moteWidth, '14px');
    }
    assert.equal(result.owned.selected.shadow, result.owned.background.shadow, 'selection must not hide the ownership ring');
    assert.equal(result.owned.selected.background, result.humanBefore.background);
    assert.equal(result.owned.selected.label, 'Alpha · Working');
    assert.deepEqual(result.cleared.selected, result.humanBefore);
    assert.equal(result.cleared.background.motes, 0);
    assert.doesNotMatch(result.cleared.background.shadow, /inset/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
