'use strict';

// Mia opens the bot setup card by ending a reply in her own chat with one
// <MIA_BOT_SETUP>{json}</MIA_BOT_SETUP> block. Mia's model decides when the
// user wants a new bot; no keyword rule does. The block only opens the
// editable setup card: nothing is created until the user accepts it.

const SCHEMA_VERSION = 1;
const TAG = /<MIA_BOT_SETUP>([\s\S]*?)<\/MIA_BOT_SETUP>/gi;
const MAX_REQUEST = 2000;

function stripBotSetupBlocks(text) {
  let clean = String(text || '').replace(TAG, '');
  const unclosed = clean.search(/<MIA_BOT_SETUP>/i);
  if (unclosed >= 0) clean = clean.slice(0, unclosed);
  return clean.replace(/<\/?MIA_BOT_SETUP>/gi, '').trim();
}

// -> { text, request, error }. text never contains the block; request is
// { request } with the user's bot request restated by Mia.
function extractBotSetupRequest(text) {
  const source = String(text || '');
  const clean = stripBotSetupBlocks(source);
  const matches = [...source.matchAll(TAG)];
  if (source.replace(TAG, '').match(/<\/?MIA_BOT_SETUP>/gi)) return { text: clean, request: null, error: 'malformed_block' };
  if (!matches.length) return { text: clean, request: null, error: null };
  if (matches.length > 1) return { text: clean, request: null, error: 'multiple_requests' };
  let parsed;
  try { parsed = JSON.parse(matches[0][1]); } catch (_) { return { text: clean, request: null, error: 'invalid_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text: clean, request: null, error: 'invalid_json' };
  if (parsed.schemaVersion !== SCHEMA_VERSION) return { text: clean, request: null, error: 'unsupported_schema' };
  const request = String(parsed.request || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST);
  if (!request) return { text: clean, request: null, error: 'missing_request' };
  return { text: clean, request: { request }, error: null };
}

function botSetupInstruction() {
  return [
    'Bot setup (authoritative):',
    'When the user asks you to create a new bot (also called an agent), open the setup card instead of creating it yourself or running miaos-bot. Decide from what the user means, not from particular words; a question about how bots work is not a request to create one.',
    'If you do not yet know what the bot should do, ask in plain words first and do not add the block.',
    'Once you know, end your reply with exactly one block and say in one short sentence that the draft is below for them to review:',
    '<MIA_BOT_SETUP>{"schemaVersion":1,"request":"A bot that finds the top five AI stories and posts them here every weekday at 8:00"}</MIA_BOT_SETUP>',
    '- request: what the bot should do and produce, in the user\'s words, including any schedule they asked for. Do not add a schedule they did not ask for.',
    'Nothing is created until the user accepts the card, so do not say the bot exists.',
  ].join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  botSetupInstruction,
  extractBotSetupRequest,
  stripBotSetupBlocks,
};
