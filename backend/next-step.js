'use strict';

// "Next step": every chat reply from Mia or a bot ends with one line, like
// "Next: Compare the two releases", naming what the user might ask next. The
// line is taken off the reply before it is saved and kept in the reply's
// metadata, where the composer shows it as the Tab hint and the browser's
// blank tab shows it as a suggestion. A reply without the line has no hint.

const MAX_NEXT_STEP_CHARS = 90;

function nextStepInstruction() {
  return 'End your reply with one final line that starts with "Next:" followed by the most useful thing ' +
    'the user could ask you to do next, written in the user\'s own voice as an imperative, 12 words or ' +
    'fewer, no trailing period. For example: "Next: Compare the two releases". The app removes this ' +
    'line from your reply and offers it to the user as a suggestion, so do not mention it.';
}

const NEXT_STEP_LINE = /^\s*(?:[*_]{1,2})?next(?:\s+step)?(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2})?\s*(.*?)\s*$/i;

// -> {text, nextStep}: the reply without its closing "Next:" line, and that
// line's suggestion, or null when the reply does not end with a usable one.
function splitNextStep(reply) {
  const text = String(reply || '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 0) return { text, nextStep: null };
  const match = lines[last].match(NEXT_STEP_LINE);
  if (!match) return { text, nextStep: null };
  const rest = lines.slice(0, last).join('\n').trim();
  const nextStep = match[1]
    .replace(/^[*_"'“]+|[*_"'”.]+$/g, '')
    .trim();
  // Only the line itself goes; a reply that is nothing but the line keeps it.
  if (!rest) return { text, nextStep: null };
  return { text: rest, nextStep: nextStep && nextStep.length <= MAX_NEXT_STEP_CHARS ? nextStep : null };
}

module.exports = { nextStepInstruction, splitNextStep, MAX_NEXT_STEP_CHARS };
