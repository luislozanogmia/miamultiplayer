import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { approvalCard, createAskBeforeDoGate, createGateState } = require('./ask-before-do.js');
const pluginDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'hermes-plugins', 'mia-ask-before-do');

function bound({ enabled = true, answerWindowMs } = {}) {
  const gate = createGateState({ answerWindowMs });
  const shown = [];
  const recorded = [];
  const turn = (requester = 'a@example.com') => gate.bindTurn(
    { sessionId: 'live', storedSessionId: 'stored' },
    {
      scope: 'c1:bot', conversationId: 'c1', enabled, requester,
      present: async (request) => { shown.push(request); return async (status) => { recorded.push(status); }; },
    },
  );
  const call = (fingerprint = 'rm-a', summary = 'rm a.txt') => gate.decide({ sessionId: 'stored', category: 'delete', summary, fingerprint });
  const requestId = (message) => /request_id "([^"]+)"/.exec(message)[1];
  return { gate, turn, call, shown, recorded, requestId };
}

async function asking(context, message, reply) {
  const answer = context.gate.requestApproval({ requestId: context.requestId(message) });
  await new Promise((resolve) => setImmediate(resolve));
  reply(context.shown[context.shown.length - 1]);
  return answer;
}

test('a blocked call runs only after a yes to its request, and only once', async () => {
  const context = bound();
  const { gate, turn, call, shown, recorded } = context;
  turn();
  const blocked = call();
  assert.equal(blocked.allow, false);
  assert.match(blocked.message, /BLOCKED by ask-before-do, nothing ran: rm a\.txt/);
  assert.equal(call().allow, false, 'trying again does not release it');
  const answer = await asking(context, blocked.message, ({ id }) => gate.answer({ id, requester: 'a@example.com', approved: true }));
  assert.equal(shown[0].summary, 'rm a.txt', 'the user reads what the gate saw');
  assert.equal(answer.approved, true);
  assert.deepEqual(recorded, ['approved']);
  assert.equal(call('rm-b', 'rm b.txt').allow, false, 'another call is not unlocked');
  assert.equal(call().allow, true);
  assert.equal(call().allow, false, 'the unlock is used up');
});

test('no, no answer, and a stopped turn run nothing', async () => {
  const no = bound();
  no.turn();
  const declined = await asking(no, no.call().message, ({ id }) => no.gate.answer({ id, requester: 'a@example.com', approved: false }));
  assert.equal(declined.approved, false);
  assert.equal(no.call().allow, false);

  const silent = bound({ answerWindowMs: 5 });
  silent.turn();
  const expired = await silent.gate.requestApproval({ requestId: silent.requestId(silent.call().message) });
  assert.equal(expired.approved, false);
  assert.deepEqual(silent.recorded, ['expired']);
  assert.equal(silent.call().allow, false);

  const stopped = bound();
  stopped.turn();
  const cancelled = await asking(stopped, stopped.call().message, () => stopped.gate.cancelConversation('c1'));
  assert.equal(cancelled.approved, false);
  assert.equal(stopped.call().allow, false);
});

test('a chat message never unlocks anything', () => {
  const { turn, call } = bound();
  turn();
  call();
  turn();
  assert.equal(call().allow, false);
});

test('an unlock and open requests end with the turn', async () => {
  const context = bound();
  const { gate, turn, call } = context;
  turn();
  await asking(context, call().message, ({ id }) => gate.answer({ id, requester: 'a@example.com', approved: true }));
  const earlier = call('rm-b').message;
  turn();
  assert.equal(call().allow, false, 'the unused unlock is gone');
  const late = await gate.requestApproval({ requestId: /request_id "([^"]+)"/.exec(earlier)[1] });
  assert.equal(late.approved, false);
});

test('in a shared conversation only the person who asked can answer', async () => {
  const context = bound();
  const { gate, turn, call } = context;
  turn('a@example.com');
  const answer = await asking(context, call().message, ({ id }) => {
    assert.equal(gate.answer({ id, requester: 'b@example.com', approved: true }), 'forbidden');
    assert.equal(gate.answer({ id, requester: 'A@example.com', approved: false }), 'answered');
    assert.equal(gate.answer({ id, requester: 'a@example.com', approved: true }), 'gone', 'answered only once');
  });
  assert.equal(answer.approved, false);
});

test('a made-up request id and an unknown answer release nothing', async () => {
  const { gate } = bound();
  assert.equal((await gate.requestApproval({ requestId: 'made-up' })).approved, false);
  assert.equal(gate.answer({ id: 'made-up', requester: 'a@example.com', approved: true }), 'gone');
});

