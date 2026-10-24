'use strict';

// A bot asks Mia to create, change, or run one of its own automations by
// ending its reply with one <MIA_AUTOMATION>{json}</MIA_AUTOMATION> block.
// Mia knows which bot wrote the reply, so a bot can only touch its own
// automations. Create and update become a review card the user confirms;
// nothing is scheduled from model output alone. run_now starts an automation
// that is already on.

const crypto = require('crypto');
const { MAX_BOT_AUTOMATIONS, MAX_AUTOMATION_STEPS, isValidAutomationTime } = require('./cron-sync');

const SCHEMA_VERSION = 1;
const ACTIONS = ['create', 'update', 'run_now'];
const FREQUENCIES = ['interval', 'daily', 'weekly', 'monthly'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const AUTOMATION_FIELDS = ['name', 'goal', 'schedule', 'steps', 'output'];
const SCHEDULE_FIELDS = ['frequency', 'time', 'day', 'weekdaysOnly', 'intervalMinutes', 'timezone'];
const TAG = /<MIA_AUTOMATION>([\s\S]*?)<\/MIA_AUTOMATION>/gi;

function stripAutomationBlocks(text) {
  let clean = String(text || '').replace(TAG, '');
  const unclosed = clean.search(/<MIA_AUTOMATION>/i);
  if (unclosed >= 0) clean = clean.slice(0, unclosed);
  return clean.replace(/<\/?MIA_AUTOMATION>/gi, '').trim();
}

// -> { text, action, error }. text never contains the block.
function extractAutomationAction(text) {
  const source = String(text || '');
  const clean = stripAutomationBlocks(source);
  const matches = [...source.matchAll(TAG)];
  const residual = source.replace(TAG, '').match(/<\/?MIA_AUTOMATION>/gi);
  if (residual) return { text: clean, action: null, error: 'malformed_block' };
  if (!matches.length) return { text: clean, action: null, error: null };
  if (matches.length > 1) return { text: clean, action: null, error: 'multiple_actions' };
  try {
    return { text: clean, action: JSON.parse(matches[0][1]), error: null };
  } catch (_) {
    return { text: clean, action: null, error: 'invalid_json' };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanLine(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (_) {
    return false;
  }
}

// Minutes to add to local time to get UTC, the same convention as
// Date#getTimezoneOffset (Monterrey, UTC-6, is 360).
function timezoneOffsetMinutes(timezone, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const utc = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((utc - local) / 60000);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

// Validates schedule fields that are present; `complete` also requires the
// fields a new automation needs. -> { schedule } or { error }.
function normalizeSchedule(input, complete) {
  if (!isPlainObject(input)) return { error: 'schedule must be an object' };
  const extra = unknownKeys(input, SCHEDULE_FIELDS);
  if (extra.length) return { error: `unknown schedule field: ${extra[0]}` };
  const schedule = {};
  if (input.frequency !== undefined) {
    if (!FREQUENCIES.includes(input.frequency)) return { error: `frequency must be one of ${FREQUENCIES.join(', ')}` };
    schedule.frequency = input.frequency;
  } else if (complete) {
    return { error: 'schedule.frequency is required' };
  }
  if (input.time !== undefined) {
    if (!isValidAutomationTime(input.time)) return { error: 'schedule.time must be HH:MM in 24-hour time' };
    schedule.time = input.time;
  }
  if (input.day !== undefined) {
    const day = String(input.day).trim();
    const weekday = WEEKDAYS.find((name) => name.toLowerCase() === day.toLowerCase());
    const dom = /^\d{1,2}$/.test(day) && +day >= 1 && +day <= 31 ? String(+day) : '';
    if (!weekday && !dom) return { error: 'schedule.day must be a weekday name or a day of the month' };
    schedule.day = weekday || dom;
  }
  if (input.weekdaysOnly !== undefined) {
    if (typeof input.weekdaysOnly !== 'boolean') return { error: 'schedule.weekdaysOnly must be true or false' };
    schedule.weekdaysOnly = input.weekdaysOnly;
  }
  if (input.intervalMinutes !== undefined) {
    const minutes = input.intervalMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || (minutes > 60 && minutes % 60 !== 0)) {
      return { error: 'schedule.intervalMinutes must be 1-60 minutes or whole hours up to 24' };
    }
    schedule.intervalMinutes = minutes;
  }
  if (input.timezone !== undefined) {
    if (!validTimezone(input.timezone)) return { error: 'schedule.timezone must be an IANA name such as America/Monterrey' };
    schedule.timezone = input.timezone;
  }
  return { schedule };
}

function checkScheduleShape(schedule) {
  if (schedule.frequency === 'interval') {
    if (!Number.isInteger(schedule.intervalMinutes)) return 'an interval schedule needs intervalMinutes';
    return null;
  }
  if (!schedule.time) return 'schedule.time is required';
  if (schedule.frequency === 'weekly' && !WEEKDAYS.includes(schedule.day)) return 'a weekly schedule needs a weekday';
  if (schedule.frequency === 'monthly' && !/^\d{1,2}$/.test(String(schedule.day || ''))) return 'a monthly schedule needs a day of the month';
  return null;
}

function normalizeSteps(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_AUTOMATION_STEPS) {
    return { error: `steps must be 1-${MAX_AUTOMATION_STEPS} short lines` };
  }
  const steps = input.map((step) => cleanLine(step, 500));
  if (steps.some((step) => !step)) return { error: 'steps cannot be empty' };
  return { steps };
}

function findAutomation(bot, automationId) {
  const automations = bot && Array.isArray(bot.automations) ? bot.automations : [];
  return automations.find((automation) => automation && automation.id === automationId) || null;
}

// The automation's fields in the schema's shape, for cards and diffs.
function automationView(automation) {
  const value = automation || {};
  const schedule = { frequency: value.frequency };
  for (const key of ['time', 'day', 'weekdaysOnly', 'intervalMinutes', 'timezone']) {
    if (value[key] !== undefined && value[key] !== '') schedule[key] = value[key];
  }
  return {
    name: value.name || '',
    goal: value.goal || '',
    schedule,
    steps: Array.isArray(value.steps) ? value.steps.slice() : [],
    output: value.output || '',
  };
}

// Checks a parsed block against schema v1 and this bot's automations.
// -> { proposal } or { error }. A proposal is what the card shows.
function normalizeAutomationAction(action, bot) {
  if (!isPlainObject(action)) return { error: 'the automation block must be a JSON object' };
  if (action.schemaVersion !== SCHEMA_VERSION) return { error: `schemaVersion must be ${SCHEMA_VERSION}` };
  if (!ACTIONS.includes(action.action)) return { error: `action must be one of ${ACTIONS.join(', ')}` };
  const extra = unknownKeys(action, ['schemaVersion', 'action', 'automationId', 'automation']);
  if (extra.length) return { error: `unknown field: ${extra[0]}` };

  if (action.action === 'run_now') {
    const existing = findAutomation(bot, action.automationId);
    if (!existing) return { error: 'run_now needs the id of one of your automations' };
    return { proposal: { schemaVersion: SCHEMA_VERSION, action: 'run_now', automationId: existing.id, name: existing.name } };
  }

  const input = action.automation;
  if (!isPlainObject(input)) return { error: 'automation must be an object' };
  const unknown = unknownKeys(input, AUTOMATION_FIELDS);
  if (unknown.length) return { error: `unknown automation field: ${unknown[0]}` };
  const isCreate = action.action === 'create';
  const existing = isCreate ? null : findAutomation(bot, action.automationId);
  if (!isCreate && !existing) return { error: 'update needs the id of one of your automations' };
  if (isCreate) {
    const count = bot && Array.isArray(bot.automations) ? bot.automations.length : 0;
    if (count >= MAX_BOT_AUTOMATIONS) return { error: `a bot can have up to ${MAX_BOT_AUTOMATIONS} automations` };
  }

  const changes = {};
  if (input.name !== undefined) {
    const name = cleanLine(input.name, 80);
    if (!name) return { error: 'name cannot be empty' };
    changes.name = name;
  } else if (isCreate) {
    return { error: 'name is required' };
  }
  if (input.goal !== undefined) changes.goal = cleanLine(input.goal, 500);
  if (input.output !== undefined) changes.output = cleanLine(input.output, 300);
  if (input.steps !== undefined) {
    const result = normalizeSteps(input.steps);
    if (result.error) return result;
    changes.steps = result.steps;
  } else if (isCreate) {
    return { error: 'steps are required' };
  }
  if (input.schedule !== undefined) {
    const result = normalizeSchedule(input.schedule, isCreate);
    if (result.error) return result;
    changes.schedule = result.schedule;
  } else if (isCreate) {
    return { error: 'schedule is required' };
  }
  if (!Object.keys(changes).length) return { error: 'update must change at least one field' };

  const before = existing ? automationView(existing) : null;
  const after = before
    ? { ...before, ...changes, schedule: { ...before.schedule, ...(changes.schedule || {}) } }
    : { goal: '', output: '', ...changes };
  const shapeError = checkScheduleShape(after.schedule);
  if (shapeError) return { error: shapeError };
  return {
    proposal: {
      schemaVersion: SCHEMA_VERSION,
      action: action.action,
      ...(existing ? { automationId: existing.id } : {}),
      automation: after,
      ...(before ? { before } : {}),
    },
  };
}

// The record fields Mia stores for a reviewed proposal. `fields` is the
// card's final values (schema shape); `existing` is the automation an update
// replaces.
function automationRecordFromProposal(fields, existing, { conversationId, companyId, now = new Date() } = {}) {
  const schedule = fields.schedule || {};
  const record = {
    ...(existing || {}),
    id: existing ? existing.id : `automation-${crypto.randomUUID()}`,
    name: fields.name,
    enabled: existing ? existing.enabled === true : true,
    frequency: schedule.frequency,
    goal: fields.goal || '',
    output: fields.output || '',
    steps: fields.steps.slice(),
    // The scheduled run reads `prompt` as its task; the goal and output say
    // what a good result looks like.
    prompt: [fields.goal, fields.output ? `Deliver: ${fields.output}` : ''].filter(Boolean).join('\n'),
  };
  for (const key of ['time', 'day', 'weekdaysOnly', 'intervalMinutes', 'timezone']) {
    if (schedule[key] !== undefined) record[key] = schedule[key];
    else delete record[key];
  }
  if (schedule.frequency === 'interval') { delete record.time; delete record.day; delete record.weekdaysOnly; }
  if (schedule.frequency !== 'interval') delete record.intervalMinutes;
  if (schedule.frequency !== 'daily') delete record.weekdaysOnly;
  if (schedule.frequency !== 'weekly' && schedule.frequency !== 'monthly') delete record.day;
  if (schedule.timezone) record.utcOffsetMinutes = timezoneOffsetMinutes(schedule.timezone, now);
  if (!existing && conversationId) record.deliveryConversationId = String(conversationId);
  if (!existing && companyId) record.deliveryCompanyId = String(companyId);
  return record;
}

function scheduleSummary(schedule) {
  const value = schedule || {};
  const zone = value.timezone ? ` (${value.timezone})` : '';
  if (value.frequency === 'interval') return `every ${value.intervalMinutes} minutes`;
  if (value.frequency === 'daily') return `${value.weekdaysOnly ? 'weekdays' : 'every day'} at ${value.time}${zone}`;
  if (value.frequency === 'weekly') return `every ${value.day} at ${value.time}${zone}`;
  if (value.frequency === 'monthly') return `on day ${value.day} of every month at ${value.time}${zone}`;
  return 'no schedule';
}

// Per-turn instructions for the bot's own chat: the schema plus the current
// automation ids, which change as the user edits them.
function automationActionInstruction(bot, { timezone = '' } = {}) {
  const automations = bot && Array.isArray(bot.automations) ? bot.automations : [];
  const list = automations.length
    ? automations.map((automation) => `- id ${automation.id}: ${automation.name} (${automation.enabled === true ? 'on' : 'off'}, ${scheduleSummary(automationView(automation).schedule)})`).join('\n')
    : '- None yet.';
  return [
    'Automation actions (authoritative):',
    'You can create, change, or run your own automations. Only do it when the user asks for it in this message. Never infer a schedule from a word like "weekly" in an ordinary request.',
    'To act, end your reply with exactly one block, and say in one short sentence what the user will see:',
    '<MIA_AUTOMATION>{"schemaVersion":1,"action":"create","automation":{"name":"Morning news digest","goal":"Five top AI stories from the last 24 hours, each with a source link","schedule":{"frequency":"daily","time":"08:00","timezone":"America/Monterrey"},"steps":["Search today\'s AI news","Pick the five that matter most","Write two sentences each","Post the list here"],"output":"A short list in this chat"}}</MIA_AUTOMATION>',
    '- create: name, schedule and 1-20 steps are required; goal and output are optional. schedule.frequency is interval (with intervalMinutes), daily (time, optional weekdaysOnly), weekly (day as a weekday name, time) or monthly (day 1-31, time). Use 24-hour HH:MM and an IANA timezone.',
    '- update: {"schemaVersion":1,"action":"update","automationId":"<id>","automation":{...only the fields that change}}.',
    '- run_now: {"schemaVersion":1,"action":"run_now","automationId":"<id>"} runs a saved automation once now. When the user asks to run an automation, use run_now and do not do its work yourself in this reply.',
    'Create and update show the user a card to review; nothing is scheduled until they confirm, so do not claim it is scheduled.',
    timezone ? `The user's timezone is ${timezone}.` : '',
    `Your automations:\n${list}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  automationActionInstruction,
  automationRecordFromProposal,
  automationView,
  extractAutomationAction,
  normalizeAutomationAction,
  scheduleSummary,
  stripAutomationBlocks,
  timezoneOffsetMinutes,
};
