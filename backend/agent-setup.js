'use strict';

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function titleCase(value) {
  return cleanText(value, 40).split(/\s+/).filter(Boolean).map((word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

// Bot setup only creates the bot. The model reads the request and says
// whether it also asks for something to run on a schedule; that part is kept
// as automationRequest and, once the bot exists, handed to the bot, which
// proposes the automation (with its steps) through its own automation card.
// No keyword rule decides this.

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

// -> the editable draft, or null when the model did not return a usable one.
function normalizeAgentDraft(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const draft = {
    name: titleCase(parsed.name),
    role: cleanText(parsed.role, 500),
    output: cleanText(parsed.output, 300),
    automationRequest: cleanText(parsed.automationRequest, 1000),
  };
  return draft.name && draft.role ? draft : null;
}

function buildAgentSetupPrompt(intent) {
  return [
    'Infer an editable AI-agent setup from the user intent below.',
    'Return ONLY valid JSON with this exact shape:',
    '{"name":"1-3 words","role":"what the agent does and sources it may use","output":"the result it should produce","automationRequest":""}',
    'Rules:',
    '- Preserve the user intent; do not add capabilities, sources, or promises they did not request.',
    '- name, role and output describe the bot only. Leave any schedule or timing out of them.',
    '- automationRequest: if the user asks for work to repeat on a schedule, restate that request in one sentence with its timing (for example "Every weekday at 8:00, post the top five AI stories"). Otherwise use "". Do not invent a schedule the user did not ask for.',
    '- No markdown, prose, explanation, or hidden reasoning.',
    '',
    cleanText(intent, 2000),
  ].join('\n');
}

module.exports = {
  buildAgentSetupPrompt,
  normalizeAgentDraft,
};
