'use strict';

// Drift guard for backend/platform-map.js — run by smoke.sh (section "PM").
//
// The product map is hand-written prose, not generated, so nothing forces it
// to stay current as pages get added/renamed in the real app. This script
// extracts the actual page labels straight from frontend/app.js's nav
// definitions (WORKSPACE_PANELS + LAYER_PANELS — the two variables that
// literally drive the topbar tabs, see the router comment above them) and
// asserts every one of them shows up somewhere in buildPlatformMap()'s
// output. Comparison is normalized (lowercased, punctuation/whitespace
// stripped) so cosmetic differences ("Connected Apps" vs "connected-apps")
// don't false-positive — only a page with NO trace in the map text fails.
// A new page added to the nav without a matching platform-map.js update
// breaks this check, on purpose.
const fs = require('fs');
const path = require('path');
const { buildPlatformMap } = require('./platform-map');

const APP_JS_PATH = path.join(__dirname, '..', 'frontend', 'app.js');

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractNavLabels(appJsSource) {
  const start = appJsSource.indexOf('var WORKSPACE_PANELS');
  if (start === -1) throw new Error('WORKSPACE_PANELS not found in frontend/app.js — nav structure moved, update the anchor in verify-platform-map-coverage.js');
  const layerStart = appJsSource.indexOf('var LAYER_PANELS', start);
  if (layerStart === -1) throw new Error('LAYER_PANELS not found in frontend/app.js — nav structure moved, update the anchor in verify-platform-map-coverage.js');
  const layerEnd = appJsSource.indexOf('};', layerStart);
  if (layerEnd === -1) throw new Error('could not find the end of the LAYER_PANELS object literal in frontend/app.js');
  const block = appJsSource.slice(start, layerEnd + 2);

  const labels = new Set();
  for (const m of block.matchAll(/label:\s*'([^']+)'/g)) labels.add(m[1]);
  return [...labels];
}

function main() {
  const appJsSource = fs.readFileSync(APP_JS_PATH, 'utf8');
  const labels = extractNavLabels(appJsSource);
  const mapText = normalize(buildPlatformMap());

  const missing = labels.filter((label) => !mapText.includes(normalize(label)));
  if (missing.length) {
    for (const label of missing) {
      console.error(`platform map is missing page ${label} — update backend/platform-map.js`);
    }
    process.exit(1);
  }
  console.log(`platform map covers all ${labels.length} nav pages extracted from frontend/app.js`);
  process.exit(0);
}

main();
