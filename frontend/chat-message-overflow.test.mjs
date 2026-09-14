import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function declarations(source, selector){
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule exists`);
  return match[1];
}

test('chat and automation messages cannot widen their pane', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  const thread = declarations(source, '.chat-thread');
  assert.match(thread, /min-width:0;/);
  assert.match(thread, /max-width:100%;/);
  assert.match(thread, /overflow-x:hidden;/);

  const row = declarations(source, '.chat-msg-row');
  assert.match(row, /min-width:0;/);
  assert.match(row, /max-width:100%;/);

  const body = declarations(source, '.chat-msg-body');
  assert.match(body, /min-width:0;/);
  assert.match(body, /max-width:100%;/);

  const text = declarations(source, '.chat-msg-text');
  assert.match(text, /min-width:0;/);
  assert.match(text, /overflow-wrap:anywhere;/);
  assert.match(text, /user-select:text;/);

  const expandable = declarations(source, '.chat-pre-reasoning-preview,.chat-expandable-preview,.chat-pre-reasoning-full,.chat-expandable-full');
  assert.match(expandable, /min-width:0;/);
  assert.match(expandable, /max-width:100%;/);
  assert.match(expandable, /overflow-wrap:anywhere;/);

  const pre = declarations(source, '.chat-msg-text pre');
  assert.match(pre, /max-width:100%;/);
  assert.match(pre, /overflow-x:auto;/);
  assert.match(pre, /white-space:pre;/);

  const table = declarations(source, '.chat-md-table');
  assert.match(table, /width:100%;/);
  assert.match(table, /max-width:100%;/);
  assert.match(table, /overflow-x:auto;/);

  const file = declarations(source, '.chat-msg-file');
  assert.match(file, /min-width:0;/);
  assert.match(file, /max-width:100%;/);

  const fileLink = declarations(source, '.chat-msg-file a');
  assert.match(fileLink, /max-width:min\(100%,520px\);/);
  assert.match(fileLink, /overflow-wrap:anywhere;/);

  const attachmentName = declarations(source, '.cc-attach-name');
  assert.match(attachmentName, /min-width:0;/);

  const composer = declarations(source, '.chat-composer-wrap');
  assert.match(composer, /flex:0 0 auto;/);
});
