import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat composer sends with Enter and preserves Shift+Enter for a new line', async () => {
  const [source, html, styles] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<textarea class="cc-input" id="ccInput" rows="1"[^>]*><\/textarea>/);
  assert.doesNotMatch(html, /<input[^>]*id="ccInput"/);
  assert.match(source, /if\(e\.key === 'Enter' && !e\.shiftKey\)\{ e\.preventDefault\(\); submit\(\); \}/);
  assert.doesNotMatch(source, /if\(e\.key === 'Enter'\)\{ e\.preventDefault\(\); submit\(\); \}/);
  assert.match(styles, /\.cc-input\{[^}]*resize:none;[^}]*overflow-y:auto;/);
  assert.match(styles, /body\.styled-skin \.cc-input\{[^}]*height:100%;[^}]*min-height:32px;/);
});

test('human DM alignment is based on the authenticated sender, not human kind', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatMsgHtml(');
  const end = source.indexOf('\n  function renderAgentSetupThread(', start);
  assert.ok(start >= 0 && end > start, 'chatMsgHtml source block is available');
  const renderer = source.slice(start, end);

  assert.match(renderer, /isOwnHuman\s*=\s*!senderEmail\s*\|\|\s*senderEmail\.toLowerCase\(\)\s*===\s*\(currentUser\s*\|\|\s*''\)\.toLowerCase\(\)/);
  assert.match(renderer, /\(isOwnHuman\s*\?\s*' is-you'\s*:\s*''\)/);
  assert.doesNotMatch(renderer, /\(isHuman\s*\?\s*' is-you'\s*:\s*''\)/);
});

test('conversation text remains natively selectable in the Electron shell', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(source, /\.chat-msg-text\{[^}]*cursor:text;[^}]*user-select:text;[^}]*-webkit-user-select:text;[^}]*-webkit-app-region:no-drag;/);
  assert.match(source, /\.chat-msg-text \*\{user-select:text;-webkit-user-select:text;-webkit-app-region:no-drag;\}/);
  assert.match(source, /\.chat-msg-row\.is-you \.chat-msg-text::selection,[\s\S]*?\.chat-msg-row\.is-you \.chat-msg-text \*::selection\{[^}]*background:var\(--sand-fill-accent\);[^}]*color:var\(--sand-text-on-primary\);/);
});

test('inactive conversation previews render markdown as plain readable text', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function markdownPreviewText(');
  const helperEnd = source.indexOf('\n  function mdInline(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'markdown preview normalizer is available');
  const markdownPreviewText = Function(
    `${source.slice(helperStart, helperEnd)}\nreturn markdownPreviewText;`,
  )();

  assert.equal(markdownPreviewText('Run complete: **Automation log**'), 'Run complete: Automation log');
  assert.equal(markdownPreviewText('Open [the report](https://example.com/report) and `file.xlsx`.'), 'Open the report and file.xlsx.');
  assert.equal(markdownPreviewText('2 * 3 stays ordinary text'), '2 * 3 stays ordinary text');

  const sidebarStart = source.indexOf('function roomPreview(roomId){');
  const sidebarEnd = source.indexOf('\n    function sidebarRowText(', sidebarStart);
  assert.match(source.slice(sidebarStart, sidebarEnd), /markdownPreviewText\(text\)/);
});

test('bold inline-code filenames render without leaking markdown markers', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function mdInline(');
  const helperEnd = source.indexOf('\n  // A line counts as a table row', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'inline markdown renderer is available');
  const escape = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const mdInline = Function(
    'esc',
    'linkifyEsc',
    `${source.slice(helperStart, helperEnd)}\nreturn mdInline;`,
  )(escape, escape);

  assert.equal(
    mdInline('Created and attached **`openai-news-top-3.pdf`**.'),
    'Created and attached <strong><code>openai-news-top-3.pdf</code></strong>.',
  );
});

test('LaTeX-style math blocks render as readable math while fenced content stays code', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function renderMathExpression(');
  const helperEnd = source.indexOf('\n  function mdInline(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'math renderer is available');
  const escape = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const renderMathExpression = Function(
    'esc',
    `${source.slice(helperStart, helperEnd)}\nreturn renderMathExpression;`,
  )(escape);

  const rendered = renderMathExpression('\\text{answer} = \\text{clue}_1 \\times \\text{importance}_1', true);
  assert.match(rendered, /chat-math-block/);
  assert.match(rendered, /<span class="chat-math-text">answer<\/span>/);
  assert.match(rendered, /<sub>1<\/sub>/);
  assert.match(rendered, /×/);
  assert.doesNotMatch(rendered, /\\text|\\times/);

  const mdStart = source.indexOf('function mdLite(');
  const mdEnd = source.indexOf('\n  // Which human posted', mdStart);
  const markdownBlock = source.slice(mdStart, mdEnd);
  assert.match(markdownBlock, /chat-md-code/);
  assert.match(markdownBlock, /mathStartsAt/);
});

test('browser collaboration keeps app diagnostics inside the Mia pane', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(source, /body\.browser-collab-mode \.app-development-panel\{[^}]*left:auto;[^}]*right:12px;[^}]*width:min\(360px,calc\(var\(--browser-mia-pane-width\) - 24px\)\);/);
});

