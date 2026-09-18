'use strict';

function preferredName(value) {
  const name = String(value || '').trim();
  return name && name.length <= 80 && !name.includes('@') && !/[\r\n]/.test(name)
    && !/^(local user|user|there)$/i.test(name) ? name : '';
}

function openingMessage(displayName) {
  const name = preferredName(displayName);
  return name
    ? `Hi ${name}! Is ${name} what you’d like me to call you?`
    : 'Hi, I’m Mia! What should I call you?';
}

// This first exchange is an app-owned profile confirmation. An ordinary task
// must still reach the model, and must never become the person's display name.
function nameAnswer(text, suggestedName) {
  const value = String(text || '').trim();
  if (/^(yes|yes please|that’s right|that's right|correct)[.!]?$/i.test(value)) {
    const name = preferredName(suggestedName);
    return name ? { name } : { askName: true };
  }
  if (/^(no|no thanks|another name|use another name)[.!]?$/i.test(value)) return { askName: true };
  if (/^(skip|skip for now)[.!]?$/i.test(value)) return { skip: true };
  const explicit = /^(?:please )?(?:call me|my name is|i['’]d like(?: you to call me)?|i prefer)\s+(.+?)[.!]?$/i.exec(value);
  const name = preferredName(explicit ? explicit[1] : value);
  // Bare single names are unambiguous in direct response to the name question.
  // Multiword names can use "Call me …" or the explicit name confirmation UI.
  const explicitName = explicit && /^[\p{L}][\p{L}\p{M}'’-]*(?: [\p{L}][\p{L}\p{M}'’-]*){0,3}$/u.test(name)
    && !/^(a|an|the|to|some|help|you|working|something)\b/i.test(name);
  if (name && (explicitName || (!explicit && /^[\p{L}][\p{L}\p{M}'’-]*$/u.test(name)))
    && !/^(hello|hi|hey|help|test|thanks|okay|ok)$/i.test(name)) return { name };
  return { passthrough: true };
}

const NEWS_INTRO = 'Let’s start with what interests you. I can put together a regular news briefing on the topics you care about. What would you like to follow?';

function newsBriefing(input) {
  const topics = Array.isArray(input.topics) ? [...new Set(input.topics.map(value => String(value).trim()).filter(Boolean))] : [];
  if (!topics.length || topics.length > 8 || topics.some(value => value.length > 120)) throw new Error('Choose up to eight topics, each under 120 characters.');
  if (!['daily', 'weekdays', 'weekly'].includes(input.schedule)) throw new Error('Choose a schedule.');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time || '')) throw new Error('Choose a valid time.');
  if (!Number.isInteger(input.utcOffsetMinutes) || input.utcOffsetMinutes < -840 || input.utcOffsetMinutes > 720) throw new Error('Choose a valid time zone.');
  if (input.schedule === 'weekly' && !['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].includes(input.day)) throw new Error('Choose a weekday.');
  return {
    id: 'news-briefing', name: 'My news briefing', enabled: true,
    frequency: input.schedule === 'weekly' ? 'weekly' : 'daily',
    ...(input.schedule === 'weekdays' ? {weekdaysOnly: true} : {}),
    ...(input.schedule === 'weekly' ? {day: input.day} : {}),
    time: input.time, utcOffsetMinutes: input.utcOffsetMinutes,
    prompt: 'Create today’s concise news briefing about: ' + topics.join('; ') + '. Search the web for current reporting. Include source links and publication dates, distinguish facts from opinion, and explain why each story matters. If reliable current sources are unavailable, say so; do not invent news. Return the briefing here. Do not create or change schedules.',
  };
}

module.exports = { preferredName, openingMessage, nameAnswer, NEWS_INTRO, newsBriefing };
