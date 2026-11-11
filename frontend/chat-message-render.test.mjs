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
  // The composer grows with the draft up to a third of the window, then scrolls.
  assert.match(styles, /body\.styled-skin \.chat-composer\{[^}]*height:auto;[^}]*min-height:96px;/);
  assert.match(styles, /body\.styled-skin \.cc-input\{[^}]*height:auto;[^}]*max-height:33vh;[^}]*field-sizing:content;/);
  // The jump-to-latest button follows the message list, so a tall draft never covers it.
  assert.match(styles, /\.chat-jump-latest\{bottom:calc\(anchor\(--chat-thread bottom\)/);
});

test('human DM alignment is based on the authenticated sender, not human kind', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatMsgHtml(');
  const end = source.indexOf('\n  function renderAgentSetupThread(', start);
  assert.ok(start >= 0 && end > start, 'chatMsgHtml source block is available');
  const renderer = source.slice(start, end);

  assert.match(renderer, /isOwnHuman\s*=\s*m\.hubMessage \? hubOwnMessage\(m\) : !senderEmail\s*\|\|\s*senderEmail\.toLowerCase\(\)\s*===\s*\(currentUser\s*\|\|\s*''\)\.toLowerCase\(\)/);
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
  const sidebarEnd = source.indexOf('\n  function sidebarRowText(', sidebarStart);
  assert.match(source.slice(sidebarStart, sidebarEnd), /markdownPreviewText\(text\)/);
});

test('bold inline-code filenames render without leaking markdown markers', async () => {
  const {mdInline} = await chatMarkdownHelpers();

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
  assert.match(renderer, /var humanParsed = m\.hubAuthor \? \{agent:m\.hubAuthor,text:m\.body\} : parseSignedHumanBody\(m\.body\);/);
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
  assert.match(renderer, /var hasBubble = !!\(text \|\| driveDisplay\.files\.length\)/);
  assert.match(renderer, /\(hasBubble \? '<div class="chat-msg-text/);
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

test('composer stages one bounded file through the native attachment endpoint', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /function prepareChatAttachment\(file, roomId\)/);
  assert.match(source, /nativeConversationPath\(roomId, '\/attachments'\)/);
  assert.match(source, /contentBase64: dataBase64/);
  assert.match(source, /content\.attachments = \[preparedAttachment\.attachment\]/);
  assert.match(source, /file\.size > limit \* 1024 \* 1024/);
});

// A shared-channel bot reply is cleaned for display like a Solo bot reply;
// only a teammate's own message is shown exactly as written.
test('shared channel bot replies get the Solo display cleaning', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function chatMsgHtml(');
  const renderer = source.slice(start, source.indexOf('\n  function renderAgentSetupThread(', start));
  assert.match(renderer, /var botBody = isHuman \|\| \(m\.hubMessage && m\.hubAuthor\) \? m\.body : displayBotBody\(m\.body\);/);
  const security = (await import('./chat-security.js')).default;
  assert.equal(security.sanitizeBotMessage('<think>private</think>The answer.'), 'The answer.');
});

test('a short message in the narrow pane never offers Show more, even measured before layout', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = app.indexOf('  function syncChatCompactPreviewVisibility(');
  const sync = new Function('els', `${app.slice(start, app.indexOf('  function wireChatExpandableMessages(', start))}; return syncChatCompactPreviewVisibility;`);
  const run = (preview) => {
    const toggle = { hidden: true, setAttribute() {} };
    const classes = new Set();
    Object.assign(preview, {
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
      hasAttribute: () => false,
      closest: () => ({ querySelector: () => toggle }),
    });
    sync(() => [preview])({});
    return { toggle, classes };
  };
  assert.equal(run({ clientHeight: 0, scrollHeight: 0 }).toggle.hidden, true, 'an unmeasured preview is not clipped, so it needs no toggle');
  assert.equal(run({ clientHeight: 20, scrollHeight: 20 }).toggle.hidden, true, 'one line fits');
  assert.equal(run({ clientHeight: 60, scrollHeight: 200 }).toggle.hidden, false, 'a long message is clipped and offers the toggle');
  const html = app.slice(app.indexOf('  function chatExpandableMessageHtml('), app.indexOf('  function syncChatCompactPreviewVisibility('));
  assert.match(html, /aria-expanded="false"' \+ \(truncated \? '' : ' hidden'\) \+ '>'/, 'the toggle starts hidden until a measurement asks for it');
});

// The real digest text that exposed all three bugs: dollar amounts read as
// math, [text](url) left raw, and a preview cut inside a bold title.
async function chatMarkdownHelpers(){
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const escape = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const slice = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `${from} is available`);
    return source.slice(start, end);
  };
  return Function(
    'esc',
    `${slice('var BARE_URL_RE', '\n  // Lite markdown for chat bubbles')}
     ${slice('function renderMathExpression(', '\n  // A line counts as a table row')}
     ${slice('function chatMessagePreview(', '\n  function isPreReasoningNotice(')}
     return {mdInline, chatMessagePreview};`,
  )(escape);
}

