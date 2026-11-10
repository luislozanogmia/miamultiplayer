import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the reaction button sits right beside the bubble, after incoming and before your own', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-msg-react-add\{appearance:none;position:absolute;left:calc\(100% \+ 6px\);bottom:2px;/);
  assert.match(css, /\.chat-msg-row>\.chat-msg-body\{position:relative;\}/, 'measured from the bubble, not the whole row');
  assert.match(css, /\.chat-msg-row\.is-you>\.chat-msg-body>\.chat-msg-react-add\{left:auto;right:calc\(100% \+ 6px\);\}/);
});
