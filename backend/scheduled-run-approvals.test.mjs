import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the production gate callback with workspace-aware conversations.
function scheduledApproval({ teamWorkspace = '', enabled = true, bot = { id: 'bot-1', owner: 'owner@example.test' } } = {}) {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function scheduledRunAskBeforeDo(');
  const end = source.indexOf('// A browser bot asks in its own chat', start);
  assert.ok(start >= 0 && end > start, 'scheduled approval callback is present');
  const automation = { id: 'automation-1', teamWorkspace };
  const calls = [];
  const context = {
    String,
    conn: {},
    cronSync: { activeBotCronRunForSession: () => ({ bot, automation, jobId: 'job-1', sessionId: 'run-1' }) },
    ownerOf: value => value.owner,
    currentInstructionSettings: () => ({ askBeforeDo: enabled }),
    ensureNativeBotConversation: async () => { calls.push('solo'); return { id: 'solo-chat' }; },
    automationChat: async (_bot, chosen) => {
      calls.push(chosen);
      return { id: chosen.teamWorkspace ? 'company-chat' : 'solo-chat' };
    },
    botChatApprovalPresenter: (_bot, conversation) => ({ in: conversation.id }),
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = scheduledRunAskBeforeDo;', context);
  return { run: () => context.run('session-1'), calls, automation };
}

test('a company automation asks in the chat where its run is delivered', async () => {
  const h = scheduledApproval({ teamWorkspace: `hub_${'a'.repeat(32)}` });
  const approval = await h.run();
  assert.equal(approval.conversationId, 'company-chat');
  assert.equal(approval.present.in, 'company-chat');
  assert.deepEqual(h.calls, [h.automation]);
});

test('a Solo automation still asks in its own bot chat', async () => {
  const h = scheduledApproval();
  const approval = await h.run();
  assert.equal(approval.conversationId, 'solo-chat');
  assert.deepEqual(h.calls, [h.automation]);
});

test('with Ask Before Do off, a scheduled run does not create an approval chat', async () => {
  const h = scheduledApproval({ enabled: false });
  const approval = await h.run();
  assert.equal(approval.enabled, false);
  assert.deepEqual(h.calls, []);
});
