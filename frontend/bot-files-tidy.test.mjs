import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./bot-files-tidy.js');
const tidy = globalThis.MiaBotFilesTidy;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('the card offers Mia\'s review with the real Motes, not a file checklist', () => {
  const html = tidy.dialogHtml({ count: 511 });
  assert.match(html, /Mia found 511 files she can analyze and organize for you/);
  assert.match(html, /The tidy-up starts only after Go ahead/);
  assert.match(html, />Let Mia look</);
  assert.match(html, /assets\/mote\/mote-static\.svg/);
  assert.match(html, /assets\/mote\/mote-research-static\.svg/);
  assert.doesNotMatch(html, /data-tidy-file/);
});

test('Mia\'s plan card moves only on Go ahead, and only the newest plan offers it', () => {
  const message = (tidyPlan, id = 'evt-1') => ({ nativeEvent: { id, metadata: { tidyPlan } } });
  const pending = { status: 'pending', move: ['a.py', 'b.json'], keep: ['notes.json'] };
  const html = tidy.planHtml(message(pending), { esc, latest: true });
  assert.match(html, /2 files will move into Mia's working files; 1 stays where it is/);
  assert.match(html, /data-tidy-plan="evt-1"/);
  assert.match(html, /data-tidy-plan-decision="go"[^>]*>Go ahead/);
  assert.match(tidy.planHtml(message(pending), { esc, latest: false }), /Mia updated this plan below/);
  assert.match(tidy.planHtml(message({ ...pending, status: 'accepted' }), { esc }), /Moving 2 files in the background/);
  assert.match(tidy.planHtml(message({ ...pending, status: 'done', moved: 2, skipped: 0 }), { esc }),
    /Done\. Moved 2 files into Mia's working files and left 1 where it was\. Nothing was deleted\./);
  assert.equal(tidy.planHtml({ nativeEvent: { id: 'x', metadata: {} } }, { esc, latest: true }), '');
});

test('the app opens Mia\'s chat for the review and posts Go ahead to her plan', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /reviewWithMia: reviewBotFilesWithMia/);
  assert.match(app, /\{botFilesTidy: \{count: count\}\}/);
  assert.match(app, /'\/api\/bot-files-tidy\/plans\/' \+ encodeURIComponent\(eventId\)/);
});
