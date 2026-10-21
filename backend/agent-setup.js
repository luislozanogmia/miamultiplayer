'use strict';

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function titleCase(value) {
  return cleanText(value, 40).split(/\s+/).filter(Boolean).map((word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

// Bot setup only creates the bot. When the request also asks for a schedule,
// the draft keeps that request as automationRequest; once the bot exists Mia
// hands it to the bot, which proposes the automation (with its steps) through
// its own automation card.
function hasExplicitScheduleIntent(intent) {
  return /\b(every|each|daily|hourly|weekly|monthly|weekdays?|weekends?|hours?|minutes?|mins?|once\s+(?:a|per)\s+(?:hour|day|week|month)|per\s+(?:hour|day|week|month)|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(String(intent || ''));
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

function automationRequestFrom(intent) {
  return hasExplicitScheduleIntent(intent) ? cleanText(intent, 1000) : '';
}

function fallbackAgentDraft(intent) {
  return {
    name: fallbackName(intent),
    role: fallbackRole(intent),
    output: fallbackOutput(intent),
    automationRequest: automationRequestFrom(intent),
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

function normalizeAgentDraft(raw, intent) {
  const fallback = fallbackAgentDraft(intent);
  const parsed = parseJsonObject(raw) || {};
  return {
    name: titleCase(parsed.name) || fallback.name,
    role: cleanText(parsed.role, 500) || fallback.role,
    output: cleanText(parsed.output, 300) || fallback.output,
    automationRequest: fallback.automationRequest,
  };
}

function buildAgentSetupPrompt(intent) {
  return [
    'Infer an editable AI-agent setup from the user intent below.',
    'Return ONLY valid JSON with this exact shape:',
    '{"name":"1-3 words","role":"what the agent does and sources it may use","output":"the result it should produce"}',
    'Rules:',
    '- Preserve the user intent; do not add capabilities, sources, or promises they did not request.',
    '- Describe the bot only. Leave out any schedule or timing; the bot sets up its own automations after it is created.',
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
  });
}

function buildAgentRevisionPrompt(intent, currentDraft, change) {
  return [
    'Revise an editable AI-agent setup. Apply the requested change to the current setup and keep everything else as it is.',
    'Return ONLY valid JSON with the same shape as the current setup:',
    '{"name":"1-3 words","role":"what the agent does and sources it may use","output":"the result it should produce"}',
    'Rules:',
    '- Change only what the request asks for; do not add capabilities, sources, or promises the user did not request.',
    '- Describe the bot only. Leave out any schedule or timing; the bot sets up its own automations after it is created.',
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
  // The automation request changes only when this change asks for it, so a
  // revision like "call it Scout" keeps the schedule the user asked for.
  let automationRequest = cleanText(current.automationRequest, 1000);
  if (wantsNoAutomation(change)) automationRequest = '';
  else if (hasExplicitScheduleIntent(change)) automationRequest = cleanText(change, 1000);
  return {
    name: titleCase(parsed.name) || titleCase(current.name) || fallback.name,
    role: cleanText(parsed.role, 500) || cleanText(current.role, 500) || fallback.role,
    output: cleanText(parsed.output, 300) || cleanText(current.output, 300) || fallback.output,
    automationRequest,
  };
}

module.exports = {
  buildAgentRevisionPrompt,
  buildAgentSetupPrompt,
  fallbackAgentDraft,
  hasExplicitScheduleIntent,
  normalizeAgentDraft,
  normalizeAgentRevision,
};
