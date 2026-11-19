import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function actionRunner(liveBot) {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function nativeBotAutomationAction(');
  const end = source.indexOf('\nasync function applyNativeGoogleWorkspaceAction(', start);
  assert.ok(start >= 0 && end > start);
  const seen = [];
  const context = {
    String, Date, console,
    conn: {},
    db: { loadOne: () => liveBot },
    botAutomationActions: {
      extractAutomationAction: () => ({ text: 'Done.', action: { action: 'pause', automationId: 'a1' } }),
      normalizeAutomationAction: (_action, bot) => {
        seen.push(['normalize', bot]);
        return { proposal: { action: 'pause', automationId: 'a1', name: 'Schedule' } };
      },
    },
    ownerOf: bot => bot.owner,
    sameOwner: (bot, sender) => bot.owner === sender,
    isAdmin: () => false,
    isActiveWorkspaceUser: () => true,
    currentInstructionSettings: () => ({ askBeforeDo: false }),
    setBotAutomationEnabled: async bot => { seen.push(['save', bot]); return { status: 'paused' }; },
    bumpVersion: () => {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = nativeBotAutomationAction;', context);
  return { run: (staleBot) => context.run(staleBot, 'model output', { senderId: 'owner@example.test' }), seen };
}

test('a bot action uses the current record after a long model turn', async () => {
  const stale = { id: 'b1', owner: 'owner@example.test', name: 'Old', automations: [{ id: 'a1' }] };
  const live = { id: 'b1', owner: 'owner@example.test', name: 'Renamed', automations: [{ id: 'a1' }, { id: 'a2' }] };
  const h = actionRunner(live);
  assert.equal((await h.run(stale)).metadata.automationControl.status, 'paused');
  assert.deepEqual(h.seen, [['normalize', live], ['save', live]]);
});

test('an archived bot cannot be restored by a delayed model action', async () => {
  const h = actionRunner(null);
  const result = await h.run({ id: 'b1', owner: 'owner@example.test', automations: [{ id: 'a1' }] });
  assert.equal(result.metadata.automationActionError, 'bot_unavailable');
  assert.deepEqual(h.seen, []);
});
