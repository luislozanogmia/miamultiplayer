import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import emoji from './emoji-picker.js';

const esc = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

test('search matches names and hides empty groups', () => {
  assert.deepEqual(emoji.search('rocket').map(group => group.items.map(item => item[0])), [['🚀']]);
  assert.deepEqual(emoji.search('nothing-like-this'), []);
  assert.match(emoji.listHtml('nothing-like-this', [], esc), /Nothing matches/);
});

test('recent emoji come first, without repeats, and hide while searching', () => {
  assert.deepEqual(emoji.remember(['🔥', '👍'], '👍'), ['👍', '🔥']);
  assert.match(emoji.listHtml('', ['🔥', 'not-in-the-list'], esc), /^<div class="mia-emoji-title">Recent<\/div><div class="mia-emoji-grid"><button type="button" data-emoji-pick="🔥"[^>]*>🔥<\/button><\/div>/);
  assert.doesNotMatch(emoji.listHtml('fire', ['🔥'], esc), /Recent/);
});

test('reaction chips show the count, mark your own and can be read-only', () => {
  const html = emoji.reactionsHtml({ '👍': ['you@example.test', 'b'], '🔥': ['b'], '🎉': [] }, 'you@example.test', esc, true);
  assert.match(html, /chat-msg-reaction on" data-react-toggle="👍" aria-pressed="true"/);
  assert.match(html, /<em>2<\/em>/);
  assert.match(html, /data-react-toggle="🔥" aria-pressed="false"/);
  assert.doesNotMatch(html, /🎉/);
  assert.match(emoji.reactionsHtml({ '👍': ['b'] }, 'a', esc, false), /disabled/);
  assert.equal(emoji.reactionsHtml({}, 'a', esc, true), '');
});

test('the message box has the emoji button and the picker loads before the app', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ccEmojiBtn"/);
  assert.ok(html.indexOf('emoji-picker.js') < html.indexOf('src="app.js'));
});

test('the picker has every emoji, popular ones first, each once', () => {
  assert.equal(emoji.GROUPS[0].title, 'Popular');
  const all = emoji.GROUPS.flatMap(group => group.items.map(item => item[0]));
  assert.ok(all.length > 1800, 'the whole Unicode set, not a hand-picked few');
  assert.equal(new Set(all).size, all.length, 'no emoji shows twice');
  assert.ok(all.includes('💥') && all.includes('🫠') && all.includes('🇲🇽'));
  assert.ok(!all.some(item => /[\u{1F3FB}-\u{1F3FF}]/u.test(item)), 'skin tones left out');
  assert.deepEqual(emoji.search('boom')[0].items[0], ['💥', 'collision boom explosion bang kaboom'], 'found by the word people use');
  assert.match(emoji.search('fire')[0].items.map(item => item[1]).join(' '), /fire hot great/, 'popular picks keep their own words');
});

test('emoji fall back to a font that ships with Mia', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /font-family:"Mia Emoji";[^}]*local\("Apple Color Emoji"\),local\("Segoe UI Emoji"\),local\("Noto Color Emoji"\),url\("assets\/fonts\/NotoColorEmoji\.ttf"\)/);
  assert.ok(fs.statSync(new URL('./assets/fonts/NotoColorEmoji.ttf', import.meta.url)).size > 1000000);
  for (const name of ['--sans', '--mono', '--styled-sans']) assert.match(css, new RegExp(name + ':[^;]*"Mia Emoji";'));
  assert.match(css, /\.mia-emoji-grid button\{[^}]*font-family:var\(--styled-sans\)/);
  assert.match(css, /\.chat-msg-reaction\{[^}]*font-family:var\(--styled-sans\)/);
});
