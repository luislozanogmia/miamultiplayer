import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the reaction button sits on the bubble border, lower-right on incoming and lower-left on your own', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-msg-row>\.chat-msg-body>\.chat-msg-text\{position:relative;\}/, 'measured from the bubble, not the whole row');
  assert.match(css, /\.chat-msg-text>\.chat-msg-react-add\{left:auto;right:-12px;bottom:-4px;/, 'incoming: centered on the right border');
  assert.match(css, /\.chat-msg-row\.is-you>\.chat-msg-body>\.chat-msg-text>\.chat-msg-react-add\{left:-12px;right:auto;\}/, 'your own: centered on the left border');
  assert.match(css, /\.chat-msg-row:hover>\.chat-msg-body>\.chat-msg-text>\.chat-msg-react-add/, 'still shows on row hover');
  assert.match(css, /\.chat-msg-text>:has\(\+\.chat-msg-react-add:last-child\)\{margin-bottom:0;\}/, 'last paragraph keeps no bottom margin');
  // Without a text bubble (media only) it stays beside the message body.
  assert.match(css, /\.chat-msg-react-add\{appearance:none;position:absolute;left:calc\(100% \+ 6px\);bottom:2px;/);
  assert.match(css, /\.chat-msg-row\.is-you>\.chat-msg-body>\.chat-msg-react-add\{left:auto;right:calc\(100% \+ 6px\);\}/);
});

test('the reaction button is rendered inside the text bubble when there is one', async () => {
  const js = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(js, /'">' \+ messageHtml \+ reactAddHtml \+ '<\/div>'/, 'inside the bubble');
  assert.match(js, /\(hasBubble \? '' : reactAddHtml\) \+ '<\/div><\/div>'/, 'on the body only without a bubble');
});