test('human identity parsing does not consume arbitrary bracketed message text', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /function parseSignedHumanBody\(body\)/);
  assert.match(source, /if\(!parsed\.agent \|\| parsed\.agent\.indexOf\('@'\) === -1\) return \{agent: null, text: body\};/);
  const rendererStart = source.indexOf('function chatMsgHtml(');
  const rendererEnd = source.indexOf('\n  function renderAgentSetupThread(', rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(renderer, /var humanParsed = parseSignedHumanBody\(m\.body\);/);
});

test('styled direct chats keep sender names and avatars visible', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(
    source,
    /\.chat-msg-row\.is-direct:not\(\.in-thread\) \.chat-msg-(?:mark|mark-time|head)\{display:none;\}/,
    'the styled shell must not hide direct-chat identity chrome',
  );
  assert.match(source, /\.chat-msg-mark\{[^}]*display:flex;/);
  assert.match(source, /\.chat-msg-head\{display:flex;/);
});

test('bot identity stays beside every bot message even when a grouped flag is supplied', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatMsgHtml(');
  const end = source.indexOf('\n  function renderAgentSetupThread(', start);
  const renderer = source.slice(start, end);

  assert.match(renderer, /var visuallyGrouped = grouped && isHuman/);
  assert.match(renderer, /var markCol = visuallyGrouped/);
  assert.match(renderer, /var head = visuallyGrouped \? ''/);
});

test('only the newest progress event for an active dispatch can shimmer', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function isLatestLiveProgressMessage(');
  const helperEnd = source.indexOf('\n\n  // opts.inThread', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'progress selection helper is available');
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /for\(var i = messages\.length - 1; i >= 0; i--\)/);
  assert.match(helper, /messages\[i\]\.id === message\.id/);

  const rendererStart = source.indexOf('function chatMsgHtml(');
  const rendererEnd = source.indexOf('\n  function agentSetupAutomationText', rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(renderer, /var liveProgress = !isHuman && isLatestLiveProgressMessage\(m\);/);
  assert.match(renderer, /liveProgress[\s\S]*chat-thinking-shimmer/);
});

test('completed replies hide their earlier persisted progress row', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function isSupersededNativeProgressMessage(');
  const helperEnd = source.indexOf('\n\n  function chatArtifactCardHtml', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'completed-progress helper is available');
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /candidate\.nativeDispatchId === message\.nativeDispatchId/);
  assert.match(helper, /!candidate\.nativeProgress/);

  const rendererStart = source.indexOf('function chatMsgHtml(');
  const rendererEnd = source.indexOf('\n  function agentSetupAutomationText', rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(renderer, /if\(!isHuman && isSupersededNativeProgressMessage\(m\)\) return '';/);
});

test('browser collaboration uses near-full-width bubbles and a measured three-line collapse in threads too', async () => {
  const [appSource, cssSource] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /var compactBrowserMessage = !!text && document\.body\.classList\.contains\('browser-collab-mode'\);/);
  assert.match(appSource, /chatExpandableMessageHtml\(text, false, compactBrowserMessage\)/);
  assert.match(appSource, /data-chat-compact-preview/);
  assert.match(appSource, /preview\.scrollHeight <= preview\.clientHeight \+ 1/);
  assert.match(appSource, /preview\.classList\.toggle\('chat-compact-preview-overflow', !fits\)/);
  assert.match(cssSource, /body\.browser-collab-mode\{[^}]*--chat-compact-preview-lines:3;/);
  assert.match(cssSource, /body\.styled-skin\.browser-collab-mode \.chat-msg-row\.is-direct\{padding-right:5%;\}/);
  assert.match(cssSource, /body\.styled-skin\.browser-collab-mode \.chat-thread-panel \.chat-msg-row\.is-direct\{padding-right:5%;\}/);
  assert.match(cssSource, /\.chat-expandable-preview\.chat-compact-preview-overflow,[\s\S]*max-height:calc\(var\(--chat-compact-preview-lines\) \* var\(--chat-compact-preview-line-height\)\)/);
});

test('production chat runtime does not manufacture presentation users', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /mockup@|mockup\.local|MOCKUP_|isMockupPreviewUser|fixture-person-name/);
  assert.match(source, /chatWs\.humans = Array\.isArray\(results\[2\]\) \? results\[2\]\.slice\(\) : \[\];/);
});

