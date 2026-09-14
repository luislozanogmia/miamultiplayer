'use strict';

// Who answers a human message — one pure decision, shared by every room
// kind. Product rules:
//
//   * Silence is the default in any room with more than one human. An
//     untagged message is human conversation: no agent answers. Only a 1:1
//     agent room replies unprompted.
//   * Exactly one replier per human message: the one agent you tagged, or
//     Mia (the manager). Never a fan-out.
//   * Two or more agents tagged (or @all / @all_bots) -> Mia only. She
//     acknowledges, hands the work to the tagged agents, and summarises.
//     Tag one agent directly to bypass her.
//   * Mia is the only agent that may address other agents; agents never
//     trigger agents (enforced in server.js — only human sends reach this).
//   * Tagging a human alongside an agent does not silence the agent; only a
//     message addressed to humans alone (@email / @all_users, no agent
//     tagged) resolves to nobody.
//   * Inside a thread, the agent that authored the thread root is the
//     implicit addressee — a thread behaves like a 1:1.
//
// scopeAgents: every agent addressable in this room, INCLUDING the manager
// persona (manager:true). explicit: an agent the client picked outright
// (To: selector) — wins over everything. ownAgent: the one agent of a 1:1
// room. threadRootAgentName: signed author of the thread root, if any.
// humanMentioned: the body @-mentions a known human email.

const MAX_COORDINATED = 5;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Position of "@Name" in bodyLower (word-bounded on both sides), or -1.
function mentionIndex(bodyLower, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return -1;
  const match = new RegExp('(^|[^a-z0-9_])@' + escapeRe(normalized) + '(?![a-z0-9_-])').exec(bodyLower);
  return match ? match.index + match[1].length : -1;
}

function mentionedByName(bodyLower, list) {
  return list
    .map((a) => ({ a, at: mentionIndex(bodyLower, a && a.name) }))
    .filter((x) => x.at !== -1)
    .sort((x, y) => x.at - y.at)
    .map((x) => x.a);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((a) => a && !seen.has(a.id) && seen.add(a.id));
}

function resolveReplyRouting(input) {
  const body = String((input && input.body) || '');
  const bodyLower = body.toLowerCase();
  const roomKind = (input && input.roomKind) || 'group';
  const scope = dedupe(((input && input.scopeAgents) || []).filter(Boolean));
  const explicit = (input && input.explicit) || null;
  const ownAgent = (input && input.ownAgent) || null;
  const humanMentioned = !!(input && input.humanMentioned);
  const threadRootAgentName = String((input && input.threadRootAgentName) || '').trim().toLowerCase();

  const manager = scope.find((a) => a.manager) || null;
  const workers = scope.filter((a) => !a.manager);

  const mentionsAll = /@all\b/.test(bodyLower);
  const mentionsAllBots = mentionsAll || /@all_bots\b/.test(bodyLower);
  const mentionsAllUsers = mentionsAll || /@all_users\b/.test(bodyLower);
  const named = mentionedByName(bodyLower, workers);
  const miaNamed = !!manager && (mentionIndex(bodyLower, manager.name) !== -1 || /(^|\s)@mia\b/.test(bodyLower));

  const none = (reason) => ({ repliers: [], mode: 'none', coordinating: [], reason });
  const gateway = (reason) => ({ repliers: [], mode: 'gateway', coordinating: [], reason });
  const direct = (agent, reason) => ({ repliers: [agent], mode: 'direct', coordinating: [], reason });
  const coordinate = (agents, reason) => {
    const list = dedupe(agents).slice(0, MAX_COORDINATED);
    if (!manager) return list.length ? direct(list[0], reason + ' (no manager in scope)') : none(reason);
    // ONE MIA: even in coordinate mode the layer has no
    // Mia voice. repliers stays empty — the caller m.mentions the gateway
    // (Mia acks as herself) and dispatches `coordinating` into their own
    // threads as pure plumbing. No layer ack, no layer summary.
    return { repliers: [], mode: 'coordinate', coordinating: list, reason };
  };

  // 0. WHENEVER MIA HERSELF IS THE ONE CALLED — her own 1:1 room, @mia in
  // any room, an explicit Mia pick — the app layer doesn't reply at all:
  // the private manager agent answers directly with its full runtime
  // harness, exactly like Mia on Discord. The caller's
  // job in 'gateway' mode is to m.mention the gateway and post nothing
  // itself. Coordinate mode (two-plus agents tagged / @all) is gateway Mia
  // too: she acks as herself while the caller dispatches the tagged agents
  // as plumbing — there is exactly ONE Mia, always the gateway.
  // Worker 1:1 rooms are untouched: their ownAgent never carries manager.
  if (roomKind === 'agent' && ownAgent && ownAgent.manager) return gateway('mia 1:1 room -> hermes gateway');

  // 1. An outright pick from the client wins.
  if (explicit) {
    if (explicit.manager && named.length) return coordinate(named, 'explicit manager + named agents');
    if (explicit.manager) return gateway('explicit mia pick -> hermes gateway');
    return direct(explicit, 'explicit pick');
  }
  // 2. Group tags addressed at bots -> Mia coordinates everyone in scope.
  if (mentionsAllBots) {
    if (!workers.length) return manager ? gateway('@all with no agents -> hermes gateway') : none('@all with nobody');
    return coordinate(workers, '@all / @all_bots');
  }
  // 3. Tagged agents.
  if (named.length >= 2) return coordinate(named, 'two or more agents tagged');
  if (named.length === 1) {
    if (miaNamed) return coordinate(named, 'mia + one agent tagged');
    return direct(named[0], 'one agent tagged');
  }
  if (miaNamed && manager) return gateway('mia tagged -> hermes gateway');
  // 4. Nobody tagged. Addressed to humans -> silence, everywhere.
  if (humanMentioned || mentionsAllUsers) return none('addressed to humans');
  // 5. Implicit addressees: the 1:1 room's own agent, or the thread root's author.
  if (roomKind === 'agent' && ownAgent) return direct(ownAgent, '1:1 room');
  if (threadRootAgentName) {
    const rootAgent = scope.find((a) => String(a.name || '').toLowerCase() === threadRootAgentName);
    if (rootAgent) return direct(rootAgent, 'thread root author');
  }
  // 6. Untagged in a shared room: human conversation.
  return none('untagged in a shared room');
}

module.exports = { resolveReplyRouting, mentionIndex, mentionedByName, MAX_COORDINATED };
