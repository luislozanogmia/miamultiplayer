'use strict';
// Some providers report the final answer a second time as a "reasoning
// summary": either whole, or as a preview cut off mid-sentence and prefixed
// with the agent's name ("[Mia] ..."). Shown beside the reply it reads as the
// same message twice, so verbose chat leaves it out.
const PREVIEW_MIN_LENGTH = 80;
const squash = value => String(value || '').replace(/\s+/g, ' ').trim();
function reasoningRepeatsReply(summary, reply) {
  const answer = squash(reply);
  let text = squash(summary);
  if (!text || !answer) return false;
  if (text === answer) return true;
  text = text.replace(/^\[[^\]]{1,80}\]\s*/, '');
  if (text === answer) return true;
  text = text.replace(/(?:\.\.\.|…)$/, '').trim();
  return text.length >= PREVIEW_MIN_LENGTH && answer.startsWith(text);
}
module.exports = { reasoningRepeatsReply };
