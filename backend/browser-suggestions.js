'use strict';

// "Mia suggests" on the browser's blank tab: three next things to do, drawn
// from the latest replies the user's bots sent. The server route gathers the
// replies and runs inference; this module only picks the replies, writes the
// prompt and cleans the model's answer, so it can be tested on its own.

const MAX_BOTS = 3;
const MAX_REPLY_CHARS = 600;
const MAX_SUGGESTION_CHARS = 90;

// latestBotReplies({bots, conversationsFor, eventsFor}) -> [{botId, botName,
// eventId, at, text}], newest first, at most one per bot. conversationsFor(bot)
// returns the bot's chats; eventsFor(conversation) returns its latest events
// in order. Progress notes ("Thinking…") and the user's own messages are skipped.
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
          best = { botId: bot.id, botName: bot.name || bot.id, eventId: event.id, at: event.createdAt, text: text.slice(0, MAX_REPLY_CHARS) };
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

// Replies are numbered so each suggestion can name the reply (and so the
// bot) it builds on; the blank tab shows that bot on the card.
function suggestionsPrompt(replies) {
  return 'These are the latest replies from the user\'s bots, numbered. Suggest exactly 3 short next ' +
    'things the user could ask Mia to do, each building on one of the replies. Write each in the ' +
    'user\'s own voice as an imperative, 12 words or fewer, no trailing period, one per line. Start ' +
    'each line with the bracketed number of the reply it builds on, like "[2] Compare the two ' +
    'releases". No other numbering, no quotes, no preamble.\n\n' +
    replies.map((reply, index) => `[${index + 1}] ${reply.botName}: ${reply.text}`).join('\n\n');
}

// -> [{text, source}], source being the index into replies, or null when the
// model did not say which reply a line builds on.
function parseSuggestions(reply, replyCount = Infinity) {
  return String(reply || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      let rest = line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '');
      let source = null;
      const tag = rest.match(/^\[(\d+)\]\s*/);
      if (tag) {
        const index = Number(tag[1]) - 1;
        if (index >= 0 && index < replyCount) source = index;
        rest = rest.slice(tag[0].length);
      }
      return { text: rest.replace(/^["']+|["'.]+$/g, '').trim(), source };
    })
    .filter((item) => item.text && item.text.length <= MAX_SUGGESTION_CHARS)
    .slice(0, 3);
}

// Same replies -> same cache key, so a new blank tab does not re-run inference.
function suggestionsCacheKey(owner, workspaceId, replies) {
  return `${owner}:${workspaceId}:${replies.map((reply) => reply.eventId).join(',')}`;
}

module.exports = { latestBotReplies, suggestionsPrompt, parseSuggestions, suggestionsCacheKey };
