import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);

test('roster, tile, and manage-agents Motes render interactive profile markup', async () => {
  const source = await readFile(appUrl, 'utf8');

  // Each of these call sites was diagnosed as missing profileInteractive
  // (the 6th agentAvatarHtml argument) — clicking the Mote there could not
  // open the agent panel. Assert each now passes `true`.
  assert.match(
    source,
    /agentAvatarHtml\(row\.name, row\.agentId, 24, null, null, true\)/,
    'chat roster row Mote is interactive'
  );
  assert.match(
    source,
    /agentAvatarHtml\(agent\.name, agent\.id, 38, null, null, true\)/,
    'manage-agents row Mote is interactive'
  );
  assert.match(
    source,
    /agentAvatarHtml\(entry\.label, entry\.id, 22\)/,
    'mention popover Mote stays non-interactive so clicking it inserts the @-mention'
  );
  assert.match(
    source,
    /agentAvatarHtml\(member\.name, member\.id, 27, null, null, true\)/,
    'channel member stack Mote is interactive'
  );
  assert.match(
    source,
    /agentAvatarHtml\(e\.name, e\.agent && e\.agent\.id, 40, null, null, true\)/,
    'DM sidebar tile Mote is interactive'
  );

  // agentAvatarHtml only emits role="button"/tabindex/data-agent-profile-id
  // when profileInteractive is truthy — this is the mechanism the assertions
  // above rely on.
  assert.match(
    source,
    /if\(profileInteractive && profileRef\) profileAttrs \+= ' role="button" tabindex="0"/
  );
});

test('the delegated profile-open listener is bound on document in the capture phase', async () => {
  const source = await readFile(appUrl, 'utf8');

  // A single document-level, capture-phase binding covers every surface
  // (including Motes nested inside another clickable row, like the
  // manage-agents row and chat roster row) without needing a listener per
  // container and without double-firing on rows that already handle clicks.
  assert.match(source, /bind\(document, true\);/);
  assert.doesNotMatch(source, /bind\(el\('#chatThread'\)\)/);
});

test('the compact Mote profile editor renders and persists the agent color picker', async () => {
  const source = await readFile(appUrl, 'utf8');
  const html = await readFile(htmlUrl, 'utf8');

  assert.match(
    source,
    /function styledAgentEditMarkup\(a\)\{[\s\S]{0,2000}agentColorSwatchesHtml\(editState\.avatarColor, 'styledAgentEditColorInput', 'styled-agent-color'\)/,
    'the compact editor paints the swatch picker for the open bot'
  );
  assert.match(source, /function agentColorSwatchesHtml\(currentColor, colorInputId, classPrefix\)/);
  assert.match(source, /id="styledAgentEditColorOptions"/);
  assert.doesNotMatch(html, /id="benchDetailColorOptions"/);
  // Saves through the compact editor's existing bot update endpoint.
  assert.match(
    source,
    /api\('\/api\/bots\/' \+ targetId, \{method:'PUT', body:\{name: name, instructions: instructions, model: model, departments: departments, avatarColor: editState\.avatarColor \|\| null\}\}\)/
  );
});
