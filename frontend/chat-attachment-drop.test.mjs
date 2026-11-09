import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

// The real staging code with the composer's state, checks and strip stubbed.
function stager({ team = false } = {}) {
  const env = { state: { file: null, app: null, previewUrl: null, busy: false, error: '', more: [], progress: '' }, renders: 0 };
  const code = slice('  var CHAT_ATTACHMENT_TYPES = ', '  function clearChatAttachmentError(){')
    + slice('  var CHAT_ATTACHMENT_MAX_FILES = ', '\n  // Images, PDFs, Office files')
    + 'return { stageChatAttachments };';
  const api = new Function('inHubRoom', 'URL', 'renderChatAttachment', 'stageChatAttachment', 'env',
    'var chatAttachment = env.state;' + code.replace(/chatAttachment\b(?!\w)/g, 'env.state'))(
    () => team, { createObjectURL: () => 'blob:x' }, () => { env.renders += 1; },
    (file) => { env.state.file = file; return true; }, env);
  return { env, ...api };
}
const file = (name, size = 100) => ({ name, size, type: '' });

test('dropped files go through the same checks: the good ones attach, the rest are named', () => {
  for (const team of [false, true]) {
    const { env, stageChatAttachments } = stager({ team });
    assert.equal(stageChatAttachments([file('leads.csv'), file('logo.png'), file('tool.exe'), file('notes.md')]), true);
    assert.equal(env.state.file.name, 'leads.csv', 'the first is sent with the text');
    assert.deepEqual(env.state.more.map((item) => item.file.name), ['logo.png', 'notes.md'], 'the others wait beside it');
    assert.equal(env.state.more[0].previewUrl, 'blob:x', 'an image gets its preview');
    assert.match(env.state.error, /^tool\.exe: Choose an image/);
  }
  const { env, stageChatAttachments } = stager();
  assert.equal(stageChatAttachments([file('a.exe'), file('b.zip')]), false, 'nothing attachable');
  assert.match(env.state.error, /^2 files can’t be attached\./);
  const big = stager({ team: true });
  big.stageChatAttachments([file('huge.pdf', 9 * 1024 * 1024)]);
  assert.match(big.env.state.error, /8 MB/, 'a company keeps its size limit');
  const many = stager();
  many.stageChatAttachments(Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`)));
  assert.equal(1 + many.env.state.more.length, 10);
  assert.match(many.env.state.error, /up to 10 files at once/);
});

test('the rest send one message each through the same upload, and a failure stays to retry', async () => {
  const fn = slice('      function sendMoreChatAttachments(items, roomId, number, total){', '      // Group tags reach many people at once');
  const run = async (failAt) => {
    const sent = [], env = { chatAttachment: {} };
    let call = 0;
    const send = new Function('env', 'prepareChatAttachment', 'sendActiveRoomMessage', 'renderChatAttachment', 'syncDraftState', 'URL',
      'var chatAttachment = env.chatAttachment;' + fn.replace(/chatAttachment\b(?!\w)/g, 'env.chatAttachment') + 'return sendMoreChatAttachments;')(
      env, (f) => Promise.resolve({ upload: f.name }),
      (text, _a, prepared) => { call += 1; if (call === failAt) return Promise.resolve({ status: 500, data: { error: 'Hub is down' } }); sent.push([text, prepared.upload]); return Promise.resolve({ status: 201 }); },
      () => {}, () => {}, { revokeObjectURL() {} });
    await send([{ file: { name: 'b.png' } }, { file: { name: 'c.md' } }, { file: { name: 'd.csv' } }], 'room', 2, 4);
    return { sent, state: env.chatAttachment };
  };
  const ok = await run(0);
  assert.deepEqual(ok.sent, [['', 'b.png'], ['', 'c.md'], ['', 'd.csv']], 'each file its own message, in order');
  assert.equal(ok.state.file, null);
  const failed = await run(2);
  assert.deepEqual(failed.sent, [['', 'b.png']]);
  assert.equal(failed.state.file.name, 'c.md', 'the failed file stays staged');
  assert.deepEqual(failed.state.more.map((item) => item.file.name), ['d.csv'], 'with the ones after it');
  assert.match(failed.state.error, /c\.md didn’t send: Hub is down\. Press Enter to try again\./);
  assert.equal(failed.state.busy, false);
});

test('the composer takes drops and the + picker takes several files', () => {
  assert.match(html, /id="ccFileInput" class="cc-file-input" multiple accept=/);
  assert.match(source, /composer\.addEventListener\('drop', function\(e\)\{[\s\S]*?if\(stageChatAttachments\(e\.dataTransfer\.files\)\) syncDraftState\(\);/);
  assert.match(source, /fileInput\.addEventListener\('change', function\(\)\{\s*if\(stageChatAttachments\(fileInput\.files\)\) syncDraftState\(\);/);
  assert.match(source, /if\(extras\.length\) return sendMoreChatAttachments\(extras, roomId, 2, extras\.length \+ 1\);/);
});
