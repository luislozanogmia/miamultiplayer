'use strict';

// Ask-before-do: Mia's side of the gate in hermes-plugins/mia-ask-before-do.
// A risky tool call is blocked until the agent asks with request_approval and
// the user answers that request in the app. A yes unlocks that exact call once.
// A yes unlocks the call the gate saw, whatever the model says about it, and
// only the signed-in requester can answer, so the model cannot talk its way
// past this. The one line on the card is the model's own words. Scheduled runs
// have nobody to ask; they follow the prompt rule and the owner's automation.

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BYTES = 64 * 1024;
const MAX_SESSIONS = 500;
const MAX_LINE = 200;
const ANSWER_WINDOW_MS = 5 * 60 * 1000;

function blockedMessage(summary, requestId) {
  return `BLOCKED by ask-before-do, nothing ran: ${summary}. To ask the user, call request_approval with request_id `
    + `"${requestId}" and what_happens, one plain sentence on what will happen. They answer Yes or No, and a yes unlocks this exact action once. `
    + 'Do not ask in text first and do not reach the same result another way.';
}

function noUserMessage(summary) {
  return `BLOCKED by ask-before-do, nothing ran: ${summary}. Nobody can approve this here. Report it as waiting for the user.`;
}

// The actual operation, rather than the agent's proposed explanation, is the
// authority for the card. Never place command arguments or URL credentials in
// a concise card.
function actionLine(summary) {
  const raw = String(summary || 'this action');
  const browser = /^(?:Click |Close browser tab |Run page script |Browser )/.test(raw);
  if (!browser) {
    const category = /^(Send a message|Run code|Run a script|Run saved browser steps|Click)/.exec(raw)?.[1];
    if (category === 'Run code') return 'Run code that can change or delete files';
    if (category) return category;
    return describeCommand(raw);
  }
  const source = raw.replace(/https?:\/\/\S+/gi, value => {
    try { return new URL(value).origin; } catch (_) { return '[link]'; }
  }).replace(/\b(?:sk-|ghp_|xoxb-|AKIA)[A-Za-z0-9_-]+\b/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[value]');
  const flat = source.split(/\s+/).filter(Boolean).join(' ');
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}...` : flat;
}
// What a blocked command will do, in words a person can judge. Built from the
// command itself, never from the agent, and it names files and places but never
// passes along values: only a file's own name, a host, a branch.
const SECRETISH = /\b(?:sk-|ghp_|gho_|xox[abp]-|AKIA)[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,}/;
function plainName(value) {
  const text = String(value || '').replace(/^['"]|['"]$/g, '');
  if (['.', './'].includes(text)) return 'this folder';
  if (['~', '~/', '$HOME'].includes(text)) return 'your home folder';
  if (!text || SECRETISH.test(text) || text.length > 80) return '';
  return text.replace(/\/+$/, '').split('/').pop() || text;
}
function listOf(names) {
  const named = names.map(plainName).filter(Boolean);
  if (!named.length) return '';
  if (named.length === 1) return named[0];
  if (named.length <= 3) return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `${named.slice(0, 2).join(', ')} and ${named.length - 2} more`;
}
function hostOf(text) {
  const url = /https?:\/\/[^\s'"]+/i.exec(text);
  if (url) { try { return new URL(url[0]).host; } catch (_) { return ''; } }
  const host = /(?:^|\s)(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\S*)?(?=\s|$)/i.exec(text);
  return host ? host[1] : '';
}
// A combined command is described by the part that made it need a yes.
function describeCommand(raw) {
  const parts = raw.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter((part) => /\S/.test(part) && !/^(?:cd|export|set)\b/.test(part));
  const described = parts.map(describeSegment);
  return described.find((line) => !line.startsWith('Run the command')) || described[0] || describeSegment(raw);
}

function describeSegment(segment) {
  const raw = segment;
  const words = segment.trim().replace(/^sudo\s+/, '').split(/\s+/);
  const [tool, sub, ...rest] = words;
  const args = words.slice(1).filter((word) => !word.startsWith('-'));
  const lower = String(tool || '').toLowerCase();
  if (['rm', 'rmdir', 'unlink', 'shred', 'truncate'].includes(lower)) {
    const named = listOf(args);
    return named ? `Delete ${named}` : 'Delete files';
  }
  if (lower === 'mv' && /\.Trash\b/.test(segment)) return `Move ${listOf(args.slice(0, -1)) || 'files'} to the Trash`;
  if (lower === 'find' && /\s-delete\b/.test(segment)) return `Delete files found in ${plainName(args[0]) || 'a folder'}`;
  if (lower === 'git') {
    if (sub === 'push') {
      const [remote, branch] = rest.filter((word) => !word.startsWith('-'));
      return `Push your changes to ${[remote, branch].map(plainName).filter(Boolean).join('/') || 'the remote repository'}`;
    }
    if (sub === 'reset') return 'Discard every uncommitted change in this project';
    if (sub === 'clean') return 'Delete the files git does not track in this project';
    if (sub === 'branch') return `Delete the branch ${plainName(rest.filter((word) => !word.startsWith('-'))[0]) || ''}`.trim();
  }
  if (lower === 'gh') {
    const action = { create: 'Open', merge: 'Merge', close: 'Close', delete: 'Delete', comment: 'Comment on', edit: 'Edit' }[rest[0]];
    const thing = { pr: 'a pull request', issue: 'an issue', release: 'a release', repo: 'a repository', gist: 'a gist' }[sub];
    if (action && thing) return `${action} ${thing} on GitHub`;
  }
  if (['npm', 'pnpm', 'yarn'].includes(lower) && sub === 'publish') return 'Publish this package to the npm registry';
  if (lower === 'twine') return 'Publish this package to PyPI';
  if (lower === 'docker' && sub === 'push') return 'Publish a container image';
  if (['curl', 'wget', 'http'].includes(lower)) return `Send data to ${hostOf(segment) || 'a website'}`;
  if (['mail', 'mailx', 'sendmail', 'mutt', 'msmtp'].includes(lower)) return 'Send an email';
  if (['scp', 'sftp', 'rsync'].includes(lower)) return `Copy files to ${hostOf(segment) || 'another computer'}`;
  if (lower === 'ssh') return `Run a command on ${hostOf(segment) || 'another computer'}`;
  const cloud = { aws: 'AWS', gcloud: 'Google Cloud', az: 'Azure', kubectl: 'Kubernetes', terraform: 'cloud infrastructure' }[lower];
  if (cloud) return `Make a change in ${cloud}`;
  if (/^mcp_/.test(raw)) {
    const parts = raw.split(/\s/)[0].replace(/^mcp_/, '').split('_').filter((part) => !['google', 'workspace'].includes(part));
    const verbs = { send: 'Send', delete: 'Delete', remove: 'Remove', trash: 'Delete', create: 'Create', add: 'Add', update: 'Change',
      edit: 'Change', modify: 'Change', set: 'Change', post: 'Post', publish: 'Publish', share: 'Share', move: 'Move',
      reply: 'Reply to', forward: 'Forward', invite: 'Invite people to', write: 'Write' };
    const at = parts.findIndex((part) => verbs[part]);
    const app = { gmail: 'Gmail', drive: 'Google Drive', calendar: 'Google Calendar', sheets: 'Google Sheets', docs: 'Google Docs', slides: 'Google Slides' }[parts[0]] || parts[0];
    if (at < 0) return `Make a change with ${app}`;
    const object = parts.slice(at + 1).join(' ') || ({ gmail: 'an email', calendar: 'an event' }[parts[0]] || 'an item');
    const thing = object === 'message' ? 'an email' : /^(an?|the) /.test(object) || / /.test(object) || object.endsWith('s') ? object : `${/^[aeiou]/.test(object) ? 'an' : 'a'} ${object}`;
    return `${verbs[parts[at]]} ${thing} ${parts[0] === 'gmail' ? 'with' : 'in'} ${app}`;
  }
  return tool ? `Run the command ${plainName(tool) || 'shown'}` : 'Do this action';
}

function approvalCard(summary, chatOutput, whatHappens) {
  const line = actionLine(summary);
  const text = `Do you approve?\n\n${line}`;
  if (chatOutput !== 'verbose') return { text, line };
  return { text: `${text}\n\n${summary}`, line, summary };
}

const ANSWERS = {
  approved: 'Approved once. Run exactly the same call again now. Any other call needs its own approval.',
  declined: 'The user said no. Nothing ran. Do not try again or reach the same result another way unless they ask.',
  expired: 'The user did not answer, so nothing ran. Tell them what is waiting. They can ask for it again.',
};

function createGateState({ answerWindowMs = ANSWER_WINDOW_MS } = {}) {
  const scopes = new Map();
  const sessions = new Map();
  const requests = new Map();
  const open = new Map();

  function dropRequests(state) {
    for (const request of state.blocked.values()) requests.delete(request.id);
    state.blocked.clear();
  }

  function settle(approval, status) {
    if (!open.delete(approval.id)) return;
    clearTimeout(approval.timer);
    approval.finish(status);
  }

  async function showApproval(state, summary, whatHappens = '') {
    const id = crypto.randomUUID();
    const epoch = state.epoch;
    let record;
    try { record = await state.present({ id, summary, whatHappens, requester: state.requester }); }
    catch (_) { return 'declined'; }
    if (state.epoch !== epoch || scopes.get(state.scope) !== state) {
      await record('declined');
      return 'declined';
    }
    const status = await new Promise(finish => {
      const approval = { id, requester: state.requester, conversationId: state.conversationId, scope: state.scope, epoch, finish };
      approval.timer = setTimeout(() => settle(approval, 'expired'), answerWindowMs);
      open.set(id, approval);
    });
    await record(status);
    return status;
  }

  return {
    // Called once per user turn, before the turn is submitted.
    bindTurn(session, { scope, conversationId, enabled, requester, present }) {
      const state = scopes.get(scope) || { blocked: new Map(), unlocked: new Set() };
      for (const approval of [...open.values()]) if (approval.scope === scope) settle(approval, 'declined');
      dropRequests(state);
      state.unlocked.clear();
      Object.assign(state, { scope, epoch: (state.epoch || 0) + 1, conversationId, enabled: enabled !== false, requester, present });
      scopes.set(scope, state);
      for (const [id, assigned] of sessions) if (assigned === scope) sessions.delete(id);
      for (const id of [session.sessionId, session.storedSessionId]) {
        if (typeof id !== 'string' || !id) continue;
        sessions.delete(id);
        sessions.set(id, scope);
      }
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    },
    // Browser work has already resolved the real native target. Keep the tool
    // call suspended and consume this answer for this operation only.
    async authorizeBrowser({ sessionId, summary }) {
      const state = scopes.get(sessions.get(String(sessionId || '')));
      if (!state) return false;
      if (!state.enabled) return true;
      const epoch = state.epoch;
      const status = await showApproval(state, String(summary || 'this browser action'));
      return status === 'approved' && scopes.get(state.scope) === state && state.epoch === epoch;
    },
    decide({ sessionId, summary, fingerprint }) {
      const id = String(sessionId || '');
      if (id.startsWith('cron_')) return { allow: true };
      const what = String(summary || 'this action').slice(0, 1200);
      const state = scopes.get(sessions.get(id));
      // Delegated work and unknown sessions have no user to answer them.
      if (!state) return { allow: false, message: noUserMessage(what) };
      if (!state.enabled) return { allow: true };
      const key = String(fingerprint || '');
      if (key && state.unlocked.delete(key)) return { allow: true };
      let request = state.blocked.get(key);
      if (!request) {
        request = { id: crypto.randomUUID(), key, summary: what, state };
        state.blocked.set(key, request);
        requests.set(request.id, request);
      }
      return { allow: false, message: blockedMessage(what, request.id) };
    },
    // Waits for the user's answer. The tool call stays open until then.
    async requestApproval({ requestId, whatHappens }) {
      const request = requests.get(String(requestId || ''));
      if (!request) return { approved: false, message: 'That request is no longer open. Try the action again to get a new one.' };
      if (request.answer) return request.answer;
      request.answer = (async () => {
        const { state } = request;
        const epoch = state.epoch;
        const status = await showApproval(state, request.summary, whatHappens);
        requests.delete(request.id);
        if (state.blocked.get(request.key) === request) state.blocked.delete(request.key);
        const approved = status === 'approved' && state.epoch === epoch;
        if (approved) state.unlocked.add(request.key);
        return { approved, message: ANSWERS[approved ? 'approved' : status === 'approved' ? 'declined' : status] };
      })().catch(() => {
        requests.delete(request.id);
        if (request.state.blocked.get(request.key) === request) request.state.blocked.delete(request.key);
        return { approved: false, message: 'The request could not be shown, so nothing ran. Tell the user what is waiting.' };
      });
      return request.answer;
    },
    // The signed-in user's answer. This is the only way to approve.
    answer({ id, requester, approved }) {
      const approval = open.get(String(id || ''));
      if (!approval) return 'gone';
      if (String(approval.requester || '').toLowerCase() !== String(requester || '').toLowerCase()) return 'forbidden';
      settle(approval, approved === true ? 'approved' : 'declined');
      return 'answered';
    },
    // A stopped turn takes its open requests with it.
    cancelConversation(conversationId) {
      for (const approval of [...open.values()]) {
        if (approval.conversationId === conversationId) settle(approval, 'declined');
      }
    },
  };
}

async function createAskBeforeDoGate(options) {
  const state = createGateState(options);
  const token = crypto.randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const routes = { '/decide': state.decide, '/request': state.requestApproval };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const authorized = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    const route = routes[req.url];
    if (req.method !== 'POST' || !route || !authorized || req.headers.origin) {
      res.writeHead(403);
      return res.end('{}');
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('too large');
        chunks.push(chunk);
      }
      res.end(JSON.stringify(await route(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
    } catch (_) {
      if (!res.writableEnded) { res.writeHead(400); res.end('{}'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    bindTurn: state.bindTurn,
    authorizeBrowser: state.authorizeBrowser,
    answer: state.answer,
    cancelConversation: state.cancelConversation,
    async stop() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { approvalCard, createAskBeforeDoGate, createGateState };
