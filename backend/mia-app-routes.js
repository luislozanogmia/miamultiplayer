'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { summarizeWork, workResults } = require('./browser-work-proposal');
const { safeBrowserPageUrl } = require('./browser-context');
const { DEFAULT_WORKSPACE_ID } = require('./workspace-scope');
const { fetchAppLogo } = require('./safe-logo-fetch');

const TRUST_CATEGORIES = ['browserWork', 'automations', 'bots'];
const ACTIVITY_LIMIT = 200;
function trustFor(settings, owner) {
  const saved = settings?.miaTrustByUser?.[owner] || {};
  return Object.fromEntries(TRUST_CATEGORIES.map(name => [name, saved[name] === true]));
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const seg = value => encodeURIComponent(String(value ?? ''));
function text(value, field, max = 20000) {
  const found = typeof value === 'string' ? value.trim() : '';
  if (!found) throw fail(400, `${field} is required`);
  if (found.length > max) throw fail(400, `${field} is too long`);
  return found;
}
function changedLines(before, after) {
  const counts = new Map();
  for (const line of String(before).split('\n')) counts.set(line, (counts.get(line) || 0) + 1);
  let added = 0;
  for (const line of String(after).split('\n')) {
    if (counts.get(line) > 0) counts.set(line, counts.get(line) - 1);
    else added += 1;
  }
  return { added, removed: [...counts.values()].reduce((sum, left) => sum + left, 0) };
}
function botSummary(bot) {
  return {
    id: bot.id, name: bot.name, status: bot.status, owner: bot.owner, departments: bot.departments || [],
    automations: (bot.automations || []).map(item => ({ id: item.id, name: item.name, enabled: item.enabled !== false, schedule: item.schedule })),
    updatedAt: bot.updatedAt,
  };
}
// What Mia is told once the person answers a card she is waiting on. The note
// posts into her chat as a system line from the person's session, so her turn
// goes on by itself; `line` is what the person sees, `text` what Mia reads.
// A key is never part of either: only whether it is saved.
const APP_NOTE = 'Note from the Mia app, not typed by the person:';
const oneLine = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
function mcpAppFollowUp(proposal) {
  const name = oneLine(proposal.result?.name || proposal.input?.name, 80) || 'The app';
  if (proposal.status === 'dismissed') {
    return { line: `Mia was told you dismissed ${name}.`,
      text: `they dismissed your card to add ${name} to Connected apps, so it was not added. Carry on without it, and do not propose it again unless they ask.` };
  }
  if (proposal.status === 'failed') {
    return { line: `Mia was told adding ${name} failed.`,
      text: `they accepted your card, but adding ${name} to Connected apps failed: ${oneLine(proposal.error, 300).replace(/[.\s]+$/, '') || 'no reason given'}. Tell them in one short line and say what they can do next.` };
  }
  if (proposal.status !== 'accepted') return null;
  const ready = { line: `Mia was told ${name} is ready.`,
    text: `they accepted your card, and ${name} is now in Connected apps and ready to use. Carry on with what you were doing.` };
  if (proposal.result?.status === 'needs_key' && proposal.result.app_id) {
    return { keyApp: String(proposal.result.app_id), ready, line: `Mia was told ${name} is waiting for its key.`,
      text: `they accepted your card, and ${name} is now in Connected apps, but it cannot work until they save its key in its key field there. Never ask for the key in chat. Tell them that in one short line, carry on with anything that does not need ${name}, and wait: another note comes when the key is saved.` };
  }
  if (proposal.result?.status === 'needs_sign_in' && proposal.result.app_id) {
    return { keyApp: String(proposal.result.app_id), ready, line: `Mia was told ${name} is waiting for its sign-in.`,
      text: `they accepted your card, and ${name} is now in Connected apps, but it cannot work until they sign in to it. Its sign-in page opens in their browser by itself; if they closed it, the Sign in button is on ${name} in Connected apps. Tell them that in one short line, carry on with anything that does not need ${name}, and wait: another note comes when they are signed in.` };
  }
  return ready;
}
function mcpAppKeyNote(name) {
  const app = oneLine(name, 80) || 'The app';
  return { line: `Mia was told ${app}'s key was saved.`,
    text: `${APP_NOTE} the key for ${app} was saved in Connected apps, so ${app} is ready to use. Carry on with what you were doing.` };
}
function mcpAppSignedInNote(name) {
  const app = oneLine(name, 80) || 'The app';
  return { line: `Mia was told you signed in to ${app}.`,
    text: `${APP_NOTE} they signed in to ${app}, so ${app} is ready to use. Carry on with what you were doing.` };
}
// Several answered cards from one of Mia's replies become one note.
function answerNote(parts) {
  return {
    line: parts.map(part => part.line).join(' '),
    text: parts.length === 1 ? `${APP_NOTE} ${parts[0].text}` : [APP_NOTE, ...parts.map(part => `- ${part.text}`)].join('\n'),
  };
}

function lastRunsByBot(checklists) {
  const runs = {};
  for (const item of checklists || []) (runs[item.botId] = runs[item.botId] || []).push(item);
  return runs;
}

// Every tool Mia can reach through `mia-app`. A route that is not listed here
// cannot be called, whatever Mia asks for. A runs at once, B runs and is logged,
// C becomes a card unless the person switched its trust category on. A C tool
// with no category reaches other people, so it always asks.
function createMiaAppTools({ browserWork, botRuns, botAutomationActions, automationDestination, workspaceDir, botModel }) {
  const coordinator = () => {
    const found = browserWork();
    if (!found) throw fail(409, 'Browser work is not available');
    return found;
  };
  async function botOf(call, id) {
    const { bot } = await call('GET', `/api/bots/${seg(text(id, 'bot_id', 200))}`).then(found => ({ bot: found.bot || found }));
    return bot;
  }
  async function saveAutomation(call, { bot_id, automation_id, automation }) {
    const bot = await botOf(call, bot_id);
    const checked = botAutomationActions.normalizeAutomationAction({
      schemaVersion: botAutomationActions.SCHEMA_VERSION,
      action: automation_id ? 'update' : 'create',
      ...(automation_id ? { automationId: automation_id } : {}),
      automation,
    }, bot);
    if (checked.error) throw fail(400, checked.error);
    return { bot, fields: checked.proposal.automation };
  }
  const tools = {
    list_tools: { group: 'A', description: 'List every tool, its group and arguments.', args: {}, async run() {
      return Object.entries(tools).map(([name, tool]) => ({ name, group: tool.group, description: tool.description, arguments: tool.args }));
    } },
    bots_list: { group: 'A', description: 'Every bot with its automations, last run and failed steps.', args: {}, async run({ call }) {
      const [{ bots }, active] = await Promise.all([call('GET', '/api/bots'), call('GET', '/api/automations/active')]);
      const runs = lastRunsByBot(active.checklists);
      return { bots: bots.map(bot => ({ ...botSummary(bot), lastRuns: runs[bot.id] || [] })) };
    } },
    skills_list: { group: 'A', description: 'The skills library: each skill with the bots that carry it.', args: {}, async run({ call }) {
      return call('GET', '/api/skills');
    } },
    skill_get: { group: 'A', description: "One skill folder: SKILL.md, every other file in it with its text, and the bots that carry it.", args: { skill_id: 'string' }, async run({ call, args }) {
      return call('GET', `/api/skills/${seg(text(args.skill_id, 'skill_id', 80))}`);
    } },
    mcp_apps_list: { group: 'A', description: 'Your own MCP apps in Connected apps (beside Google): name, where its server runs, how you sign in, and its status: ready, signed_in, needs_key (they paste it in Connected apps), or needs_sign_in (they press Sign in on it in Connected apps; it opens in their browser).', args: {}, run: ({ call }) => call('GET', '/api/mcp-apps') },
    marketplace_list: { group: 'A', description: "The Bot marketplace's From Mia shelf: each bot with what it does, its skills and whether the person already has it.", args: {}, async run({ call }) {
      const [index, { bots }] = await Promise.all([call('GET', '/api/bots/catalog'), call('GET', '/api/bots')]);
      const have = new Set(bots.map(bot => String(bot.name || '').trim().toLowerCase()));
      const manifests = await Promise.all((index.bots || []).map(entry => call('GET', `/api/bots/catalog/${seg(entry.id)}`).catch(() => null)));
      return { bots: manifests.filter(Boolean).map(manifest => ({
        id: manifest.id, name: manifest.bot.name, version: manifest.version, about: manifest.store && manifest.store.tagline,
        skills: (manifest.skills || []).map(skill => ({ name: skill.name, description: skill.description, files: ['SKILL.md', ...(skill.files || []).map(file => file.path)] })),
        installed: have.has(String(manifest.bot.name || '').trim().toLowerCase()),
      })) };
    } },
    bot_get: { group: 'A', description: "One bot's instructions, automations, departments and last run.", args: { bot_id: 'string' }, async run({ call, args }) {
      const bot = await botOf(call, args.bot_id);
      const active = await call('GET', '/api/automations/active');
      return { ...botSummary(bot), instructions: bot.instructions || bot.role || bot.output || '', lastRuns: lastRunsByBot(active.checklists)[bot.id] || [] };
    } },
    bot_runs: { group: 'A', description: "A bot's run reports: steps, failures and escalations.", args: { bot_id: 'string', limit: 'number, optional' }, async run({ call, args }) {
      const bot = await botOf(call, args.bot_id);
      return { botId: bot.id, runs: botRuns(bot.id, Math.min(Number(args.limit) || 50, 200)) };
    } },
    automations_list: { group: 'A', description: 'Every saved automation, what is running now and the latest step checklists.', args: {}, async run({ call }) {
      const [{ bots }, active] = await Promise.all([call('GET', '/api/bots'), call('GET', '/api/automations/active')]);
      return {
        automations: bots.flatMap(bot => (bot.automations || []).map(item => ({
          botId: bot.id, botName: bot.name, id: item.id, name: item.name, enabled: item.enabled !== false, schedule: item.schedule, steps: item.steps || [],
        }))),
        running: active.runs, checklists: active.checklists,
      };
    } },
    chat_threads: { group: 'A', description: 'The chats and channels the person can see.', args: {}, async run({ call }) {
      const { conversations } = await call('GET', '/api/conversations');
      return { threads: conversations.map(item => ({ id: item.id, type: item.type, title: item.title || item.name || '', updatedAt: item.updatedAt, botArchived: item.metadata?.botArchived === true })) };
    } },
    chat_read: { group: 'A', description: "A chat's recent messages.", args: { conversation_id: 'string', limit: 'number, optional' }, async run({ call, args }) {
      const limit = Math.min(Number(args.limit) || 30, 100);
      const { events } = await call('GET', `/api/conversations/${seg(text(args.conversation_id, 'conversation_id', 200))}/events?latest=true&limit=${limit}`);
      return { messages: events.map(item => ({ id: item.id, type: item.type, senderId: item.senderId, senderType: item.senderType, text: item.content?.text || '', at: item.createdAt })) };
    } },
    artifacts_list: { group: 'A', description: 'Saved files and apps shown in Artifacts.', args: {}, run: ({ call }) => call('GET', '/api/artifacts') },
    apps_list: { group: 'A', description: 'Web apps found in the workspace.', args: {}, run: ({ call }) => call('GET', '/api/apps/local') },
    departments_list: { group: 'A', description: 'The departments.', args: {}, run: ({ call }) => call('GET', '/api/departments') },
    users_list: { group: 'A', description: 'The people in this workspace.', args: {}, run: ({ call }) => call('GET', '/api/users') },
    instance_get: { group: 'A', description: 'This Mia instance.', args: {}, async run({ call }) {
      const { name, localPreview } = await call('GET', '/api/instance');
      return { name, localPreview: localPreview === true };
    } },
    connections_status: { group: 'A', description: 'Whether Google is connected.', args: {}, async run({ call }) {
      const found = await call('GET', '/api/connections/google/account');
      return { google: { state: found.state, connected: found.connected === true } };
    } },
    browser_work_status: { group: 'A', description: 'Browser bot work in progress.', args: { work_id: 'string, optional' }, async run({ owner, args }) {
      if (args.work_id) return summarizeWork(await coordinator().get(owner, String(args.work_id)));
      const works = await coordinator().list(owner);
      return { works: works.map(summarizeWork) };
    } },
    browser_work_results: { group: 'A', description: 'What the browser bots found.', args: { work_id: 'string' }, async run({ owner, args }) {
      return workResults(await coordinator().get(owner, String(args.work_id || '')));
    } },

    chat_post: { group: 'B', description: 'Post in a chat and @-mention a bot to hand it a task. A chat with other people asks the person first.', args: { conversation_id: 'string', text: 'string' },
      async run(ctx) {
        const { call, args, turn, propose, log } = ctx;
        const conversationId = text(args.conversation_id, 'conversation_id', 200);
        const body = text(args.text, 'text');
        if (conversationId === turn?.conversationId) throw fail(400, 'Reply here normally; chat_post is for another chat.');
        const { conversation } = await call('GET', `/api/conversations/${seg(conversationId)}`);
        if (conversation.type === 'agent' && !conversation.metadata?.botId) throw fail(400, "That is one of Mia's own chats.");
        const { members } = await call('GET', `/api/conversations/${seg(conversationId)}/members`);
        const others = (members || []).filter(item => item.principalType === 'user' && String(item.principalId).toLowerCase() !== ctx.owner);
        if (others.length) return propose({ summary: `Post in ${conversation.title || 'a chat'} (${others.length + 1} people)`, details: [body], input: { conversation_id: conversationId, text: body } });
        const posted = await tools.chat_post.apply(ctx, { conversation_id: conversationId, text: body });
        return log({ summary: `Posted in ${conversation.title || 'a chat'}`, result: posted, undo: { method: 'DELETE', path: `/api/conversations/${seg(conversationId)}/events/${seg(posted.event_id)}` } });
      },
      trust: null,
      async apply({ call, turn }, input) {
        const created = await call('POST', `/api/conversations/${seg(input.conversation_id)}/events`, {
          content: { text: input.text },
          clientIdempotencyKey: `mia-app-${crypto.createHash('sha256').update(`${turn?.session || ''}\n${input.conversation_id}\n${input.text}`).digest('hex').slice(0, 40)}`,
          metadata: { postedByMia: true, ...(turn?.session ? { miaTurn: turn.session } : {}) },
        });
        return { event_id: created.event?.id, conversation_id: input.conversation_id };
      } },
    artifact_save: { group: 'B', description: 'Check a workspace file shows in Artifacts and get its id.', args: { path: 'string' }, async run({ call, args, log }) {
      const { artifacts, folder } = await call('GET', '/api/artifacts');
      const wanted = text(args.path, 'path', 1000);
      const relative = path.isAbsolute(wanted) ? path.relative(folder, wanted) : wanted;
      const found = artifacts.find(item => item.id === `file:${relative.split(path.sep).join('/')}`);
      if (!found) throw fail(404, `That file is not in Artifacts. Save a supported file inside ${folder}, outside any hidden folder.`);
      return log({ summary: `Saved ${found.name} to Artifacts`, result: { artifact: found } });
    } },
    artifact_link: { group: 'B', description: 'Save an http or https app address in Artifacts. Only the person sees it.', args: { url: 'string', name: 'string, optional' }, async run({ call, args, log }) {
      const { artifact } = await call('POST', '/api/artifacts/links', { url: text(args.url, 'url', 2000), name: args.name });
      return log({ summary: `Saved ${artifact.name} to Artifacts`, result: { artifact }, undo: { method: 'DELETE', path: `/api/artifacts/links/${seg(artifact.id)}` } });
    } },
    app_bundle_local: { group: 'B', description: 'Package a workspace web app into a file in the workspace. Installs nothing.', args: { id: 'string', name: 'string, optional' }, async run({ call, args, log }) {
      const { bytes, filename } = await call('POST', '/api/apps/local/bundle', { id: text(args.id, 'id', 1000), name: args.name }, { raw: true });
      const folder = path.join(workspaceDir(), 'App bundles');
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, path.basename(filename));
      fs.writeFileSync(target, bytes);
      return log({ summary: `Packaged ${path.basename(filename)}`, result: { path: target, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } });
    } },
    bot_instructions_update: { group: 'B', description: "Replace a bot's instructions. The person can undo it from What Mia did.", args: { bot_id: 'string', instructions: 'string' }, async run({ call, args, log }) {
      const bot = await botOf(call, args.bot_id);
      const instructions = text(args.instructions, 'instructions', 100000);
      const previous = bot.instructions || bot.role || bot.output || '';
      await call('PUT', `/api/bots/${seg(bot.id)}`, { instructions, expectedInstructionsRevision: bot.instructionsRevision });
      // Undo names the revision this edit made, so it can't overwrite a later edit.
      const saved = await botOf(call, bot.id);
      return log({ summary: `Changed ${bot.name}'s instructions`, result: { bot_id: bot.id, ...changedLines(previous, instructions) },
        undo: { method: 'PUT', path: `/api/bots/${seg(bot.id)}`, body: { instructions: previous, expectedInstructionsRevision: saved.instructionsRevision } } });
    } },

    bot_create_propose: { group: 'C', trust: 'bots', description: 'Ask to create a bot.', args: { name: 'string', instructions: 'string', departments: 'string[], optional' },
      prepare({ args }) {
        const name = text(args.name, 'name', 120);
        const instructions = text(args.instructions, 'instructions', 100000);
        const departments = Array.isArray(args.departments) ? args.departments.map(String).slice(0, 20) : [];
        return { summary: `Create the bot ${name}`, details: [instructions, ...(departments.length ? [`Departments: ${departments.join(', ')}`] : [])], input: { name, instructions, departments } };
      },
      async apply({ call, owner }, input) {
        const model = await botModel(owner);
        if (!model) throw fail(409, 'Connect a model in Mia first.');
        const created = await call('POST', '/api/bots', { name: input.name, instructions: input.instructions, model, ...(input.departments.length ? { departments: input.departments } : {}) });
        const bot = created.bot || created;
        return { bot_id: bot.id, name: bot.name };
      } },
    automation_propose: { group: 'C', trust: 'automations', description: "Ask to add or change a bot's automation. automation has name, schedule and steps (a list of instructions). schedule has frequency (interval, daily, weekly, monthly) and time (09:00); add weekdaysOnly: true on daily for Monday to Friday, day on weekly (a full weekday name) or monthly (a day of the month), intervalMinutes on interval.", args: { bot_id: 'string', automation_id: 'string, to change one', automation: 'object' },
      async prepare({ call, args }) {
        const { bot, fields } = await saveAutomation(call, args);
        const schedule = fields.schedule ? Object.values(fields.schedule).join(' ') : '';
        return { summary: `${args.automation_id ? 'Change' : 'Add'} ${bot.name}'s automation ${fields.name}`, details: [`Schedule: ${schedule}`, ...(fields.steps || [])], input: { bot_id: bot.id, ...(args.automation_id ? { automation_id: args.automation_id } : {}), automation: fields } };
      },
      async apply({ call }, input) {
        const { bot, fields } = await saveAutomation(call, input);
        const existing = input.automation_id ? (bot.automations || []).find(item => item.id === input.automation_id) : null;
        const record = botAutomationActions.automationRecordFromProposal(fields, existing, automationDestination(bot));
        await call('PUT', `/api/bots/${seg(bot.id)}`, { automations: existing
          ? bot.automations.map(item => (item.id === existing.id ? record : item))
          : [...(bot.automations || []), record] });
        return { bot_id: bot.id, automation_id: record.id };
      } },
    automation_pause_propose: { group: 'C', trust: 'automations', description: 'Ask to pause or resume an automation.', args: { bot_id: 'string', automation_id: 'string', paused: 'boolean, default true' },
      async prepare({ call, args }) {
        const bot = await botOf(call, args.bot_id);
        const found = (bot.automations || []).find(item => item.id === args.automation_id);
        if (!found) throw fail(404, 'That bot has no such automation.');
        const paused = args.paused !== false;
        return { summary: `${paused ? 'Pause' : 'Resume'} ${bot.name}'s automation ${found.name}`, details: [], input: { bot_id: bot.id, automation_id: found.id, paused } };
      },
      async apply({ call }, input) {
        const bot = await botOf(call, input.bot_id);
        await call('PUT', `/api/bots/${seg(bot.id)}`, { automations: (bot.automations || []).map(item => (item.id === input.automation_id ? { ...item, enabled: !input.paused } : item)) });
        return { bot_id: bot.id, automation_id: input.automation_id, paused: input.paused };
      } },
    browser_work_start: { group: 'C', trust: 'browserWork', description: 'Ask to start the suggestion from ghost_work_propose. The person confirms in a dialog.', args: { proposal_id: 'string' },
      prepare() { throw fail(409, 'Browser work starts from the desktop app.'); } },
    bot_archive_propose: { group: 'C', trust: 'bots', description: 'Ask to archive a bot.', args: { bot_id: 'string' },
      async prepare({ call, args }) {
        const bot = await botOf(call, args.bot_id);
        return { summary: `Archive the bot ${bot.name}`, details: ['Its chat stays, read-only. It can be restored.'], input: { bot_id: bot.id } };
      },
      async apply({ call }, input) {
        await call('DELETE', `/api/bots/${seg(input.bot_id)}`);
        return { bot_id: input.bot_id, archived: true };
      } },
    bot_departments_propose: { group: 'C', trust: 'bots', description: 'Ask to add a bot to a department.', args: { bot_id: 'string', department: 'string' },
      async prepare({ call, args }) {
        const bot = await botOf(call, args.bot_id);
        const department = text(args.department, 'department', 120);
        return { summary: `Add ${bot.name} to ${department}`, details: [], input: { bot_id: bot.id, department } };
      },
      async apply({ call }, input) {
        await call('POST', `/api/bots/${seg(input.bot_id)}/departments`, { add: input.department });
        return { bot_id: input.bot_id, department: input.department };
      } },
    // Skills go into the prompt of every bot that carries them, so changing
    // one, or what a bot carries, always asks the person.
    skill_save_propose: { group: 'C', trust: null, description: 'Ask to create a skill, or change one (give skill_id). A skill is a folder: body is its SKILL.md (what it is, when to use it, the steps); files are the other files it points to, each {path, body}, such as ICP.md or search.py. Leaving files out keeps the ones it has.', args: { skill_id: 'string, to change one', name: 'string', description: 'string', body: 'string', files: '{path, body}[], optional' },
      async prepare({ call, args }) {
        const existing = args.skill_id ? (await call('GET', `/api/skills/${seg(text(args.skill_id, 'skill_id', 80))}`)).skill : null;
        const input = { ...(existing ? { skill_id: existing.id } : {}), name: text(args.name, 'name', 64), description: String(args.description || '').trim(),
          body: text(args.body, 'body', 20000), ...(Array.isArray(args.files) ? { files: args.files.map(file => ({ path: String(file && file.path || ''), body: String(file && file.body || '') })) } : {}) };
        const files = input.files ? input.files.map(file => file.path) : (existing ? existing.files.map(file => file.path) : []);
        return { summary: existing ? `Change the skill ${existing.name}` : `Create the skill ${input.name}`,
          details: [input.description, `Files: ${['SKILL.md', ...files].join(', ')}`].filter(Boolean), input };
      },
      async apply({ call }, input) {
        const { skill_id: id, ...skill } = input;
        const saved = await call(id ? 'PUT' : 'POST', id ? `/api/skills/${seg(id)}` : '/api/skills', skill);
        return { skill_id: saved.skill.id, files: saved.skill.files.map(file => file.path) };
      } },
    bot_skills_propose: { group: 'C', trust: null, description: "Ask to set which skills a bot carries (up to 10, from skills_list). The list replaces the bot's current skills.", args: { bot_id: 'string', skill_ids: 'string[]' },
      async prepare({ call, args }) {
        const bot = await botOf(call, args.bot_id);
        const ids = Array.isArray(args.skill_ids) ? [...new Set(args.skill_ids.map(String))] : [];
        if (ids.length > 10) throw fail(400, 'A bot can carry up to 10 skills.');
        const { skills } = await call('GET', '/api/skills');
        const names = ids.map(id => (skills.find(skill => skill.id === id) || {}).name);
        if (names.some(name => !name)) throw fail(404, 'A skill is not in the library. Check skills_list.');
        return { summary: `Give ${bot.name} ${ids.length ? names.join(', ') : 'no skills'}`, details: [], input: { bot_id: bot.id, skill_ids: ids } };
      },
      async apply({ call }, input) {
        await call('PUT', `/api/bots/${seg(input.bot_id)}`, { skills: input.skill_ids });
        return { bot_id: input.bot_id, skill_ids: input.skill_ids };
      } },
    marketplace_get_propose: { group: 'C', trust: 'bots', description: "Ask to get a bot from the marketplace's From Mia shelf (marketplace_list). Its skills become skill folders in the library, then the bot carries them.", args: { catalog_id: 'string' },
      async prepare({ call, args }) {
        const manifest = await call('GET', `/api/bots/catalog/${seg(text(args.catalog_id, 'catalog_id', 80))}`);
        return { summary: `Get ${manifest.bot.name} from the Bot marketplace`, details: [manifest.store && manifest.store.tagline,
          ...(manifest.skills || []).map(skill => `Skill: ${skill.name}`)].filter(Boolean), input: { catalog_id: manifest.id } };
      },
      async apply({ call, owner }, input) {
        const manifest = await call('GET', `/api/bots/catalog/${seg(input.catalog_id)}`);
        const model = await botModel(owner);
        if (!model) throw fail(409, 'Connect a model in Mia first.');
        const skillIds = [];
        for (const skill of (manifest.skills || []).slice(0, 10)) {
          const saved = await call('POST', '/api/skills', { name: skill.name, description: skill.description || '', body: skill.body, files: skill.files || [] });
          skillIds.push(saved.skill.id);
        }
        const created = await call('POST', '/api/bots', { ...manifest.bot, model, ...(skillIds.length ? { skills: skillIds } : {}) });
        const bot = created.bot || created;
        return { bot_id: bot.id, name: bot.name, skill_ids: skillIds };
      } },
    // An app reaches Mia's tools and the data the person signs in to, so
    // adding one always asks. Its key never passes through here.
    mcp_app_add_propose: { group: 'C', trust: null, description: "Ask to add an MCP app to Connected apps (follow the mcp-apps skill). Give name, description, either url (the vendor's hosted https MCP server) or package (an npx/uvx package from the vendor) with runner and args, auth (oauth, key or none; for key, keyHeader for a url or keyEnv for a package), docs_url (the vendor page that names this server) and logo_url (the vendor's own logo image, https).", args: { name: 'string', description: 'string', url: 'string, or package', package: 'string, or url', runner: 'npx or uvx, with package', args: 'string[], optional', auth: 'oauth, key or none', keyHeader: 'string, optional', keyEnv: 'string, with package and key', docs_url: 'string', logo_url: 'string' },
      async prepare({ call, args }) {
        const { apps } = await call('GET', '/api/mcp-apps');
        const input = { name: args.name, description: args.description, url: args.url, package: args.package, runner: args.runner, args: args.args,
          auth: args.auth || 'none', keyHeader: args.keyHeader, keyEnv: args.keyEnv, docsUrl: args.docs_url };
        let checked;
        try { checked = require('./mcp-apps').cleanMcpApp(input, apps.map(app => app.id)); } catch (error) { throw fail(400, error.message); }
        if (!checked.docsUrl) throw fail(400, "Name the vendor's page for this server (docs_url), so the person can check it.");
        const logo = await fetchAppLogo(args.logo_url);
        const signIn = { oauth: 'Its sign-in opens in your browser when you accept.', key: 'You paste its key in Connected apps; it never goes through chat.', none: 'No sign-in.' }[checked.auth];
        return { summary: `Add ${checked.name} to Connected apps`,
          details: [checked.description, `Server: ${checked.url || `${checked.runner} ${checked.package}`}`,
            ...(!checked.url && checked.args.length ? [`Arguments: ${checked.args.join(' ')}`] : []),
            ...(checked.keyHeader ? [`Key header: ${checked.keyHeader}`] : []),
            ...(checked.keyEnv ? [`Key variable: ${checked.keyEnv}`] : []),
            `From: ${checked.docsUrl}`, signIn, logo ? 'With its logo.' : 'No logo found.'].filter(Boolean),
          input: { ...input, logo } };
      },
      async apply({ call }, input) {
        const added = await call('POST', '/api/mcp-apps', input);
        return { app_id: added.app.id, name: added.app.name, status: added.app.status };
      },
      // Mia proposed this mid-task, so the answer goes back to her and she
      // carries on (see answerNote below).
      followUp: mcpAppFollowUp },
    app_install_propose: { group: 'C', trust: null, description: "Ask to install one version of a company's app on this computer.", args: { team_id: 'string', app_id: 'string', version: 'string' },
      prepare({ args }) {
        const input = { team_id: text(args.team_id, 'team_id', 200), app_id: text(args.app_id, 'app_id', 200), version: text(args.version, 'version', 80) };
        return { summary: `Install ${input.app_id} ${input.version}`, details: [`From company ${input.team_id}`], input };
      },
      // The app's fingerprint and bytes come from the Hub, through the page.
      apply(_, input) { return { clientAction: 'installTeamApp', teamId: input.team_id, appId: input.app_id, version: input.version }; } },
    artifact_share_propose: { group: 'C', trust: null, description: 'Ask to send an artifact file into a chat.', args: { artifact_id: 'string', conversation_id: 'string', text: 'string, optional' },
      async prepare({ call, args }) {
        const id = text(args.artifact_id, 'artifact_id', 1000);
        const conversationId = text(args.conversation_id, 'conversation_id', 200);
        const [{ file }, { conversation }] = await Promise.all([call('GET', `/api/artifacts/file?id=${seg(id)}`), call('GET', `/api/conversations/${seg(conversationId)}`)]);
        return { summary: `Send ${file.filename} to ${conversation.title || 'a chat'}`, details: args.text ? [String(args.text).slice(0, 2000)] : [], input: { artifact_id: id, conversation_id: conversationId, text: args.text ? String(args.text).slice(0, 2000) : '' } };
      },
      async apply({ call }, input) {
        const { file } = await call('GET', `/api/artifacts/file?id=${seg(input.artifact_id)}`);
        const { attachment } = await call('POST', `/api/conversations/${seg(input.conversation_id)}/attachments`, { filename: file.filename, mimeType: file.mimeType, contentBase64: file.contentBase64 });
        const created = await call('POST', `/api/conversations/${seg(input.conversation_id)}/events`, {
          content: { text: input.text || file.filename, attachments: [attachment] }, metadata: { postedByMia: true },
        });
        return { event_id: created.event?.id };
      } },
  };
  return tools;
}

