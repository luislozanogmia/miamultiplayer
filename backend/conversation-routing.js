'use strict';

// Native participant routing. This module decides who should receive a
// conversation event; it does not execute bots or call Hermes.

const MAX_COORDINATED = 3;

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionIndex(bodyLower, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return -1;
  const match = new RegExp('(^|[^a-z0-9_])@' + escapeRe(normalized) + '(?![a-z0-9_-])').exec(bodyLower);
  return match ? match.index + match[1].length : -1;
}

function mentionedByName(bodyLower, list, includeControlTags = false) {
  const matches = [];
  for (const participant of list) {
    const name = String(participant && participant.name || '').trim().toLowerCase();
    if (!name || (!includeControlTags && ['all', 'all_bots', 'all_users'].includes(name))) continue;
    const pattern = new RegExp('(^|[^a-z0-9_])@' + escapeRe(name) + '(?![a-z0-9_-])', 'g');
    for (const match of bodyLower.matchAll(pattern)) {
      const at = match.index + match[1].length;
      matches.push({ participant, at, end: at + name.length + 1 });
    }
  }
  // A longer name owns its mention span. A separate later mention of the
  // shorter name still counts, and repeated mentions invoke a bot only once.
  matches.sort((left, right) => left.at - right.at || right.end - left.end);
  let end = -1;
  const seen = new Set(), result = [];
  for (const match of matches) {
    if (match.at < end) continue;
    end = match.end;
    if (!seen.has(match.participant.id)) {
      seen.add(match.participant.id);
      result.push(match.participant);
    }
  }
  return result;
}

// Resolve a manager's explicit @-mentions against the agent roster. Native
// handoffs use this after Mia replies so the mention becomes a durable worker
// dispatch instead of relying on a transport-level trigger.
function resolveMentionedBots(body, participants, max = MAX_COORDINATED) {
  const workers = dedupe((participants || []).filter(Boolean))
    .filter((participant) => participant.manager !== true);
  return mentionedByName(String(body || '').toLowerCase(), workers).slice(0, max);
}

function dedupe(participants) {
  const seen = new Set();
  return participants.filter((participant) => participant && !seen.has(participant.id) && seen.add(participant.id));
}

function resolveConversationRouting(input) {
  const body = String((input && input.body) || '');
  const bodyLower = body.toLowerCase();
  const conversationType = (input && input.conversationType) || 'group';
  const participants = dedupe(((input && input.participants) || []).filter(Boolean));
  const selectedParticipant = (input && input.selectedParticipant) || null;
  const oneToOneBot = (input && input.oneToOneAgent) || null;
  const humanMentioned = !!(input && input.humanMentioned);
  const threadRootParticipantName = String((input && input.threadRootParticipantName) || '').trim().toLowerCase();
  const manager = participants.find((participant) => participant.manager) || null;
  const workers = participants.filter((participant) => !participant.manager);
  // Parse control tags and bot names together so a specific name such as
  // "All Hands" or "All-Hands" cannot accidentally become a broadcast.
  const controls = ['all', 'all_bots', 'all_users'].map((name) => ({ id: Symbol(name), name }));
  const mentionableWorkers = workers.filter((worker) => !controls.some((control) =>
    control.name === String(worker.name || '').trim().toLowerCase()));
  const mentions = mentionedByName(bodyLower, [...mentionableWorkers, ...controls], true);
  const mentionsAll = mentions.includes(controls[0]);
  const mentionsAllBots = mentionsAll || mentions.includes(controls[1]);
  const mentionsAllUsers = mentionsAll || mentions.includes(controls[2]);
  const named = mentions.filter((participant) => !controls.includes(participant)).slice(0, MAX_COORDINATED);
  const managerMentioned = !!manager && (mentionIndex(bodyLower, manager.name) !== -1 || /(^|\s)@mia\b/.test(bodyLower));

  const none = (reason) => ({ repliers: [], mode: 'none', coordinating: [], reason });
  const gateway = (reason) => ({ repliers: [], mode: 'gateway', coordinating: [], reason });
  const direct = (participant, reason) => ({ repliers: [participant], mode: 'direct', coordinating: [], reason });
  const coordinate = (agents, reason) => {
    const list = dedupe(agents).slice(0, MAX_COORDINATED);
    if (!list.length) return none(reason);
    return { repliers: [], mode: 'coordinate', coordinating: list, includeGateway: !!manager, reason };
  };

  // Private 1:1 identity is authoritative. Mentions are useful in shared
  // rooms, but they must never summon another worker into Mia's or a bot's
  // direct conversation.
  if (conversationType === 'agent' && oneToOneBot && oneToOneBot.manager) return gateway('manager conversation -> gateway');
  if (conversationType === 'bot' && oneToOneBot) return direct(oneToOneBot, 'one-to-one bot conversation');
  if (selectedParticipant) {
    if (selectedParticipant.manager && named.length) return coordinate(named, 'explicit manager + named participants');
    if (selectedParticipant.manager) return gateway('explicit manager selection -> gateway');
    return direct(selectedParticipant, 'explicit participant selection');
  }
  if (mentionsAllBots) {
    if (!workers.length) return manager ? gateway('all bots with no workers -> gateway') : none('all bots with nobody');
    return coordinate(workers, 'all bots');
  }
  if (named.length >= 2) return coordinate(named, 'two or more participants named');
  if (named.length === 1) {
    if (managerMentioned) return coordinate(named, 'manager plus one participant named');
    return direct(named[0], 'one participant named');
  }
  if (managerMentioned && manager) return gateway('manager named -> gateway');
  if (humanMentioned || mentionsAllUsers) return none('addressed to humans');
  if (threadRootParticipantName) {
    const rootParticipant = participants.find((participant) => String(participant.name || '').toLowerCase() === threadRootParticipantName);
    if (rootParticipant) return direct(rootParticipant, 'thread root participant');
  }
  return none('untagged shared conversation event');
}

module.exports = {
  MAX_COORDINATED,
  mentionIndex,
  mentionedByName,
  resolveMentionedBots,
  resolveConversationRouting,
};
