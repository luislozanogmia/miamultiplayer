import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFile(new URL('./' + name, import.meta.url), 'utf8');
const [flow, app, html, css] = await Promise.all(['ai-mode.js', 'app.js', 'index.html', 'styles.css'].map(read));

// Flow's own on/off code, run against a small stand-in for the page.
function setting(stored = {}) {
  const source = flow.slice(flow.indexOf('function flowOn()'), flow.indexOf('flowShow();\n// The intro shows'));
  assert.ok(source.includes('function flowSet(on)'));
  const classes = list => ({ toggle(name, on) { on ? list.add(name) : list.delete(name); } });
  const body = new Set(), entry = new Set();
  const context = vm.createContext({
    localStorage: { getItem: key => (key in stored ? stored[key] : null), setItem(key, value) { stored[key] = value; }, removeItem(key) { delete stored[key]; } },
    document: { body: { classList: classes(body) }, getElementById: id => (id === 'aiModeEntry' ? { classList: classes(entry) } : null) },
  });
  vm.runInContext(source, context);
  return { context, body, entry, stored };
}

test('Flow mode is off until the person turns it on, and its button is not there', () => {
  const page = setting();
  page.context.flowShow();
  assert.equal(page.context.flowOn(), false);
  assert.equal(page.body.has('flow-mode-on'), false);
  assert.match(css, /body:not\(\.flow-mode-on\) #aiModeEntry\{display:none;\}/);
});

test('turned on in Settings, the button is there and glows gold until Flow is first opened', () => {
  const page = setting();
  page.context.flowSet(true);
  assert.equal(page.context.flowOn(), true);
  assert.ok(page.body.has('flow-mode-on') && page.entry.has('fresh'));
  page.stored.miaFlowModeOpened = '1';
  page.context.flowShow();
  assert.ok(page.body.has('flow-mode-on') && !page.entry.has('fresh'));
  page.context.flowSet(false);
  assert.equal(page.body.has('flow-mode-on'), false);
  assert.match(css, /\.ai-mode-entry\.fresh \.workspace-rail-mark\{[^}]*var\(--mia-gold\)[^}]*animation:workspace-invite-glow/, 'the same glow as a new invite');
});

test('the intro never plays by itself, and not at all while Flow mode is off', () => {
  assert.doesNotMatch(app, /maybePlayAiModeIntro/);
  assert.equal((app.match(/MiaAiMode\.intro/g) || []).length, 1, 'only the Watch button in Settings plays it from the app');
  assert.match(flow, /function intro\(\)\{\n  if\(open\|\|!flowOn\(\)\|\|!window\.MiaAiModeIntro\)return;/);
  assert.match(flow, /closest\('\[data-ai-mode-enter\]'\);\n  if\(!b\)return;\n  e\.preventDefault\(\);\n  if\(!flowOn\(\)\)return;/);
});

test('Settings has the switch, and offers the intro only once Flow mode is on', () => {
  assert.match(html, /<input type="checkbox" id="settingsFlowMode" \/>/);
  assert.match(html, /id="settingsFlowModeIntroRow" hidden>/);
  assert.match(app, /window\.MiaAiMode\.setOn\(flowModeToggle\.checked\)/);
  assert.match(app, /flowModeIntroRow\.hidden = !on/);
  assert.match(flow, /on:flowOn,setOn:flowSet\};/);
});

test('Flow Tandem keeps its own button, whatever the Flow mode setting', () => {
  assert.match(html, /id="flowTandemEntry" data-flow-tandem-start/);
  assert.doesNotMatch(css, /flow-mode-on[^{]*#flowTandemEntry/);
});

test('Flow mode and Flow Tandem are preview icons in the rail, above the account', () => {
  const rail = html.slice(html.indexOf('<nav class="workspace-rail"'), html.indexOf('</nav>', html.indexOf('<nav class="workspace-rail"')));
  for (const id of ['aiModeEntry', 'flowTandemEntry']) assert.match(rail, new RegExp('class="workspace-rail-tile workspace-rail-util ai-mode-entry" id="' + id + '"'));
  assert.ok(rail.indexOf('id="flowTandemEntry"') < rail.indexOf('id="chatAcctBtn"'));
  assert.equal((rail.match(/ai-mode-entry-tag">Preview</g) || []).length, 2);
  assert.doesNotMatch(html.slice(html.indexOf('</nav>', html.indexOf('<nav class="workspace-rail"'))), /id="(aiModeEntry|flowTandemEntry)"/, 'no longer rows in the sidebar');
});

test('leaving Flow Tandem puts the stage away at once, so the Flow welcome never flashes over the app', async () => {
  const flow = await readFile(new URL('./ai-mode.js', import.meta.url), 'utf8');
  const leave = flow.slice(flow.indexOf('function leave(){'), flow.indexOf("document.addEventListener('click'", flow.indexOf('function leave(){')));
  const away = leave.indexOf('var away=tandem;'), hide = leave.indexOf('if(away)host.hidden=true;'), shown = leave.indexOf("host.classList.remove('tandem')");
  assert.ok(away > 0 && hide > away && shown > hide, 'the stage is hidden before it stops being out of sight');
  assert.match(leave, /setTimeout\(function\(\)\{if\(!open\)\{host\.hidden=true;/, 'leaving the Flow stage itself still fades out');
});