test('dollar amounts stay money and keep the bold around them', async () => {
  const {mdInline} = await chatMarkdownHelpers();
  const html = mdInline('**OpenAI cuts its round by $10B.** OpenAI is now seeking about $20B at a $1.25T valuation, down from $30B at $1.4T, with only ~$11B committed');
  assert.doesNotMatch(html, /chat-math/);
  assert.match(html, /<strong>OpenAI cuts its round by \$10B\.<\/strong>/);
  assert.match(html, /\$20B at a \$1\.25T valuation, down from \$30B at \$1\.4T, with only ~\$11B/);
  for(const text of ['$AAPL and $MSFT', '$AAPL/$MSFT', 'from $5 to $6', 'paid 5$ and 6$', 'https://a.test/?a=$b&c=$d']){
    assert.doesNotMatch(mdInline(text), /chat-math/, text);
  }
});

test('real formulas still render as math', async () => {
  const {mdInline} = await chatMarkdownHelpers();
  assert.match(mdInline('The area is $x^2$ here'), /chat-math-inline[^>]*>x<sup>2<\/sup>/);
  assert.match(mdInline('Use \\(2x + 1\\) now'), /chat-math-inline/);
  assert.match(mdInline('Costs $5 when $x$ is low'), /Costs \$5 when <span class="chat-math/);
});

test('markdown links render as a link showing only their label', async () => {
  const {mdInline} = await chatMarkdownHelpers();
  const url = 'https://www.cnbc.com/2026/10/31/openai-fundraising-20-billion-valuation.html';
  const html = mdInline(`([CNBC](${url}) · [WSJ](https://www.wsj.com/a_b_c))`);
  assert.match(html, new RegExp(`^\\(<a href="${url}"[^>]*data-chat-web-link[^>]*>CNBC</a> · <a href="https://www\\.wsj\\.com/a_b_c"[^>]*>WSJ</a>\\)$`));
  assert.doesNotMatch(html, /\]\(/);

  // Bold may wrap a link, and a label may be formatted or be the URL itself.
  assert.match(mdInline('**See [CNBC](https://a.test/x) now**'), /<strong>See <a [^>]*>CNBC<\/a> now<\/strong>/);
  assert.match(mdInline('[**CNBC**](https://a.test/x)'), /<a [^>]*><strong>CNBC<\/strong><\/a>/);
  assert.equal((mdInline('[https://a.test/x](https://a.test/x)').match(/<a /g) || []).length, 1);
  assert.match(mdInline('[Paren](https://a.test/x_(y))'), /href="https:\/\/a\.test\/x_\(y\)"/);
  assert.match(mdInline('[Cost](https://a.test/$a) and [b](https://a.test/$b)'), /<a [^>]*>Cost<\/a> and <a [^>]*>b<\/a>/);
});

test('markdown links cannot smuggle a script address or markup', async () => {
  const {mdInline} = await chatMarkdownHelpers();
  assert.doesNotMatch(mdInline('[click](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(mdInline('[click](file:///etc/passwd)'), /<a /);
  const html = mdInline('[<img src=x onerror=alert(1)>](https://a.test/x)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(mdInline('`[a](https://a.test/x)`'), /^<code>\[a\]\(https:\/\/a\.test\/x\)<\/code>$/);
});

test('a preview cut mid-span leaves no stray markdown behind', async () => {
  const {chatMessagePreview, mdInline} = await chatMarkdownHelpers();
  const cut = (text, words) => chatMessagePreview(text, words);
  assert.equal(cut('- **Marvell bets $115B on optical AI plumbing.** More text', 2), '- **Marvell**…');
  assert.equal(cut('Run `npm test now` please', 2), 'Run `npm`…');
  assert.equal(cut('Read it ([Search Engine Journal](https://a.test/x)) today', 3), 'Read it…');
  assert.equal(cut('Read it ([CNBC](https://a.test/x)) today', 3), 'Read it ([CNBC](https://a.test/x))…');
  assert.equal(cut('Try *really hard* today', 2), 'Try really…');
  assert.equal(cut('Finished **bold** then more words', 2), 'Finished **bold**…');
  assert.equal(cut('Short message', 5), 'Short message');
  assert.match(mdInline(cut('- **Marvell bets big** ok', 2).slice(2)), /^<strong>Marvell<\/strong>…$/);
});

test('a preview never cuts a table or a code block in half', async () => {
  const {chatMessagePreview} = await chatMarkdownHelpers();
  const mdLite = await chatMdLite();
  const table = '| Company | Contact | Size | Note |\n|---|---|---|---|\n' +
    '| Brightfold | Nora Vance | 11-50 | Hiring two ops roles |\n' +
    '| Tallowick | Ravi Ostrand | 51-200 | Asked for workflow help |\n' +
    '| Quillmere | Dana Holt | 11-50 | Reports by hand weekly |';
  const text = 'Here is the shortlist.\n\n' + table + '\n\nMore words follow here.';
  const words = n => text.split(/\s+/).slice(0, n).join(' ').split(/\s+/).length;
  for (let n = 4; n < words(200) - 4; n++) {
    const cut = chatMessagePreview(text, n);
    const html = mdLite(cut);
    assert.ok(tagsBalanced(html), html);
    assert.doesNotMatch(html.replace(/<table[\s\S]*<\/table>/, ''), /\|/, `no raw pipes outside the table at ${n} words: ${cut}`);
    if (/\| Company/.test(cut)) assert.match(html, /<table[\s\S]*Brightfold[\s\S]*<\/table>/, 'a cut table keeps its first row');
    assert.match(cut, /…$/);
  }
  // A cut mid-row keeps only whole rows, and the "…" stands on its own line.
  const midRow = chatMessagePreview(text, 32);
  assert.match(midRow, /\| Brightfold [^\n]*\|\n\n…$|\| Tallowick [^\n]*\|\n\n…$/);

  const code = 'Run this:\n\n```\nnpm install\nnpm run build --watch\nnpm test\n```\n\nThen check the output.';
  const codeCut = chatMessagePreview(code, 6);
  assert.equal(codeCut, 'Run this:\n\n```\nnpm install\n```\n\n…');
  assert.match(mdLite(codeCut), /<pre class="chat-md-code"><code>npm install<\/code><\/pre><p[^>]*>…<\/p>/);
  assert.equal(chatMessagePreview(code, 3), 'Run this:\n\n…', 'a cut on the opening fence drops the block');
});

test('Show less sits under the expanded message, where Show more sat', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const html = app.slice(app.indexOf('  function chatExpandableMessageHtml('), app.indexOf('  function syncChatCompactPreviewVisibility('));
  assert.match(html, /previewHtml \+ '<\/div>' \+ full \+ toggle;/);
});

test('table cells wrap between words instead of forcing a sideways scroll', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = styles.match(/\.chat-md-table th,\.chat-md-table td\{[^}]*\}/);
  assert.ok(rule, 'table cell rule is available');
  assert.match(rule[0], /white-space:normal;/);
  assert.match(rule[0], /overflow-wrap:normal;/, 'a cell never breaks inside a word');
  assert.match(styles, /\.chat-md-table\{[^}]*overflow-x:auto;/, 'a table that truly cannot fit still scrolls');
});

test('a chat link wraps between words, so a short label never splits mid-word', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = styles.match(/\.chat-msg-text a\{[^}]*\}/);
  assert.ok(rule, 'chat link rule is available');
  assert.doesNotMatch(rule[0], /break-all/);
  // The bubble's own wrap rule still keeps a long bare URL inside it.
  assert.match(styles, /\.chat-msg-text\{[^}]*overflow-wrap:anywhere;/);
});

