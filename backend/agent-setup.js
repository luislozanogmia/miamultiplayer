'use strict';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FREQUENCIES = ['none', 'interval', 'daily', 'weekly', 'monthly'];

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function titleCase(value) {
  return cleanText(value, 40).split(/\s+/).filter(Boolean).map((word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

function hasExplicitScheduleIntent(intent) {
  return /\b(every|each|daily|hourly|weekly|monthly|weekdays?|weekends?|hours?|minutes?|mins?|once\s+(?:a|per)\s+(?:hour|day|week|month)|per\s+(?:hour|day|week|month)|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(String(intent || ''));
}

function inferSchedule(intent) {
  const source = String(intent || '');
  if (!hasExplicitScheduleIntent(source)) {
    return { enabled: false, frequency: 'none', day: '', time: '' };
  }
  const intervalMatch = /\b(?:every|each)\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(source);
  if (intervalMatch) {
    const multiplier = /^(?:hours?|hrs?)$/i.test(intervalMatch[2]) ? 60 : 1;
    const intervalMinutes = Number(intervalMatch[1]) * multiplier;
    if (Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440
      && (intervalMinutes <= 60 || intervalMinutes % 60 === 0)) {
      return { enabled: true, frequency: 'interval', intervalMinutes, day: '', time: '' };
    }
  }
  if (/\b(?:hourly|every hour|each hour|once\s+(?:an?|per)\s+hour)\b/i.test(source)) {
    return { enabled: true, frequency: 'interval', intervalMinutes: 60, day: '', time: '' };
  }
  if (/\b(?:every minute|each minute)\b/i.test(source)) {
    return { enabled: true, frequency: 'interval', intervalMinutes: 1, day: '', time: '' };
  }
  let frequency = 'weekly';
  if (/\b(daily|every day|each day|weekdays?)\b/i.test(source)) frequency = 'daily';
  else if (/\b(monthly|every month|each month|once\s+(?:a|per)\s+month)\b/i.test(source)) frequency = 'monthly';
  else if (/\b(weekly|every week|each week|once\s+(?:a|per)\s+week)\b/i.test(source)) frequency = 'weekly';

  const dayName = DAYS.find((day) => new RegExp(`\\b${day}s?\\b`, 'i').test(source)) || '';
  const monthDayMatch = /\b(?:day\s+|on\s+the\s+)([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/i.exec(source);
  const timeMatch = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(source) ||
    /\b(?:at\s+)([01]?\d|2[0-3]):([0-5]\d)\b/.exec(source);
  let time = '';
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const meridiem = String(timeMatch[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return {
    enabled: true,
    frequency,
    day: frequency === 'weekly' ? dayName : (frequency === 'monthly' && monthDayMatch ? monthDayMatch[1] : ''),
    time,
  };
}

function fallbackName(intent) {
  const source = String(intent || '').toLowerCase();
  const named = [
    ['newsletter', 'Newsletter'],
    ['email', 'Email Triage'],
    ['inbox', 'Email Triage'],
    ['research', 'Research'],
    ['source', 'Research'],
    ['content', 'Content'],
    ['social', 'Social Media'],
    ['calendar', 'Calendar'],
    ['sales', 'Sales'],
    ['finance', 'Finance'],
  ].find(([keyword]) => source.includes(keyword));
  if (named) return named[1];
  const words = source.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((word) => word && !/^(i|need|want|an?|agent|that|to|the|my|me|help|with|please|can|you)$/.test(word))
    .slice(0, 2);
  return words.length ? titleCase(words.join(' ')) : 'New Agent';
}

function fallbackRole(intent) {
  let role = cleanText(intent, 500)
    .replace(/^i\s+(?:need|want|would like)\s+(?:an?\s+)?agent\s+(?:that|to)?\s*/i, '')
    .replace(/^help\s+me\s+(?:to\s+)?/i, '')
    .replace(/^every\s+(?:day|weekday|weekend|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\s*(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*[,;:–—-]*\s*/i, '');
  if (!role) role = 'Help with the work described in this setup conversation.';
  return role.charAt(0).toUpperCase() + role.slice(1).replace(/[.!?]*$/, '.');
}

function fallbackOutput(intent) {
  const source = String(intent || '').toLowerCase();
  if (source.includes('newsletter')) return 'A concise newsletter draft with source links and key insights.';
  if (source.includes('research') || source.includes('search')) return 'A sourced summary with the most important findings and links.';
  if (source.includes('email') || source.includes('inbox')) return 'A prioritized summary of relevant messages and recommended next actions.';
  return 'A clear result with the important findings, source context, and recommended next action.';
}

function fallbackAgentDraft(intent) {
  const automation = inferSchedule(intent);
  if (automation.enabled) automation.prompt = cleanText(intent, 1000);
  return {
    name: fallbackName(intent),
    role: fallbackRole(intent),
    output: fallbackOutput(intent),
    automation,
  };
}

function parseJsonObject(raw) {
  const source = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch (err) { return null; }
}

function normalizeAutomation(value, intent) {
  const inferred = inferSchedule(intent);
  if (!inferred.enabled) return inferred;
  const source = value && typeof value === 'object' ? value : {};
  const frequency = FREQUENCIES.includes(source.frequency) && source.frequency !== 'none'
    ? source.frequency : inferred.frequency;
  if (frequency === 'interval') {
    const proposed = Number(source.intervalMinutes);
    const intervalMinutes = Number.isInteger(proposed) && proposed >= 1 && proposed <= 1440
      && (proposed <= 60 || proposed % 60 === 0)
      ? proposed : inferred.intervalMinutes;
    return {
      enabled: true,
      frequency,
      intervalMinutes,
      day: '',
      time: '',
      prompt: cleanText(source.prompt, 1000) || inferred.prompt || cleanText(intent, 1000),
    };
  }
  let day = cleanText(source.day, 16) || inferred.day;
  if (frequency === 'weekly') {
    const canonical = DAYS.find((candidate) => candidate.toLowerCase() === day.toLowerCase());
    day = canonical || '';
  } else if (frequency === 'monthly') {
    const n = Number(day);
    day = Number.isInteger(n) && n >= 1 && n <= 31 ? String(n) : '';
  } else {
    day = '';
  }
  const proposedTime = cleanText(source.time, 5);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(proposedTime) ? proposedTime : inferred.time;
  return {
    enabled: true,
    frequency,
    day,
    time,
    prompt: cleanText(source.prompt, 1000) || inferred.prompt || cleanText(intent, 1000),
  };
}

function normalizeAgentDraft(raw, intent) {
  const fallback = fallbackAgentDraft(intent);
  const parsed = parseJsonObject(raw) || {};
  return {
    name: titleCase(parsed.name) || fallback.name,
    role: cleanText(parsed.role, 500) || fallback.role,
    output: cleanText(parsed.output, 300) || fallback.output,
    automation: normalizeAutomation(parsed.automation, intent),
  };
}

function buildAgentSetupPrompt(intent) {
  return [
    'Infer an editable AI-agent setup from the user intent below.',
    'Return ONLY valid JSON with this exact shape:',
    '{"name":"1-3 words","role":"what the agent does and sources it may use","output":"the result it should produce","automation":{"enabled":false,"frequency":"none","intervalMinutes":null,"day":"","time":"","prompt":"exact task to run on schedule"}}',
    'Rules:',
    '- Preserve the user intent; do not add capabilities, sources, or promises they did not request.',
    '- automation.enabled may be true ONLY when the user explicitly requested recurrence, a cadence, a day, or a time.',
    '- When automation.enabled is true, automation.prompt must be a concrete, self-contained task preserving the user request.',
    '- frequency must be one of none, interval, daily, weekly, monthly.',
    '- For interval schedules, intervalMinutes may be 1-60 minutes or whole hours up to 1440 minutes.',
    '- Use HH:MM 24-hour time when a time is known; otherwise use an empty string.',
    '- No markdown, prose, explanation, or hidden reasoning.',
    '',
    cleanText(intent, 2000),
  ].join('\n');
}

// Revising a draft from Mia's chat: the user describes a change in words
// ("make it weekly", "call it Scout") and the proposal is rewritten from the
// current draft, which already includes any edits made in the review card.
function wantsNoAutomation(change) {
  return /\b(?:no|remove|drop|stop|without|turn\s+off|disable|cancel|don'?t\s+(?:need|want))\b[^.]*\b(?:schedul\w*|automations?|timers?|recurr\w*|repeat\w*)\b/i.test(String(change || ''));
}

function currentDraftText(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  return JSON.stringify({
    name: cleanText(source.name, 40),
    role: cleanText(source.role, 500),
    output: cleanText(source.output, 300),
    automation: source.automation && typeof source.automation === 'object' ? source.automation : { enabled: false },
  });
}

function buildAgentRevisionPrompt(intent, currentDraft, change) {
  return [
    'Revise an editable AI-agent setup. Apply the requested change to the current setup and keep everything else as it is.',
    'Return ONLY valid JSON with the same shape as the current setup:',
    '{"name":"1-3 words","role":"what the agent does and sources it may use","output":"the result it should produce","automation":{"enabled":false,"frequency":"none","intervalMinutes":null,"day":"","time":"","prompt":"exact task to run on schedule"}}',
    'Rules:',
    '- Change only what the request asks for; do not add capabilities, sources, or promises the user did not request.',
    '- automation.enabled may be true ONLY when the user explicitly requested recurrence, a cadence, a day, or a time.',
    '- frequency must be one of none, interval, daily, weekly, monthly. Use HH:MM 24-hour time.',
    '- No markdown, prose, explanation, or hidden reasoning.',
    '',
    `Original request: ${cleanText(intent, 2000)}`,
    `Current setup: ${currentDraftText(currentDraft)}`,
    `Requested change: ${cleanText(change, 2000)}`,
  ].join('\n');
}

function normalizeAgentRevision(raw, intent, currentDraft, change) {
  const current = currentDraft && typeof currentDraft === 'object' ? currentDraft : {};
  const fallback = fallbackAgentDraft(intent);
  const parsed = parseJsonObject(raw) || {};
  // The schedule is the one field with a safety rule: it changes only when the
  // user asks for it in this change. Otherwise the current schedule stays,
  // including one the user set by hand in the review card.
  let automation;
  if (wantsNoAutomation(change)) {
    automation = { enabled: false, frequency: 'none', day: '', time: '' };
  } else if (hasExplicitScheduleIntent(change)) {
    const proposed = parsed.automation && typeof parsed.automation === 'object' ? parsed.automation : {};
    automation = normalizeAutomation(proposed, change);
    if (!cleanText(proposed.prompt, 1000)) {
      const currentPrompt = current.automation && cleanText(current.automation.prompt, 1000);
      automation.prompt = currentPrompt || cleanText(intent, 1000) || automation.prompt;
    }
  } else if (current.automation && typeof current.automation === 'object' && current.automation.enabled) {
    automation = { ...current.automation };
  } else {
    automation = { enabled: false, frequency: 'none', day: '', time: '' };
  }
  return {
    name: titleCase(parsed.name) || titleCase(current.name) || fallback.name,
    role: cleanText(parsed.role, 500) || cleanText(current.role, 500) || fallback.role,
    output: cleanText(parsed.output, 300) || cleanText(current.output, 300) || fallback.output,
    automation,
  };
}

module.exports = {
  buildAgentRevisionPrompt,
  buildAgentSetupPrompt,
  fallbackAgentDraft,
  hasExplicitScheduleIntent,
  inferSchedule,
  normalizeAgentDraft,
  normalizeAgentRevision,
};
