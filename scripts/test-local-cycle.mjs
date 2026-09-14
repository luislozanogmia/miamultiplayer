#!/usr/bin/env node

import { spawn } from 'node:child_process';

const origin = process.env.MIAOS_BASE_URL || 'http://127.0.0.1:4871';
const cycle = Number(process.argv[2] || 1);
const botBinary = String(process.env.MIAOS_BOT_BIN || '').trim();
if (!botBinary) throw new Error('MIAOS_BOT_BIN is required');

async function readSecret() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  value = value.trim();
  if (!value) throw new Error('DeepSeek key is required on stdin');
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-miaos-workspace': 'solo',
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* surfaced below */ }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${(body && body.error) || 'invalid response'}`);
  return body;
}

async function waitForMiaReply(conversationId, userEventId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const payload = await api(`/api/conversations/${encodeURIComponent(conversationId)}/events?limit=100&includeDeleted=false&latest=true&workspace=solo`);
    const reply = (payload.events || []).find((event) => {
      const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      return event.senderType === 'agent' && event.senderId === 'gateway'
        && event.type === 'agent_message' && metadata.progress !== true
        && Date.parse(event.createdAt || '') >= Date.parse(userEventId.createdAt || '');
    });
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Mia response timed out');
}

function runBotCommand(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(botBinary, ['create', '--confirmed'], {
      env: { ...process.env, MIAOS_BASE_URL: origin, MIAOS_WORKSPACE: 'solo' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`miaos-bot failed: ${stderr.trim() || code}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('miaos-bot returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const secret = await readSecret();
  const initialSettings = await api('/api/settings');
  if (initialSettings.harness && initialSettings.harness.onboardingComplete) {
    throw new Error('cycle did not start from untouched onboarding');
  }
  const initialBots = await api('/api/bots');
  if ((initialBots.bots || []).length !== 0) throw new Error('cycle did not start with zero bots');

  await api('/api/settings/harness/api-key', {
    method: 'POST',
    body: JSON.stringify({ provider: 'deepseek', apiKey: secret }),
  });
  await api('/api/settings/harness', {
    method: 'POST',
    body: JSON.stringify({ provider: 'openai-api', apiProvider: 'deepseek', mode: 'solo' }),
  });

  let conversations = (await api('/api/conversations?workspace=solo')).conversations || [];
  let mia = conversations.find((conversation) =>
    conversation.type === 'agent' && conversation.metadata && conversation.metadata.agentId === 'gateway'
  );
  if (!mia) {
    mia = (await api('/api/conversations?workspace=solo', {
      method: 'POST',
      body: JSON.stringify({ type: 'agent', name: 'Mia', metadata: { agentId: 'gateway', source: 'cycle-test' } }),
    })).conversation;
  }

  const startedAt = Date.now();
  const sent = await api(`/api/conversations/${encodeURIComponent(mia.id)}/events?workspace=solo`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'message',
      content: { text: `Reply exactly: cycle ${cycle} ready` },
      clientIdempotencyKey: `clean-cycle-${cycle}-${Date.now()}`,
    }),
  });
  await waitForMiaReply(mia.id, sent.event);
  const responseMs = Date.now() - startedAt;

  const botName = `Cycle Bot ${cycle}`;
  const created = await runBotCommand({
    name: botName,
    role: 'Confirm clean-install bot creation',
    output: 'A concise verification result',
    departments: ['Testing'],
  });
  if (created.status !== 'created' || !created.bot || created.bot.name !== botName) {
    throw new Error('guarded bot command did not create the expected bot');
  }
  const finalBots = await api('/api/bots');
  if ((finalBots.bots || []).length !== 1 || finalBots.bots[0].name !== botName) {
    throw new Error('created bot was not visible through the Mia API');
  }
  const finalConversations = (await api('/api/conversations?workspace=solo')).conversations || [];
  if (!finalConversations.some((conversation) => conversation.metadata && conversation.metadata.botId === created.bot.id)) {
    throw new Error('created bot has no native conversation');
  }
  process.stdout.write(`${JSON.stringify({ cycle, responseMs, bot: botName, ok: true })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ cycle, ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
