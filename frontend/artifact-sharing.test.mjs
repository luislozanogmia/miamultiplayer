import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('images and PDFs attach everywhere; web pages only in Solo, since the team Hub refuses HTML', () => {
  const block = slice('  var CHAT_ATTACHMENT_TYPES', '  function stageChatAttachment(');
  const env = { team: true, hubWorkspace: () => env.team };
  const problem = new Function('env', `with (env) { ${block}; return chatAttachmentProblem; }`)(env);
  const mb = 1024 * 1024;
  assert.equal(problem({ type: 'application/pdf', size: mb }), '');
  assert.equal(problem({ type: 'image/png', size: mb }), '');
  assert.match(problem({ type: 'text/html', size: 10 }), /Web pages can.t be sent to a team/);
  assert.match(problem({ type: 'application/zip', size: 10 }), /image .* or a PDF/);
  assert.match(problem({ type: 'application/pdf', size: 9 * mb }), /8 MB/);
  env.team = false;
  assert.equal(problem({ type: 'text/html', size: 10 }), '');
  assert.equal(problem({ type: 'application/pdf', size: 9 * mb }), '');
  assert.match(problem({ type: 'application/pdf', size: 26 * mb }), /25 MB/);
});

test('the (+) Artifacts picker and the Artifacts page share button stage through one function', () => {
  const picker = slice('  function wireComposerPlusMenu(', '  function clearChatAttachment(');
  assert.match(picker, /stageArtifact\(item\)/);
  const share = slice('  function shareArtifact(', '  function setArtifactsAddOpen(');
  assert.match(share, /stageArtifact\(item\)/);
  const stage = slice('  function stageArtifact(', '  function fileAsBase64(');
  assert.match(stage, /item\.kind === 'app'\)\{ stageChatAppLink\(item\)/);
  assert.match(stage, /'\/api\/artifacts\/file\?id=' \+ encodeURIComponent\(item\.id\)/);
  assert.match(stage, /return stageChatAttachment\(new File\(/, 'artifact files reuse the upload checks and send path');
});

test('a shared local app shows the local app sharing note and sends its address', () => {
  const render = slice('  function renderChatAttachment(', '  // Images and PDFs go everywhere.');
  assert.match(render, /app && app\.local \?[\s\S]*Local app sharing[\s\S]*Changes aren.u2019t synced between you and your team yet\.[\s\S]*Shared editing is coming soon\./);
  assert.match(source, /if\(app\) text = \(text \? text \+ '\\n\\n' : ''\) \+ app\.name \+ ': ' \+ app\.url;/);
});