test('the composer only suggests a reply\'s next step once a chat has messages', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source + html, /newsletter (agent|bot)\?/, 'no fixed suggestion is left');
  const start = source.indexOf('function chatInlineSuggestionText(){');
  const body = source.slice(start, source.indexOf('function updateChatSuggestions', start));
  assert.match(body, /var nextStep = chatReplyNextStep\(roomId\);\n\s+if\(nextStep\) return nextStep;/);
  assert.match(body, /return '';\n\s+\}\n\s*$/);
  const sync = source.slice(source.indexOf('function syncInlineChatSuggestion(){'), source.indexOf('// Detailed output includes'));
  assert.match(sync, /show = show && !!suggested;/, 'an empty suggestion hides the Tab hint');
});

test('a channel\'s placeholder steps aside while the Tab suggestion shows', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('function syncInlineChatSuggestion(){'), source.indexOf('// Detailed output includes'));
  assert.match(sync, /input\.classList\.toggle\('cc-input-suggesting', show\);/);
  assert.ok(styles.includes('.cc-input.cc-input-suggesting::placeholder{color:transparent;}'));
});

test('a direct message keeps the whole line when the chat gets narrow', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const inset = 'clamp(0px,calc((100% - 420px) * .5),28%)';
  assert.ok(styles.includes('.chat-msg-row.is-direct.is-you{padding-left:' + inset + ';}'));
  assert.ok(styles.includes('.chat-msg-row.is-direct:not(.is-you){padding-right:' + inset + ';}'));
  assert.match(styles, /\.chat-msg-row\.is-direct \.chat-msg-body\{flex:0 1 auto;max-width:max\(72%,420px\);\}/);
  // Same specificity as the desktop inset, so the phone width actually wins.
  assert.match(styles, /@media \(max-width:760px\)[\s\S]*\.chat-msg-row\.is-direct:not\(\.is-you\)\{padding-right:8%;\}/);
});

