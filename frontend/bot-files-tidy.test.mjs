import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./bot-files-tidy.js');

test('the bot-file review lists every proposed entry and does not claim they are all bot-owned', () => {
  const html = globalThis.MiaBotFilesTidy.dialogHtml({
    count: 2,
    items: [
      { id: 'my-data.json', folder: false, contents: [] },
      { id: 'scraper', folder: true, contents: ['scraper/main.py', 'scraper/.hidden.txt'] },
    ],
  });
  assert.match(html, /my-data\.json/);
  assert.match(html, /scraper\/\.hidden\.txt/);
  assert.match(html, /Some may be files you made/);
  assert.match(html, /data-tidy-file/);
  assert.doesNotMatch(html, /your own files stay where they are/i);
});