function createActivityLog(dataDir) {
  const fileFor = owner => path.join(dataDir, 'mia-activity', `${crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)}.json`);
  const read = owner => {
    try { return JSON.parse(fs.readFileSync(fileFor(owner), 'utf8')); } catch (_) { return []; }
  };
  const write = (owner, entries) => {
    const target = fileFor(owner);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(entries.slice(0, ACTIVITY_LIMIT)), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  };
  return {
    list: read,
    add(owner, entry) {
      const saved = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
      write(owner, [saved, ...read(owner)]);
      return saved;
    },
    update(owner, id, fields) { write(owner, read(owner).map(item => (item.id === id ? { ...item, ...fields } : item))); },
  };
}

// The tools reach the app through its own routes, under the person's session,
// so each route's owner and workspace checks still decide. Only this table
// picks those routes; nothing Mia sends becomes a path.
function routeCaller(req, workspace) {
  return async (method, pathname, body, { raw = false } = {}) => {
    const headers = { 'x-miaos-workspace': workspace };
    for (const name of ['cookie', 'authorization']) if (req.headers[name]) headers[name] = req.headers[name];
    // This call reaches the server over loopback, so its Origin has to name
    // loopback too. The person's own request already passed the Origin check.
    const local = `http://127.0.0.1:${req.socket.localPort}`;
    if (req.headers.origin) headers.origin = local;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${local}${pathname}`, {
      method, headers, redirect: 'error', ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (raw && response.ok) {
      return { bytes: Buffer.from(await response.arrayBuffer()), filename: decodeURIComponent(response.headers.get('x-mia-app-filename') || 'app.miaapp') };
    }
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw fail(response.status, data.message || data.error || 'The Mia app could not do that.');
    return data;
  };
}
const publicEntry = ({ undo, ...entry }) => ({ ...entry, canUndo: !!undo && !entry.undoneAt });

function registerMiaAppRoutes(app, { requireAuth, requireInteractiveAuth, loadSettings, saveSettings, tools, activity, resolveTurn, postCard, findCard, updateCard, listCards = () => [], postNote = null }) {
  const ownerOf = req => String(req.userEmail).toLowerCase();
  app.get('/api/mia-app/trust', requireAuth, (req, res) => res.json({ trust: trustFor(loadSettings(), ownerOf(req)) }));
  app.post('/api/mia-app/trust', requireInteractiveAuth, (req, res) => {
    const owner = ownerOf(req);
    const settings = loadSettings();
    const next = trustFor(settings, owner);
    for (const name of TRUST_CATEGORIES) if (typeof req.body?.[name] === 'boolean') next[name] = req.body[name];
    settings.miaTrustByUser = { ...(settings.miaTrustByUser || {}), [owner]: next };
    saveSettings(settings);
    res.json({ trust: next });
  });
  app.get('/api/mia-app/activity', requireInteractiveAuth, (req, res) => res.json({ activity: activity.list(ownerOf(req)).map(publicEntry) }));
  app.post('/api/mia-app/activity/:id/undo', requireInteractiveAuth, async (req, res) => {
    const owner = ownerOf(req);
    const entry = activity.list(owner).find(item => item.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    if (!entry.undo || entry.undoneAt) return res.status(409).json({ error: 'This cannot be undone.' });
    try {
      await routeCaller(req, entry.workspace || DEFAULT_WORKSPACE_ID)(entry.undo.method, entry.undo.path, entry.undo.body);
      activity.update(owner, entry.id, { undoneAt: new Date().toISOString() });
      res.json({ ok: true });
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'That could not be undone.' }); }
  });
  app.post('/api/mia-app/call', requireInteractiveAuth, async (req, res) => {
    const tool = Object.hasOwn(tools, req.body?.tool) ? tools[req.body.tool] : null;
    if (!tool) return res.status(403).json({ error: 'Mia cannot use that tool' });
    const args = req.body?.arguments && typeof req.body.arguments === 'object' && !Array.isArray(req.body.arguments) ? req.body.arguments : {};
    const owner = ownerOf(req);
    // A session the backend cannot place, or a bot's, gets nothing. Reads the
    // desktop host makes for itself carry no session and act only as the person.
    const session = typeof req.body?.turn === 'string' ? req.body.turn : '';
    const target = session ? resolveTurn(session, owner) : null;
    if ((session && (!target || target.botId)) || (!target && tool.group !== 'A')) return res.status(403).json({ error: 'Only Mia, in a chat turn, can use this' });
    const turn = target ? { session, conversationId: target.conversationId, companyId: target.companyId } : null;
    const workspace = target ? target.workspace : DEFAULT_WORKSPACE_ID;
    const call = routeCaller(req, workspace);
    const name = req.body.tool;
    const log = ({ result, ...entry }) => {
      activity.add(owner, { tool: name, workspace, turn: session, conversationId: turn?.conversationId, ...entry });
      return result;
    };
    // Reading a page always ends in a card that says so, trust switch or not.
    // The page controls its title, which can itself contain a reset link or
    // token. The cleaned URL is enough to show where the request came from.
    const reading = req.body?.reading && typeof req.body.reading === 'object'
      ? { url: safeBrowserPageUrl(req.body.reading.url), title: '' } : null;
    const propose = ({ summary, details, input }) => {
      const eventId = postCard(target, { id: `mia-app-${crypto.randomUUID()}`, tool: name, summary, details, input, status: 'pending', requestedBy: owner, turn: session, ...(reading ? { reading } : {}) });
      return { proposed: true, event_id: eventId, next: 'Shown to the person as a card in this chat. Nothing changes until they accept it.' };
    };
    const ctx = { owner, args, turn, call, log, propose };
    try {
      if (tool.group !== 'C') return res.json({ result: await tool.run(ctx) });
      const plan = await tool.prepare(ctx);
      if (tool.trust && trustFor(loadSettings(), owner)[tool.trust] && !reading) {
        const result = await tool.apply(ctx, plan.input);
        log({ summary: plan.summary, via: 'trusted' });
        return res.json({ result });
      }
      return res.json({ result: propose(plan) });
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'That Mia tool failed' }); }
  });
  // When the person answers a card Mia is waiting on (a tool with followUp),
  // Mia is told in a note and carries on. Cards from one of her replies wait
  // for each other and go as one note, so answering three cards starts one
  // turn, not three. The note's key is the card's id, so it posts once.
  const followsUp = proposal => !!proposal && Object.hasOwn(tools, proposal.tool) && typeof tools[proposal.tool].followUp === 'function';
  const keyWaits = () => loadSettings().miaAppKeyWaits || {};
  const saveKeyWaits = (owner, waits) => {
    const settings = loadSettings();
    const all = { ...(settings.miaAppKeyWaits || {}) };
    if (Object.keys(waits).length) all[owner] = waits; else delete all[owner];
    settings.miaAppKeyWaits = all;
    saveSettings(settings);
  };
  function settleAnswer(card, owner, chatModelSelection) {
    if (!postNote || !followsUp(card.proposal)) return null;
    const part = tools[card.proposal.tool].followUp(card.proposal);
    if (!part) return null;
    const { keyApp, ready, ...shown } = part;
    card.proposal = { ...card.proposal, followUp: { ...shown, ...(keyApp ? { keyApp, ready } : {}) } };
    let event = updateCard(card, card.proposal);
    if (keyApp) {
      const waits = { ...(keyWaits()[owner] || {}) };
      waits[keyApp] = { companyId: card.companyId, conversationId: card.conversationId, eventId: card.event.id, name: card.proposal.result?.name || '',
        ...(chatModelSelection ? { chatModelSelection } : {}) };
      saveKeyWaits(owner, waits);
    }
    const turn = card.proposal.turn;
    const siblings = turn ? listCards(card).filter(other => other.event.id !== card.event.id && other.proposal.turn === turn && followsUp(other.proposal)) : [];
    if (siblings.some(other => other.proposal.status === 'pending' || other.proposal.status === 'applying')) return { event, held: true };
    const group = [...siblings.filter(other => other.proposal.followUp && !other.proposal.followUp.sentAt), card];
    // A key saved while this note waited is already in: say it is ready.
    const waits = { ...(keyWaits()[owner] || {}) };
    let told = false;
    const parts = group.map(({ event, proposal }) => {
      const { keyApp: app, ready: readyPart, line, text } = proposal.followUp;
      if (!app) return { line, text };
      if (!waits[app] || waits[app].eventId !== event.id) return readyPart || { line, text };
      waits[app] = { ...waits[app], noteSent: true };
      told = true;
      return { line, text };
    });
    if (told) saveKeyWaits(owner, waits);
    const note = answerNote(parts);
    const sentAt = new Date().toISOString();
    for (const answered of group) {
      const updated = updateCard(answered, { ...answered.proposal, followUp: { ...answered.proposal.followUp, sentAt } });
      if (answered === card) event = updated;
    }
    try {
      return { event, note: postNote({ companyId: card.companyId, conversationId: card.conversationId, owner }, {
        text: note.text, key: `mia-app-answer-${card.event.id}`,
        metadata: { miaAppNote: { line: note.line, cards: group.map(answered => answered.event.id) }, ...(chatModelSelection ? { chatModelSelection } : {}) },
      }) };
    } catch (_) { return { event }; }
  }
  // Connected apps saved an app's key, or the person finished its sign-in: if
  // Mia was told she is waiting on it, tell her it is in. Called only after
  // the key is written or the sign-in is saved.
  const keySaved = (owner, appId) => appReady(owner, appId, mcpAppKeyNote);
  const signedIn = (owner, appId) => appReady(owner, appId, mcpAppSignedInNote);
  function appReady(owner, appId, readyNote) {
    const waits = { ...(keyWaits()[owner] || {}) };
    const wait = waits[appId];
    if (!wait) return null;
    delete waits[appId];
    saveKeyWaits(owner, waits);
    // Not yet told about the app at all: that note will say it is ready.
    if (!wait.noteSent || !postNote) return null;
    const note = readyNote(wait.name);
    try {
      return postNote({ companyId: wait.companyId, conversationId: wait.conversationId, owner }, {
        text: note.text, key: `mia-app-key-${wait.eventId}`,
        metadata: { miaAppNote: { line: note.line, cards: [wait.eventId] }, ...(wait.chatModelSelection ? { chatModelSelection: wait.chatModelSelection } : {}) },
      });
    } catch (_) { return null; }
  }
  // The person's answer to a card. Only their own session reaches this, and
  // the app, not Mia, runs what the card says.
  app.post('/api/mia-app/proposals/:eventId', requireInteractiveAuth, async (req, res) => {
    const owner = ownerOf(req);
    const decision = req.body?.decision;
    if (decision !== 'accept' && decision !== 'dismiss') return res.status(400).json({ error: 'decision must be accept or dismiss' });
    const card = findCard(req, req.params.eventId, owner);
    const tool = card && Object.hasOwn(tools, card.proposal.tool) ? tools[card.proposal.tool] : null;
    if (!tool?.apply) return res.status(404).json({ error: 'not_found' });
    if (card.proposal.status !== 'pending') return res.status(409).json({ error: 'already_answered', proposal: card.proposal });
    // The model picked in the chat, so Mia carries on with the same one. The
    // dispatch checks it again, as it does for a typed message.
    const picked = req.body?.chatModelSelection;
    const chatModelSelection = picked && typeof picked === 'object' && !Array.isArray(picked) && JSON.stringify(picked).length <= 2000 ? picked : null;
    const answer = fields => {
      card.proposal = { ...card.proposal, ...fields, answeredAt: new Date().toISOString() };
      return updateCard(card, card.proposal);
    };
    // The card as it is now (with whether its note went), and the note.
    const withNote = event => {
      const settled = settleAnswer(card, owner, chatModelSelection);
      return { event: settled?.event || event, ...(settled?.note?.event ? { note: settled.note } : {}) };
    };
    if (decision === 'dismiss') return res.json(withNote(answer({ status: 'dismissed' })));
    answer({ status: 'applying' });
    const turn = { session: card.proposal.turn, conversationId: card.conversationId };
    try {
      const result = await tool.apply({ owner, turn, call: routeCaller(req, card.workspace) }, card.proposal.input);
      activity.add(owner, { tool: card.proposal.tool, workspace: card.workspace, turn: card.proposal.turn, conversationId: card.conversationId, summary: card.proposal.summary, via: 'accepted' });
      res.json({ ...withNote(answer({ status: 'accepted', result })), result });
    } catch (error) {
      const message = error.status ? error.message : 'That could not be done.';
      res.status(error.status || 500).json({ ...withNote(answer({ status: 'failed', error: String(message).slice(0, 300) })), error: message });
    }
  });
  return { keySaved, signedIn };
}
module.exports = { TRUST_CATEGORIES, trustFor, createActivityLog, createMiaAppTools, registerMiaAppRoutes };
