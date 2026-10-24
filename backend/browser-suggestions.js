'use strict';

// "Mia suggests" on the browser's blank tab: the next step each bot proposed
// at the end of its latest reply (see next-step.js), newest bot first. No
// model runs here; the bots already wrote these with their replies.

const MAX_BOTS = 3;

// latestBotReplies({bots, conversationsFor, eventsFor}) -> [{botId, botName,
// eventId, at, text, nextStep}], newest first, at most one per bot.
// conversationsFor(bot) returns the bot's chats; eventsFor(conversation)
// returns its latest events in order. Progress notes ("Thinking…") and the
// user's own messages are skipped.
function latestBotReplies({ bots, conversationsFor, eventsFor, limit = MAX_BOTS }) {
  const replies = [];
  for (const bot of bots || []) {
    if (!bot || !bot.id) continue;
    let best = null;
    for (const conversation of conversationsFor(bot) || []) {
      const events = eventsFor(conversation) || [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (!event || event.deletedAt) continue;
        if (event.senderType !== 'bot' && event.senderType !== 'agent') continue;
        if (event.metadata && event.metadata.progress === true) continue;
        const text = eventText(event);
        if (!text) continue;
        if (!best || String(event.createdAt) > String(best.at)) {
          const nextStep = event.metadata && typeof event.metadata.nextStep === 'string' ? event.metadata.nextStep.trim() : '';
          best = { botId: bot.id, botName: bot.name || bot.id, eventId: event.id, at: event.createdAt, text, nextStep: nextStep || null };
        }
        break;
      }
    }
    if (best) replies.push(best);
  }
  return replies.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function eventText(event) {
  const content = event && event.content && typeof event.content === 'object' ? event.content : {};
  const text = typeof content.text === 'string' ? content.text : (typeof content.body === 'string' ? content.body : '');
  return text.trim();
}

// -> [{text, botId, botName, at}] for the replies that proposed a next step.
function browserSuggestions(replies) {
  return (replies || [])
    .filter((reply) => reply && reply.nextStep)
    .map((reply) => ({ text: reply.nextStep, botId: reply.botId, botName: reply.botName, at: reply.at }));
}

module.exports = { latestBotReplies, browserSuggestions };
