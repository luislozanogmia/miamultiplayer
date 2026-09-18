'use strict';

const crypto = require('crypto');
const { inferSchedule } = require('./agent-setup');
const { MAX_BOT_AUTOMATIONS, botAutomations, migrateBotAutomations } = require('./cron-sync');

const RECURRING_INTENT = /\b(?:every|each)\s+(?:\d+\s+)?(?:minutes?|mins?|hours?|days?|weeks?|months?)\b|\b(?:daily|weekly|monthly|weekdays?|weekends?|once\s+(?:a|per)\s+(?:day|week|month))\b/i;
const CANCELLATION_INTENT = /\b(?:cancel|stop|pause|disable|turn\s+off)\b[\s\S]{0,80}\b(?:automation|cron(?:\s+job)?|scheduled?\s+(?:job|task|run)|recurring\s+(?:job|task|run))\b|\b(?:automation|cron(?:\s+job)?|scheduled?\s+(?:job|task|run)|recurring\s+(?:job|task|run))\b[\s\S]{0,80}\b(?:cancel|stop|pause|disable|turn\s+off)\b/i;

function cleanText(value, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function automationSummary(automation) {
  if (!automation || automation.enabled !== true) return '';
  if (automation.frequency === 'interval') {
    return `every ${automation.intervalMinutes} minutes`;
  }
  if (automation.frequency === 'daily') {
    return `every day at ${automation.time || '09:00'}`;
  }
  if (automation.frequency === 'weekly') {
    return `every ${automation.day || 'week'} at ${automation.time || '09:00'}`;
  }
  if (automation.frequency === 'monthly') {
    return `every month${automation.day ? ` on day ${automation.day}` : ''} at ${automation.time || '09:00'}`;
  }
  return '';
}

function automationCancellationFromChat(message) {
  const text = cleanText(message);
  return text && CANCELLATION_INTENT.test(text) ? { action: 'cancel' } : null;
}

function automationRequestFromChat(message, { conversationId, companyId } = {}) {
  const task = cleanText(message);
  if (!task || !RECURRING_INTENT.test(task)) return null;
  const automation = inferSchedule(task);
  if (!automation.enabled || automation.frequency === 'none') return null;
  automation.prompt = [
    'Perform this scheduled bot task now. Do not create, edit, or discuss the schedule itself.',
    'Return the concrete result for this run so Mia can deliver it to the conversation.',
    '',
    `User task: ${task}`,
  ].join('\n');
  automation.id = `automation-${crypto.randomUUID()}`;
  automation.name = cleanText(task, 48) || 'Scheduled task';
  if (conversationId) automation.deliveryConversationId = String(conversationId);
  if (companyId) automation.deliveryCompanyId = String(companyId);
  return { automation, task, summary: automationSummary(automation) };
}

function managerAutomationRequestFromChat(message, bots) {
  const text = cleanText(message);
  if (!text || !RECURRING_INTENT.test(text) || !Array.isArray(bots)) return null;
  const candidates = bots
    .filter((bot) => bot && bot.id && cleanText(bot.name, 120))
    .sort((a, b) => cleanText(b.name, 120).length - cleanText(a.name, 120).length);
  for (const bot of candidates) {
    const name = cleanText(bot.name, 120);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`\\b(?:ask|tell|have|request)\\s+${escaped}\\b(?:\\s+to)?\\s+(.+)$`, 'i').exec(text);
    if (!match) continue;
    const task = cleanText(match[1]);
    // A request made in the user's private Mia conversation is only the
    // delegation source. The bot's own conversation is assigned later by the
    // bot dispatch, so the private 1:1 can never become an automation target.
    const request = automationRequestFromChat(task);
    if (request) return { ...request, bot };
  }
  return null;
}

async function scheduleBotAutomationFromChat({ bot, message, conversationId, companyId }, dependencies) {
  const request = automationRequestFromChat(message, { conversationId, companyId });
  if (!request) return null;
  if (typeof dependencies.canSchedule === 'function' && !dependencies.canSchedule(bot)) {
    throw new Error('only the bot owner or a workspace admin can change its automation');
  }
  const now = dependencies.now ? dependencies.now() : new Date().toISOString();
  migrateBotAutomations(bot);
  if (bot.automations.length >= MAX_BOT_AUTOMATIONS) {
    throw new Error(`this bot already has ${MAX_BOT_AUTOMATIONS} automations`);
  }
  const updated = {
    ...bot,
    automations: [...bot.automations, request.automation],
    updatedAt: now,
    timeline: [
      ...(Array.isArray(bot.timeline) ? bot.timeline : []),
      { ts: now, event: `automation scheduled from chat: ${request.summary}` },
    ],
  };
  await dependencies.syncBotAutomation(updated);
  dependencies.saveBot(updated);
  return {
    bot: updated,
    automation: request.automation,
    confirmation: `Automation created: ${request.summary}. I’ll run this task and deliver each result in this conversation.`,
  };
}

async function cancelBotAutomationFromChat({ bot, message }, dependencies) {
  const request = automationCancellationFromChat(message);
  if (!request) return null;
  if (typeof dependencies.canSchedule === 'function' && !dependencies.canSchedule(bot)) {
    throw new Error('only the bot owner or a workspace admin can change its automation');
  }
  migrateBotAutomations(bot);
  const active = botAutomations(bot).filter((automation) => automation.enabled === true && automation.frequency !== 'none');
  const named = active.filter((automation) => String(message || '').toLowerCase().includes(String(automation.name || '').toLowerCase()));
  if (active.length > 1 && named.length !== 1) {
    throw new Error('this bot has more than one active automation; name the one to stop');
  }
  const current = named[0] || active[0] || {};
  if (current.enabled !== true || current.frequency === 'none') {
    return { bot, automation: current, confirmation: 'Automation is already stopped.' };
  }
  const now = dependencies.now ? dependencies.now() : new Date().toISOString();
  const automation = {
    ...current,
    enabled: false,
    frequency: 'none',
  };
  delete automation.intervalMinutes;
  delete automation.day;
  delete automation.time;
  const updated = {
    ...bot,
    automations: bot.automations.map((item) => item.id === current.id ? automation : item),
    updatedAt: now,
    timeline: [
      ...(Array.isArray(bot.timeline) ? bot.timeline : []),
      { ts: now, event: 'automation cancelled from chat' },
    ],
  };
  await dependencies.syncBotAutomation(updated);
  dependencies.saveBot(updated);
  return {
    bot: updated,
    automation,
    confirmation: 'Automation cancelled. It will not run again.',
  };
}

module.exports = {
  automationCancellationFromChat,
  automationRequestFromChat,
  automationSummary,
  cancelBotAutomationFromChat,
  managerAutomationRequestFromChat,
  scheduleBotAutomationFromChat,
};
