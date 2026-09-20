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
  assert.match(appSource, /data-choice="family-provider"/);
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

test('the "Choose a model family" back screen lists every setup provider, not just the connected one', async () => {
  const [appSource, cssSource] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  // Static list of every provider offered by initial setup (index.html's
  // harnessProviderChoices), independent of what is currently connected.
  assert.match(appSource, /var COMPOSER_FAMILY_PROVIDERS = \[/);
  assert.match(appSource, /id:'managed-router', label:'Mia Router'/);
  assert.match(appSource, /id:'anthropic', label:'Claude'/);
  assert.match(appSource, /id:'openai-codex', label:'ChatGPT', caption:'Codex CLI'/);
  assert.match(appSource, /id:'xai-oauth', label:'Grok', caption:'Grok CLI'/);
  assert.match(appSource, /id:'gemini', label:'Gemini'/);

  // Connection state and the connect flow reuse setup's own mechanisms —
  // no parallel state or flow is invented for the picker.
  assert.match(appSource, /function familyProviderConnected\(row\)\{\s*if\(harnessConnectionState\[row\.id\] === true\) return true;/);
  assert.match(appSource, /function openConnectFlowForProvider\(row\)\{\s*closeMenu\(\);\s*openHarnessOnboarding\(harnessSettingsCache\);/);
  assert.match(appSource, /var choice = el\('\[data-harness-provider="' \+ row\.harnessProvider \+ '"\]'\);/);
  assert.match(appSource, /var apiProviderSelect = el\('#harnessApiProvider'\);/);

  // Unconnected rows keep a normal (non-selectable) row plus a Connect pill
  // styled with the same pill class setup's own connect/disconnect actions use.
  assert.match(appSource, /cc-model-connect-pill/);
  assert.match(appSource, /styled-onboarding-connection-action cc-model-connect-pill/);
  assert.match(cssSource, /\.cc-model-connect-pill\{/);

  // Connected rows are selectable and tap-switch immediately; the active one
  // is tinted with a check.
  assert.match(appSource, /kind === 'family-provider'/);
  assert.match(appSource, /cc-model-family-check/);
  assert.match(cssSource, /\.cc-model-family-option\.is-active \.cc-model-family-check\{/);

  // Not just the old family stage — the variant list under a tapped provider
  // row is filtered by that provider, and the picker no longer dead-ends on
  // an empty inventory before reaching the family screen.
  assert.match(appSource, /familyProviderEntries\(activeRow\)/);
  assert.match(appSource, /if\(!all\.length && currentStage !== 'family'\)/);
});