test('setting off, scheduled runs and unknown sessions', () => {
  assert.equal(bound({ enabled: false }).gate.decide({ sessionId: 'x', category: 'delete' }).allow, false, 'unknown stays blocked');
  const off = bound({ enabled: false });
  off.turn();
  assert.equal(off.call().allow, true);
  assert.equal(createGateState().decide({ sessionId: 'cron_job_20261101', category: 'send' }).allow, true);
  assert.equal(createGateState().decide({ sessionId: 'subagent-1', category: 'send' }).allow, false);
});

test('each turn reads the setting where promptInstructions puts it', async () => {
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /return \{ agent: \{ text: agent, askBeforeDo \}, bot: \{ text: bot, askBeforeDo \} \};/);
  assert.match(server, /enabled: globalInstructions\.bot\.askBeforeDo,/);
});

test('the plugin stops risky calls, leaves safe ones alone, and fails closed', async (t) => {
  const gate = await createAskBeforeDoGate();
  t.after(() => gate.stop());
  gate.bindTurn({ sessionId: 's1' }, { scope: 'c', conversationId: 'c', enabled: true, requester: 'a', present: async () => async () => {} });
  const script = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1] + "/__init__.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
    def register_tool(self, name, toolset, schema, handler): hooks[name] = handler
m.register(Ctx())
h = hooks["pre_tool_call"]
calls = json.loads(sys.argv[2])
out = [h(tool_name=c[0], args=c[1], session_id="s1") for c in calls]
out.append(json.loads(hooks["request_approval"]({"request_id": "made-up"})))
os.environ["MIA_ASK_BEFORE_DO_URL"] = "http://127.0.0.1:1"
out.append(h(tool_name="terminal", args={"command": "rm a"}, session_id="s1"))
out.append(h(tool_name="read_file", args={"path": "a"}, session_id="s1"))
print(json.dumps(out))
`;
  const gated = [
    ['terminal', { command: 'rm -rf build' }], ['terminal', { command: 'cd x && rm a.txt' }],
    ['terminal', { command: 'mv a ~/.Trash/' }], ['terminal', { command: 'find . -name x -delete' }],
    ['terminal', { command: 'git push origin main' }], ['terminal', { command: "curl -X POST https://example.com -d '{}'" }],
    ['terminal', { command: 'gh pr create --title x' }], ['execute_code', { code: 'import os\nos.remove("a")' }],
    ['send_message', { target: 'x', message: 'hi' }], ['mcp_google_workspace_gmail_send', { to: 'a@example.com' }],
    ['browser_click', { selector: 'button.submit' }], ['brand_new_tool', { any: 1 }],
  ];
  const free = [
    ['terminal', { command: 'ls -la' }], ['terminal', { command: 'curl https://example.com' }], ['terminal', { command: 'echo format' }],
    ['terminal', { command: 'git status' }], ['read_file', { path: 'a' }], ['write_file', { path: 'a', content: 'x' }],
    ['web_search', { query: 'send email' }], ['mcp_google_workspace_gmail_search', { q: 'x' }],
    ['mcp_google_workspace_gmail_create_draft', { to: 'a@example.com' }], ['browser_click', { ref: '@e5' }],
    ['execute_code', { code: 'print(1)' }],
  ];
  // Asynchronous: the gate being called runs in this same process.
  const { stdout } = await promisify(execFile)('python3', ['-c', script, pluginDir, JSON.stringify([...gated, ...free])], {
    env: { ...process.env, MIA_ASK_BEFORE_DO_URL: gate.url, GATEWAY_RELAY_MIA_ASK_BEFORE_DO_TOKEN: gate.token },
  });
  const out = JSON.parse(stdout);
  gated.forEach(([name, args], index) => {
    assert.equal(out[index]?.action, 'block', `${name} ${JSON.stringify(args)}`);
    assert.match(out[index].message, /ask-before-do/);
  });
  free.forEach(([name, args], index) => assert.equal(out[gated.length + index], null, `${name} ${JSON.stringify(args)}`));
  const [madeUp, unreachable, safeWhenUnreachable] = out.slice(gated.length + free.length);
  assert.equal(madeUp.approved, false);
  assert.match(unreachable.message, /could not check/);
  assert.equal(safeWhenUnreachable, null);
});

test('the gate answers only with its token', async (t) => {
  const gate = await createAskBeforeDoGate();
  t.after(() => gate.stop());
  const post = (headers) => fetch(`${gate.url}/decide`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'cron_x', category: 'send' }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 403);
  assert.deepEqual(await (await post({ Authorization: `Bearer ${gate.token}` })).json(), { allow: true });
});

test('the approval shows the action only in verbose output', () => {
  assert.deepEqual(approvalCard('rm a.txt', 'concise'), { text: 'Do you approve?' });
  assert.deepEqual(approvalCard('rm a.txt', undefined), { text: 'Do you approve?' });
  assert.deepEqual(approvalCard('rm a.txt', 'verbose'), { text: 'Do you approve?\n\nrm a.txt', summary: 'rm a.txt' });
});
