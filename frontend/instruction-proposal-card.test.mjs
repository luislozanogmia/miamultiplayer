import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const card = require('./instruction-proposal-card.js');
const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const message = proposal => ({ nativeEvent: { id: 'event-1', metadata: { instructionProposal: proposal } } });

test('the owner sees the complete escaped replacement and explicit choices', () => {
  const instructions = 'Help with reports.\nNever send <secret> & keep records.';
  const html = card.html(message({ botId: 'bot-1', status: 'pending', instructions }), { esc, canEdit: true });
  assert.match(html, /data-instruction-proposal="event-1"/);
  assert.match(html, /Help with reports\.\nNever send &lt;secret&gt; &amp; keep records\./);
  assert.doesNotMatch(html, /<secret>/);
  assert.match(html, /data-instruction-decision="accept"/);
  assert.match(html, /data-instruction-decision="dismiss"/);
  assert.match(html, /Nothing changes until you accept/);
});

test('a non-owner cannot see action buttons or the proposed instructions', () => {
  const html = card.html(message({ botId: 'bot-1', status: 'pending', instructions: 'Private draft' }), { esc, canEdit: false });
  assert.match(html, /Waiting for the bot owner/);
  assert.doesNotMatch(html, /data-instruction-decision|Private draft/);
});

test('busy, error, and answered states cannot invite a second save', () => {
  const pending = { botId: 'bot-1', status: 'pending', instructions: 'New purpose' };
  const busy = card.html(message(pending), { esc, canEdit: true, busy: true, error: '<retry>' });
  assert.match(busy, /data-instruction-decision="accept" disabled/);
  assert.match(busy, /&lt;retry&gt;/);
  for (const status of ['accepted', 'dismissed', 'stale']) {
    const html = card.html(message({ ...pending, status }), { esc, canEdit: true });
    assert.match(html, /data-instruction-status/);
    assert.doesNotMatch(html, /data-instruction-decision/);
  }
  assert.equal(card.html(message({ botId: 'bot-1', status: 'pending' }), { esc, canEdit: true }), '');
});