test('channel rosters use authoritative membership or an honest unavailable state', async () => {
  const [appSource, cssSource] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(appSource, /mockupMark|mark: 'RD'/, 'department channels do not use a one-off initials tile');
  assert.match(appSource, /function channelMemberEntries\(roomId, label, isHome\)[\s\S]*state\.mentionRoster/);
  assert.match(appSource, /Do not fabricate room members from the global directory/);
  assert.match(appSource, /Channel members unavailable/);
  assert.match(appSource, /No channel members listed/);
  assert.match(cssSource, /\.chat-row-members\.unavailable/);
  assert.match(cssSource, /\.chat-channel-members-unavailable/);
});

test('styled offline department rosters use local agent assignments without inventing humans', async () => {
  const [appSource, cssSource] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /function localDepartmentAgentRoster\(label, isHome\)/);
  assert.match(appSource, /chatWs\.configured === false/);
  assert.match(appSource, /agentDepartments\(a\)\.some/);
  assert.match(appSource, /\{id: 'gateway', name: 'Mia'\}/);
  assert.match(appSource, /peopleUnavailable: true/);
  assert.match(appSource, /Human membership unavailable/);
  assert.match(appSource, /Channel agents: /);
  assert.doesNotMatch(appSource, /chat-channel-human-unavailable|human-roster-unavailable/);
  assert.doesNotMatch(cssSource, /chat-channel-human-unavailable|human-roster-unavailable/);
});

test('a background task root exposes an empty thread without a duplicate status bubble', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatThreadFooterHtml(');
  const end = source.indexOf('\n  // Keeps the docked', start);
  assert.ok(start >= 0 && end > start, 'thread footer source block is available');
  const footer = source.slice(start, end);

  assert.match(footer, /root && root\.taskRoot/);
  assert.match(footer, /threadEvents\.length/);
  assert.match(footer, /Open thread/);
  assert.match(source, /function isLegacyTaskFiller\(body\)/);
  assert.match(source, /I’m on it — I’ll keep you posted here\./);
  assert.match(source, /I’m waiting for a turn to start — I’ll keep you posted\./);
});

test('image-only messages render through the native attachment endpoint', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatMsgHtml(');
  const end = source.indexOf('\n  function renderAgentSetupThread(', start);
  assert.ok(start >= 0 && end > start, 'chatMsgHtml source block is available');
  const renderer = source.slice(start, end);

  assert.match(renderer, /var hasMedia = attachments\.length > 0/);
  assert.match(renderer, /if\(!text && !hasMedia && !driveDisplay.files.length\) return ''/);
  assert.match(renderer, /attachments\.map\(chatArtifactCardHtml\)/);
  assert.match(source, /function chatArtifactCardHtml\(media\)/);
  assert.match(source, /chat-msg-media/);
  assert.match(renderer, /\(text \|\| driveDisplay\.files\.length \? '<div class="chat-msg-text/);
});

test('native artifact cards preserve every attachment, keep originals downloadable, and sandbox previews', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /content\.attachments\) \? content\.attachments\.filter/);
  assert.match(source, /previewUrl: nativeConversationPath\(event\.conversationId, attachmentPath \+ '\?preview=true'\)/);
  assert.match(source, /class="chat-artifact-download" href="' \+ mediaUrl/);
  assert.match(source, /data-chat-artifact-preview/);
  assert.match(source, /window\.miaDesktop && window\.miaDesktop\.artifact/);
  assert.match(source, /desktop\.open\(url\)/);
  const previewStart = source.indexOf('function wireChatArtifactPreviews(');
  const previewEnd = source.indexOf('\n  // opts.inThread:', previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart, 'artifact preview wiring is available');
  assert.doesNotMatch(source.slice(previewStart, previewEnd), /window\.open|location\.href/);
  assert.match(source.slice(previewStart, previewEnd), /Artifact previews are available in the Mia desktop app/);
  assert.match(source, /'image\/svg\+xml': true/);
  assert.doesNotMatch(source.slice(source.indexOf('var NATIVE_RASTER_PREVIEW_MIMES'), source.indexOf('var NATIVE_SAFE_PREVIEW_MIMES')), /svg/);
  assert.match(source, /chatMessageHasAttachments\(m\)/);
});

test('composer stages one bounded image through the native attachment endpoint', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /function prepareChatAttachment\(file, roomId\)/);
  assert.match(source, /nativeConversationPath\(roomId, '\/attachments'\)/);
  assert.match(source, /contentBase64: dataBase64/);
  assert.match(source, /content\.attachments = \[preparedAttachment\.attachment\]/);
  assert.match(source, /file\.size > 8 \* 1024 \* 1024/);
});
