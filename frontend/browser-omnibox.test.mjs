import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const omnibox = require('./browser-omnibox.js');

const NOW = Date.UTC(2026, 9, 19);
const DAY = 86400000;
const ICON = 'data:image/png;base64,AQID';
const linkedinHistory = [
  { url: 'https://www.linkedin.com/me/profile-views/', title: 'Profile Viewers | LinkedIn', count: 2, lastVisit: NOW - 1000, icon: ICON },
  { url: 'https://www.linkedin.com/feed/', title: 'Feed | LinkedIn', count: 9, lastVisit: NOW - DAY, icon: ICON },
  { url: 'https://www.linkedin.com/', title: 'Feed | LinkedIn', count: 4, lastVisit: NOW - 2 * DAY, icon: ICON },
  { url: 'https://www.linkedin.com/in/someone/', title: 'Someone | LinkedIn', count: 1, lastVisit: NOW - 5 * DAY, icon: ICON },
  { url: 'https://example.com/linked-lists', title: 'Linked lists explained', count: 1, lastVisit: NOW - 3 * DAY, icon: '' },
];

test('typing a site name completes it inline and Enter opens that site first', () => {
  const result = omnibox.suggest(linkedinHistory, 'linked', { now: NOW });
  assert.equal(result.completion.display, 'linkedin.com');
  assert.equal(result.completion.remainder, 'in.com');
  assert.equal(result.completion.url, 'https://www.linkedin.com/');
  assert.equal(result.completion.icon, ICON);
  const go = result.rows[0];
  assert.equal(go.go, true, 'the first row is what Enter opens');
  assert.equal(go.kind, 'url');
  assert.equal(go.url, 'https://www.linkedin.com/');
  assert.equal(result.rows[1].kind, 'search', 'a search for the typed words follows');
  assert.equal(result.rows[1].query, 'linked');
});

test('the same page and same-titled pages show once, and the site leads the ranking', () => {
  const { rows } = omnibox.suggest(linkedinHistory, 'linked', { now: NOW });
  const titles = rows.map(row => row.title || row.query);
  assert.equal(titles.filter(title => title === 'Feed | LinkedIn').length, 1, 'linkedin.com and /feed are one row');
  const history = rows.filter(row => row.kind === 'history').map(row => row.display);
  assert.ok(!history.includes('linkedin.com'), 'the completed site is not repeated below');
  assert.equal(history[0], 'linkedin.com/me/profile-views', 'address matches outrank title-only matches');
  assert.equal(history.at(-1), 'example.com/linked-lists', 'a title-word match ranks after address matches');
});

test('rows show short addresses, carry site icons, and stop at eight', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    url: `https://docs.example.com/page-${i}/`, title: `Docs page ${i}`, count: 1, lastVisit: NOW - i * 1000, icon: ICON,
  }));
  const { rows } = omnibox.suggest(many, 'docs', { now: NOW });
  assert.equal(rows.length, omnibox.MAX_ROWS);
  const row = rows.find(item => item.kind === 'history');
  assert.match(row.display, /^docs\.example\.com\/page-\d+$/);
  assert.equal(row.icon, ICON);
});

test('a frequently visited page beats a page seen once, at the same match strength', () => {
  const history = [
    { url: 'https://news.example/a', title: 'Rare', count: 1, lastVisit: NOW },
    { url: 'https://news.example/b', title: 'Daily', count: 30, lastVisit: NOW - DAY },
  ];
  const rows = omnibox.suggest(history, 'news.example/', { now: NOW, complete: false }).rows.filter(row => row.kind === 'history');
  assert.deepEqual(rows.map(row => row.title), ['Daily', 'Rare']);
});

test('typing past the site name completes to a page; spaces and deletes never complete', () => {
  const page = omnibox.suggest(linkedinHistory, 'linkedin.com/fe', { now: NOW }).completion;
  assert.equal(page.display, 'linkedin.com/feed');
  assert.equal(page.remainder, 'ed');
  assert.equal(omnibox.suggest(linkedinHistory, 'linked in', { now: NOW }).completion, null);
  assert.equal(omnibox.suggest(linkedinHistory, 'linked', { now: NOW, complete: false }).completion, null);
  const typedScheme = omnibox.suggest(linkedinHistory, 'https://www.link', { now: NOW }).completion;
  assert.equal(typedScheme.remainder, 'edin.com', 'a typed https://www. prefix still completes');
});

test('with no history match, the first row is the search or the typed address', () => {
  const search = omnibox.suggest([], 'weather today', { now: NOW });
  assert.deepEqual(search.rows, [{ kind: 'search', query: 'weather today', go: true }]);
  const address = omnibox.suggest([], 'new.example', { now: NOW });
  assert.equal(address.rows[0].kind, 'url');
  assert.equal(address.rows[0].value, 'new.example');
  assert.equal(omnibox.suggest(linkedinHistory, '   ', { now: NOW }).rows.length, 0);
});

test('a site without a visited home page still completes to its home page', () => {
  const history = [{ url: 'https://www.github.com/anthropics/repo', title: 'repo', count: 3, lastVisit: NOW }];
  const completion = omnibox.suggest(history, 'git', { now: NOW }).completion;
  assert.equal(completion.display, 'github.com');
  assert.equal(completion.url, 'https://www.github.com/');
});

