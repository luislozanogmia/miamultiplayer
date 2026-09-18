import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat picker is a real connected inventory control with staged menus', async () => {
  const [appSource, htmlSource, cssSource] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(htmlSource, /id="ccModelSearch"/);
  assert.match(htmlSource, /id="ccModelOptions"/);
  assert.match(htmlSource, /id="ccModelBack"/);
  assert.match(htmlSource, /cc-model-bolt/);
  assert.match(htmlSource, /class="cc-model-bolt"[\s\S]*?<path d="M9 1\.5 3 9/);
  assert.doesNotMatch(htmlSource, /cc-model-bolt[^<]*&#9889;/);
  assert.match(htmlSource, /&#8250;/);
  assert.doesNotMatch(htmlSource, /style="display:none;"[^>]*id="ccModelSelect"/);
  assert.match(appSource, /inventoryUrl = '\/api\/settings\/harness\/chat-models' \+ \(options\.refresh === true \? '\?refresh=true' : ''\)/);
  assert.match(appSource, /chatModelPicker\.ensureLoaded\(\)/);
  assert.match(appSource, /picker\.resetAndReload = function\(\)/);
  assert.match(appSource, /disconnectHarnessProvider[\s\S]*chatModelPicker\.resetAndReload\(\)/);
  assert.doesNotMatch(appSource, /chat-model-inventory|readCachedChatModelProviders|cacheChatModelProviders/);
  assert.match(appSource, /mia\.chat-model-selection\.v1:/);
  assert.match(appSource, /function readCachedChatModelSelection\(\)/);
  assert.match(appSource, /function clearCachedChatModelSelection\(\)/);
  assert.match(appSource, /candidate\.provider === cached\.provider && candidate\.model === cached\.model/);
  assert.match(appSource, /cacheChatModelSelection\(picker\.selection\)/);
  assert.match(appSource, /cacheChatModelSelection\(Object\.assign\(\{\}, picker\.selection, \{speed:'normal'\}\)\)/);
  assert.match(appSource, /if\(!selection\.provider \|\| !selection\.model\) selection = readCachedChatModelSelection\(\) \|\| \{\}/);
  assert.match(appSource, /picker\.ensureLoaded = function\(\)\{ return load\(\{refresh:true\}\); \};/);
  assert.match(appSource, /picker\.resetAndReload = function\(\)\{[\s\S]*clearCachedChatModelSelection\(\)/);
  assert.match(appSource, /else \{\s*clearCachedChatModelSelection\(\);\s*picker\.selection = \{provider:null/);
  assert.match(appSource, /title\.textContent = 'Connect a model'/);
  assert.match(appSource, /Connect a provider in Settings → Access\./);
  assert.match(appSource, /if\(res\.status !== 200\) throw new Error/);
  assert.match(appSource, /picker\.providers = \[\];[\s\S]*BENCH_MODELS = \[\];[\s\S]*picker\.error = error/);
  assert.match(appSource, /var cachedSelection = readCachedChatModelSelection\(\)/);
  assert.match(appSource, /var pendingModel = cachedSelection && cachedSelection\.model \|\| harnessSettingsCache\.model/);
  assert.match(appSource, /var pendingEffort = cachedSelection && cachedSelection\.reasoningEffort \|\| 'high'/);
  assert.match(appSource, /picker\.loaded && !picker\.error && options\.refresh !== true/);
  assert.doesNotMatch(appSource, /ccModelSearch/);
  assert.match(appSource, /data-choice="family"/);
  assert.match(appSource, /data-choice="variant"/);
  assert.match(appSource, /family:'GPT', variant:'GPT '/);
  assert.match(appSource, /family:'DeepSeek', variant:chatModelTitleCase/);
  assert.match(appSource, /label = chosen\.family \+ ' ' \+ label/);
  assert.match(appSource, /tags\.textContent = label/);
  assert.doesNotMatch(appSource, /cc-model-tag-model/);
  assert.match(appSource, /pickerRoot\.addEventListener\('click', function\(event\)\{\s*event\.stopPropagation\(\);/);
  assert.match(appSource, /if\(!pickerRoot\.contains\(event\.target\)\) closeMenu\(\);/);
  assert.match(appSource, /data-choice="effort"/);
  assert.match(appSource, /data-choice="speed"/);
  assert.match(appSource, /pickerRoot\.classList\.toggle\('is-fast', s\.speed === 'fast'\)/);
  assert.match(cssSource, /\.cc-model-bolt\{[^}]*color:var\(--sand-text-secondary\);[^}]*opacity:\.5;[^}]*stroke:currentColor;/);
  assert.match(cssSource, /\.cc-model-select\.is-fast \.cc-model-bolt\{[^}]*color:var\(--sand-warning\);[^}]*opacity:1;/);
  assert.match(appSource, /\[input, send, plus, mic\]\.forEach/);
  assert.match(appSource, /if\(model\) model\.disabled = false/);
  assert.doesNotMatch(cssSource, /\.chat-composer-wrap\.chat-composer-unbound\{[^}]*pointer-events:none/);
  assert.match(appSource, /function goBack\(\)/);
  assert.match(appSource, /event\.key === 'Escape'/);
  assert.match(appSource, /metadata: \{chatModelSelection: chatModelMetadata\}/);
  assert.match(cssSource, /\.cc-model-options\{[^}]*max-height:220px/);
  assert.doesNotMatch(appSource, /interactive-mock, doesn't change the real backend model/);
  assert.doesNotMatch(appSource, /BUILTIN_AGENTS_BASE|mergeBuiltinAgents/);
});
