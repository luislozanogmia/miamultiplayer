'use strict';

// The one-time "bots now share what they learn" card: whether this person
// has answered it on this computer. Yes has each of their bots that keeps a
// company memory add what it learned working with them (frontend/bot-memory-intro.js).

const fs = require('fs');
const path = require('path');

const ANSWERS = new Set(['accepted', 'declined']);

function readState(stateFile) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state && ANSWERS.has(state.state) ? state : {};
  } catch (_) {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

// The card's answer, kept once: a second answer never replaces the first.
function answer(stateFile, accept, now = Date.now()) {
  const current = readState(stateFile);
  if (current.state) return current.state;
  const state = accept ? 'accepted' : 'declined';
  writeState(stateFile, { state, at: now });
  return state;
}

module.exports = { readState, answer };
