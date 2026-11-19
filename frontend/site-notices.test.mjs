import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const notices = require('./site-notices.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
function notice(id, text, { origin = 'https://web.whatsapp.com', icon = PNG, ts = 1000 } = {}) {
  return { id, system: true, body: text, ts, nativeEvent: { metadata: { siteNotification: { origin, icon } } } };
}

test('a notification shows the site icon with Mia\'s dot and no emoji', () => {
  const html = notices.noticeHtml(notice('e1', 'Notification from web.whatsapp.com\nAna\nHola'));
  assert.match(html, /<img class="site-notice-site" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(html, /site-notice-pip/);
  assert.match(html, /<b>WhatsApp<\/b> · notification from web\.whatsapp\.com/);
  assert.match(html, /site-notice-title">Ana<\/span> <span class="site-notice-body">Hola/);
  assert.doesNotMatch(html, /\u{1F514}/u);
});

test('an older row written with the bell reads the same', () => {
  const parsed = notices.parse(notice('e1', '\u{1F514} Notification from web.whatsapp.com\nAna\nHola'));
  assert.deepEqual(parsed, { title: 'Ana', body: 'Hola' });
});

test('a site without an inline image gets the Mia mark, never a loaded address', () => {
  for (const icon of ['', 'https://evil.example/x.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,"onerror="x']) {
    const html = notices.noticeHtml(notice('e1', 'Notification from a.test\nT\nB', { origin: 'https://a.test', icon }));
    assert.doesNotMatch(html, /<img/, icon);
    assert.match(html, /site-notice-mia/);
  }
});

test('page text is escaped', () => {
  const html = notices.noticeHtml(notice('e1', 'Notification from a.test\n<img src=x onerror=alert(1)>\n<b>hi</b>', { origin: 'https://a.test' }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
});

test('notices in a row from one site fold into one line; others stay apart', () => {
  const other = { id: 'm', system: false, body: 'hello', ts: 5 };
  const list = [
    notice('a', 'Notification from web.whatsapp.com\nAna\n1'),
    notice('b', 'Notification from web.whatsapp.com\nPat\n2'),
    notice('c', 'Notification from web.whatsapp.com\nAna\n3'),
    other,
    notice('d', 'Notification from web.whatsapp.com\nAna\n4'),
    notice('e', 'Notification from mail.google.com\nBo\n5', { origin: 'https://mail.google.com' }),
  ];
  const out = notices.groupNotices(list);
  assert.equal(out.length, 4);
  assert.equal(out[0].siteNotices, true);
  assert.deepEqual(out[0].items.map((m) => m.id), ['a', 'b', 'c']);
  assert.equal(out[1], other);
  assert.equal(out[2].id, 'd');
  assert.equal(out[3].id, 'e');
  const html = notices.groupHtml(out[0]);
  assert.match(html, /<details class="chat-msg-system site-notice-group"/);
  assert.match(html, /3 new<\/span> <span class="site-notice-body">from Ana, Pat/);
  assert.match(html, /site-notice-count">3</);
  assert.equal((html.match(/site-notice-item/g) || []).length, 3);
});

test('"Stopped by you" gets the stop square, with or without the old emoji', () => {
  for (const text of ['Stopped by you — the bot was mid-response.', '\u23F9 Stopped by you — the bot was mid-response.']) {
    assert.equal(notices.stoppedText(text), 'Stopped by you — the bot was mid-response.');
    const html = notices.stoppedHtml(text);
    assert.match(html, /chat-stopped-icon/);
    assert.doesNotMatch(html, /\u23F9/);
  }
  assert.match(notices.stoppedHtml('Stopped when Mia closed — the bot was mid-response.\nWhere it left off: x'), /<br>Where it left off/);
  assert.equal(notices.stoppedText('I stopped to think'), '');
});
