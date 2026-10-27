import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const header = source.slice(source.indexOf('  function renderChatHeaderBar(){'), source.indexOf("    if(!chatWs.activeRoomId){ resetChannelMenuState();"));

test('a shared channel header has the vertical dots menu from the sidebar', () => {
  assert.match(header, /id="hubChannelMoreBtn"[^>]*aria-haspopup="menu"/);
  assert.match(header, /cx="12" cy="5"[\s\S]*cx="12" cy="19"/, 'dots are vertical');
  assert.match(header, /openHubChannelMenu\(channel,/, 'opens the same menu as right-click');
});