test('non-web history entries are ignored', () => {
  const rows = omnibox.suggest([{ url: 'file:///etc/passwd', title: 'passwd' }, { url: 'javascript:alert(1)', title: 'x' }], 'pass', { now: NOW }).rows;
  assert.deepEqual(rows.map(row => row.kind), ['search']);
});

test('typed words are bolded where they start a word in titles and addresses', () => {
  assert.deepEqual(omnibox.highlight('Feed | LinkedIn', 'linked'), [
    { text: 'Feed | ', match: false }, { text: 'Linked', match: true }, { text: 'In', match: false },
  ]);
  assert.deepEqual(omnibox.highlight('linkedin.com/feed', 'feed'), [
    { text: 'linkedin.com/', match: false }, { text: 'feed', match: true },
  ]);
  assert.deepEqual(omnibox.highlight('example', 'amp'), [
    { text: 'ex', match: false }, { text: 'amp', match: true }, { text: 'le', match: false },
  ], 'a mid-word match is bolded only when no word starts with it');
  assert.deepEqual(omnibox.highlight('plain', ''), [{ text: 'plain', match: false }]);
});

test('displayUrl drops the scheme, www., trailing slash and fragment', () => {
  assert.equal(omnibox.displayUrl('https://www.linkedin.com/feed/?a=1#top'), 'linkedin.com/feed?a=1');
  assert.equal(omnibox.displayUrl('http://localhost:3000/'), 'localhost:3000');
});

test('explicit HTTP or HTTPS survives completion and the first Enter destination', () => {
  for (const [visited, typed] of [
    ['http://example.com/', 'https://exa'],
    ['http://example.com/', 'https://example.com'],
    ['http://example.com/', 'https://www.exa'],
    ['http://example.com/path', 'https://example.com/pa'],
    ['https://example.com/', 'http://exa'],
  ]) {
    const result = omnibox.suggest([{url: visited, count: 3, lastVisit: NOW}], typed, {now: NOW});
    assert.ok(result.completion);
    const visible = typed + result.completion.remainder;
    assert.equal(result.completion.url, new URL(visible).href);
    assert.equal(result.rows[0].url, new URL(visible).href, 'Enter must open the address shown in the field');
  }
});

test('everywhere search groups results and leads with what you are doing', () => {
  const sources = {
    browser: [{ kind: 'url', display: 'linkedin.com/in/example-person', go: true }, { kind: 'search', query: 'lin' }],
    people: [{ kind: 'human', id: 'lina@example.com', name: 'Lina', sub: 'lina@example.com' }, { kind: 'agent', id: 'b1', name: 'Sales', sub: 'Bot' }],
    chats: [{ roomId: 'r1', name: 'LinkedIn outreach' }, { roomId: 'r2', name: 'general' }],
    automations: [{ botId: 'b1', automationId: 'a1', name: 'Morning briefing', botName: 'Sales', steps: ['Open LinkedIn', 'Summarize'] }],
  };
  const keys = groups => groups.map(group => group.key);
  assert.deepEqual(keys(omnibox.everywhere('lin', sources, { view: null })), ['browser', 'chat', 'automations'], 'mixed tabs: browser, chat, automation');
  assert.deepEqual(keys(omnibox.everywhere('lin', sources, { view: 'chat' })), ['chat', 'browser', 'automations']);
  assert.deepEqual(keys(omnibox.everywhere('lin', sources, { view: 'automations' })), ['automations', 'browser', 'chat']);
  const chat = omnibox.everywhere('lin', sources, { view: 'chat' })[0];
  assert.deepEqual(chat.parts.map(part => part.label), ['People', 'Chat history']);
  assert.equal(chat.parts[0].rows[0].target.name, 'Lina');
  assert.equal(chat.parts[1].rows[0].target.roomId, 'r1');
  const automation = omnibox.everywhere('linkedin', sources, { view: 'automations' })[0];
  assert.deepEqual(automation.parts.map(part => part.label), ['Steps'], 'a step matches even when the name does not');
  assert.equal(automation.parts[0].rows[0].number, 1);
  assert.deepEqual(keys(omnibox.everywhere('zzz', { browser: [] }, { view: 'chat' })), [], 'empty groups are left out');
});

test('the open chat answers first with its own matching messages', () => {
  const long = 'Earlier we talked about lunch plans and the weekly sync, then decided the LinkedIn post goes out Friday';
  const sources = {
    browser: [],
    people: [{ kind: 'human', id: 'lina@example.com', name: 'Lina', sub: 'lina@example.com' }],
    chats: [],
    current: { name: 'general', messages: [{ id: 'm2', text: long, author: 'Lina' }, { id: 'm1', text: 'nothing here', author: 'You' }] },
  };
  const chat = omnibox.everywhere('linkedin', sources, { view: 'chat' })[0];
  assert.equal(chat.parts[0].label, 'In general');
  assert.equal(chat.parts[0].rows.length, 1, 'only matching messages');
  const row = chat.parts[0].rows[0];
  assert.equal(row.kind, 'message');
  assert.equal(row.target.id, 'm2');
  assert.ok(row.text.startsWith('…') && row.text.includes('LinkedIn'), 'a long message is cut to show the match');
  assert.deepEqual(omnibox.everywhere('lina', { ...sources, current: null }, { view: 'chat' })[0].parts.map(part => part.label), ['People'], 'no open chat, no part');
});
