'use strict';

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Long enough to hold a real brief, so the bot's instructions are the person's
// words rather than a summary of them.
const MAX_INSTRUCTIONS = 100000;
// Past this length the person has written the brief themselves: it is kept
// word for word, and the model only names the bot and picks skills.
const VERBATIM_INTENT_CHARS = 1500;

function cleanBlock(value, max) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
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
function normalizeAgentDraft(raw, { intent = '', skills = [] } = {}) {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const brief = cleanBlock(intent, MAX_INSTRUCTIONS);
  const written = cleanBlock(parsed.instructions, MAX_INSTRUCTIONS)
    || [cleanBlock(parsed.role, MAX_INSTRUCTIONS), cleanBlock(parsed.output, MAX_INSTRUCTIONS)].filter(Boolean).join('\n\n');
  const instructions = brief.length > VERBATIM_INTENT_CHARS ? brief : written;
  const known = new Set(skills.map((skill) => skill.id));
  const draft = {
    name: titleCase(parsed.name),
    instructions,
    summary: cleanText(parsed.summary || parsed.role || instructions, 500),
    skills: [...new Set(Array.isArray(parsed.skills) ? parsed.skills : [])].filter((id) => known.has(id)),
    automationRequest: cleanText(parsed.automationRequest, 1000),
  };
  return draft.name && draft.instructions ? draft : null;
}

function buildAgentSetupPrompt(intent, skills = []) {
  const brief = cleanBlock(intent, MAX_INSTRUCTIONS);
  const verbatim = brief.length > VERBATIM_INTENT_CHARS;
  return [
    'Infer an editable AI-agent setup from the user intent below.',
    'Return ONLY valid JSON with this exact shape:',
    '{"name":"1-3 words","summary":"one plain sentence saying what the bot does","instructions":"","skills":[],"automationRequest":""}',
    'Rules:',
    '- Preserve the user intent; do not add capabilities, sources, or promises they did not request.',
    verbatim
      ? '- instructions: leave it "". The user wrote a full brief and Mia keeps it word for word.'
      : '- instructions: the working brief for the bot, in plain language: what it does, the sources it may use, and the result it produces. Keep every detail the user gave. Use line breaks.',
    '- name, summary and instructions describe the bot only. Leave any schedule or timing out of them.',
    '- automationRequest: if the user asks for work to repeat on a schedule, restate that request in one sentence with its timing (for example "Every weekday at 8:00, post the top five AI stories"). Otherwise use "". Do not invent a schedule.',
    skills.length
      ? '- skills: the ids of skills from this library the bot clearly needs, or []. Use only these ids:\n'
        + skills.map((skill) => `  ${skill.id}: ${skill.name}${skill.description ? ` - ${skill.description}` : ''}`).join('\n')
      : '- skills: [] (the library is empty).',
    '- No markdown, prose, explanation, or hidden reasoning around the JSON.',
    '',
    brief,
  ].join('\n');
}

module.exports = {
  MAX_INSTRUCTIONS,
  parseJsonObject,
  buildAgentSetupPrompt,
  normalizeAgentDraft,
};