test('a narrow window only clips and fades a message that has a Show more', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const start = styles.indexOf('A 150-word preview is still too tall');
  const rule = styles.slice(start, styles.indexOf('mask-repeat:no-repeat;', start));
  assert.match(rule, /\.chat-expandable-preview\[data-chat-truncated\],/);
  assert.doesNotMatch(rule, /\.chat-expandable-preview,/, 'a short message has no Show more to reveal clipped text');
});

async function chatMdLite() {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const escape = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const start = source.indexOf('var BARE_URL_RE');
  const end = source.indexOf('\n  // Which human posted', start);
  assert.ok(start >= 0 && end > start, 'markdown renderer is available');
  return Function('esc', `${source.slice(start, end)}\nreturn mdLite;`)(escape);
}
// Every tag opened is closed in order, and no tag sits inside an attribute.
function tagsBalanced(html) {
  if (/="[^"]*<\/?[a-z]/.test(html)) return false;
  const stack = [];
  for (const [, close, tag] of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
    if (tag === 'br' || tag === 'hr') continue;
    if (!close) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

test('a bold web address is one bold link, and the bold closes', async () => {
  const mdLite = await chatMdLite();
  const html = mdLite('Also added **https://example.com/in/someone/** under requested-FDEs');
  assert.match(html, /<strong><a href="https:\/\/example\.com\/in\/someone\/" data-chat-web-link>https:\/\/example\.com\/in\/someone\/<\/a><\/strong>/);
  assert.ok(tagsBalanced(html), html);
  assert.match(mdLite('see _https://example.com/a_b_ now'), /<em><a href="https:\/\/example\.com\/a_b"/);
});

test('chat markdown never leaves a tag open for the messages after it', async () => {
  const mdLite = await chatMdLite();
  const parts = ['\n', '- ', '# ', '1. ', '| a |', '```', '<b>', '"', '&', '\\[', '\\]', '**', '*', '_', '`',
    'https://a.test/x_y', 'https://a.test/c', '(', ')', '$', '$x', '\\(', '\\)', '[l](https://a.test)', ' ', 'w', ' x ', '_{a}', '^{b}', ':', '.'];
  let seed = 7;
  const pick = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 20000; i++) {
    let text = '';
    for (let k = 2 + pick(7); k > 0; k--) text += parts[pick(parts.length)];
    const html = mdLite(text);
    assert.ok(tagsBalanced(html), `${JSON.stringify(text)} -> ${html}`);
  }
  for (const text of ['https://a.test/c**$x$', '$[l](https://a.test)$', 'https://a.test/c[l](https://a.test)', '**https://a.test/x/**']) {
    assert.ok(tagsBalanced(mdLite(text)), text);
  }
});

test('a view tip waits under a dialog opened while it is showing', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const tips = styles.match(/\.mia-tips\{[^}]*z-index:(\d+)/);
  const dialogs = styles.match(/\.app-prompt-overlay\{[^}]*z-index:(\d+)/);
  assert.ok(Number(tips[1]) > Number(dialogs[1]), 'tips draw above dialogs, so they must step aside');
  assert.ok(styles.includes('body:has(.app-prompt-overlay.open, .drawer-overlay.open, .styled-scrim.open) .mia-tips{visibility:hidden;}'));
});
