import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('./ai-mode.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./ai-mode.css', import.meta.url), 'utf8');
const draw = js.slice(js.indexOf('function draw(){'), js.indexOf('function redraw()'));

test('the stage is only rebuilt when its markup really changed', () => {
  assert.match(draw, /if\(cv\._h!==h\)\{[^}]*unmount\(cv\);canvasHold\(\);[^}]*cv\.innerHTML=h;/);
  assert.match(draw, /cv\._h=h;/);
  // The deferred swap of a new view still runs when the markup is the same.
  assert.match(draw, /\}\s*canvasPlace\(\);stepsDraw\(\);/);
  assert.match(js, /\$\('cv'\)\.innerHTML='';\$\('cv'\)\._h='';/);
});

test('a stage that grows inside the same run does not fade in again', () => {
  assert.match(draw, /classList\.toggle\('again',!!cv\._h&&cv\._k===key\)/);
  assert.match(css, /\.again \.canvas,[^{]*\.again \.card[^{]*\{animation:none\}/);
});

test('the half-written view is never drawn; the building panel stands in', () => {
  assert.match(js, /if\(!m\[3\]\)return \{html:'',building:html\.length/);
  assert.match(js, /drawn\.building!=null\?buildingHtml\(drawn\.building\)/);
});

test('the drawer and the stage take their clicks back from the strip that moves the window', () => {
  const rule = css.match(/([^{}]*)\{-webkit-app-region:no-drag\}/g).join(' ');
  for (const part of ['.log', '.log-tab', '.cv', '.ink']) assert.ok(rule.includes(part), part);
});
