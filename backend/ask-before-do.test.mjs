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

  const ended = bound();
  ended.turn();
  const closed = await asking(ended, ended.call().message, () => { ended.gate.cancelScope('other'); ended.gate.cancelScope('c1:bot'); });
  assert.equal(closed.approved, false);
  assert.deepEqual(ended.recorded, ['declined']);
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

test('a pending browser approval cannot authorize a later turn', async () => {
  const context = bound();
  context.turn();
  const pending = context.gate.authorizeBrowser({ sessionId: 'live', summary: 'Click Send on https://example.test' });
  await new Promise(resolve => setImmediate(resolve));
  const old = context.shown.at(-1);
  context.turn();
  assert.equal(context.gate.answer({ id: old.id, requester: 'a@example.com', approved: true }), 'gone');
  assert.equal(await pending, false);
  assert.deepEqual(context.recorded, ['declined']);
  context.gate.bindTurn({ sessionId: 'replacement' }, { scope: 'c1:bot', conversationId: 'c1', enabled: true,
    requester: 'a@example.com', present: async () => async () => {} });
  assert.equal(await context.gate.authorizeBrowser({ sessionId: 'live', summary: 'Click Send' }), false);
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
  assert.equal(createGateState().decide({ sessionId: 'subagent-1', category: 'send' }).allow, false);
});

test('a scheduled run never waits: a blocked action is skipped and reported as needs you', () => {
  const gate = createGateState();
  const started = Date.now();
  const decision = gate.decide({ sessionId: 'cron_job_20261101_090000', summary: 'rm ~/Library/Caches/old.log', fingerprint: 'f'.repeat(64) });
  assert.equal(decision.allow, false, 'nothing that needs a yes runs with nobody watching');
  assert.ok(Date.now() - started < 50, 'it answers at once instead of waiting');
  assert.match(decision.message, /^BLOCKED by ask-before-do, nothing ran: rm ~\/Library\/Caches\/old\.log\./);
  assert.match(decision.message, /report_step with state "needs_you" and exactly what you wanted to do/);
  assert.match(decision.message, /carry on with the steps that do not depend on it/);
  assert.doesNotMatch(decision.message, /request_approval/, 'it never offers an approval nobody can give');
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

test('a browser click waits for a yes when the button it names says so', async (t) => {
  const gate = await createAskBeforeDoGate();
  t.after(() => gate.stop());
  gate.bindTurn({ sessionId: 's1' }, { scope: 'c', conversationId: 'c', enabled: true, requester: 'a', present: async () => async () => {} });
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1] + "/__init__.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
    def register_tool(self, name, toolset, schema, handler): pass
m.register(Ctx())
pre, post = hooks["pre_tool_call"], hooks["post_tool_call"]
def ghost(tool, args): return "ghost-cli call " + tool + " --arguments '" + json.dumps(args) + "'"
names = ["Send", "Post", "Submit", "Buy now", "Confirm", "Publish", "Pay", "Delete", "Place order", "Complete purchase",
         "Enviar", "Publicar", "Comprar ahora", "Confirmar", "Pagar", "Eliminar", "Borrar",
         "Realizar pedido", "Hacer pedido", "Finalizar compra", "Completar compra",
         "Sender", "Posts", "Sort order", "Checkout", "Remove filter", "Home", "Enviado", "Pedidos", "Inicio"]
elements = [{"number": i + 1, "role": "button", "name": n, "selector": "#x"} for i, n in enumerate(names)]
page = json.dumps({"text": "", "elements": elements}, indent=2)
post(tool_name="terminal", args={"command": ghost("ghost_vacuum", {})}, result=json.dumps({"output": page, "exit_code": 0}), session_id="s1")
post(tool_name="browser_snapshot", args={}, session_id="s1", result=json.dumps({"success": True,
     "snapshot": '- button "Send" [ref=e1]\\n- link "Home" [ref=e2]'}))
def vacuum(session, output): post(tool_name="terminal", args={"command": ghost("ghost_vacuum", {}) + " | head -5"}, result=json.dumps({"output": output}), session_id=session)
vacuum("cut", '{\\n  "text": "Page: x\\\\\\\\n\\\\\\\\n[1] button: Inicio\\\\\\\\n[2] button: Enviar",\\n  "elements": [')
vacuum("reread", '{\\n  "text": "Page: x\\\\\\\\n\\\\\\\\n[2] button: Enviar",')
vacuum("reread", '{\\n  "tab_id": 7,')
clicks = [pre(tool_name="terminal", args={"command": ghost("ghost_click", {"choice": i + 1, "snapshot_id": "a"})}, session_id="s1")
          for i in range(len(names))]
print(json.dumps({
  "clicks": [bool(c) for c in clicks],
  "send": bool(pre(tool_name="browser_click", args={"ref": "@e1"}, session_id="s1")),
  "home": bool(pre(tool_name="browser_click", args={"ref": "@e2"}, session_id="s1")),
  "otherChat": bool(pre(tool_name="browser_click", args={"ref": "@e1"}, session_id="s2")),
  "escaped": bool(pre(tool_name="terminal", args={"command": 'ghost-cli call ghost_click --arguments "{\\\\"choice\\\\":1}"'}, session_id="s1")),
  "cutShort": bool(pre(tool_name="terminal", args={"command": ghost("ghost_click", {"choice": 2})}, session_id="cut")),
  "cutShortHome": bool(pre(tool_name="terminal", args={"command": ghost("ghost_click", {"choice": 1})}, session_id="cut")),
  "reread": bool(pre(tool_name="terminal", args={"command": ghost("ghost_click", {"choice": 2})}, session_id="reread")),
  "selector": bool(pre(tool_name="terminal", args={"command": ghost("ghost_click", {"selector": "#send"})}, session_id="s1")),
  "fill": bool(pre(tool_name="terminal", args={"command": ghost("ghost_fill", {"choice": 1, "value": "send it"})}, session_id="s1")),
  "summary": m.classify("browser_click", {"ref": "e1"}, "s1"),
}))
`;
  const { stdout } = await promisify(execFile)('python3', ['-c', script, pluginDir], {
    env: { ...process.env, MIA_ASK_BEFORE_DO_URL: gate.url, GATEWAY_RELAY_MIA_ASK_BEFORE_DO_TOKEN: gate.token },
  });
  const out = JSON.parse(stdout);
  assert.deepEqual(out.clicks, [...Array(21).fill(true), ...Array(9).fill(false)]);
  assert.equal(out.send, true);
  assert.equal(out.home, false);
  assert.equal(out.otherChat, false);
  assert.equal(out.escaped, true);
  assert.equal(out.cutShort, true);
  assert.equal(out.cutShortHome, false);
  assert.equal(out.reread, true);
  assert.equal(out.selector, true);
  assert.equal(out.fill, false);
  assert.deepEqual(out.summary, ['send', 'Click: Send']);
});

test('browser bot calls defer to native target inspection, including selector clicks and tab close', () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1] + "/__init__.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
    def register_tool(self, name, toolset, schema, handler): hooks[name] = handler
m.register(Ctx())
page = json.dumps({"untrusted_page_data": {"elements": [{"number": 1, "role": "button", "name": "Send message"}, {"number": 2, "role": "link", "name": "More details"}]}})
hooks["post_tool_call"](tool_name="mia_browser_work", args={"method": "vacuum", "params": {}}, result=page, session_id="w1")
work = lambda method, **params: m.classify("mia_browser_work", {"method": method, "params": params}, "w1")
print(json.dumps({
  "send": work("click", choice=1, snapshot_id="a"),
  "details": work("click", choice=2, snapshot_id="a"),
  "selector": work("click", selector="#send"),
  "plain": work("click", selector="#more"),
  "otherBot": m.classify("mia_browser_work", {"method": "click", "params": {"choice": 1}}, "w2"),
  "marked": work("fill", selector="#a", value="x", consequential=True),
  "script": work("eval", script="1+1"),
  "saved": work("run_reusable", sourceWorkId="a", reusableId="b"),
  "close": work("tab_close"),
  "navigate": work("navigate", url="https://example.com/"),
  "fill": work("fill", selector="#a", value="send it"),
  "read": work("read"),
}))
`;
  return promisify(execFile)('python3', ['-c', script, pluginDir]).then(({ stdout }) => {
    const out = JSON.parse(stdout);
    assert.equal(out.send, null);
    assert.equal(out.details, null);
    assert.equal(out.selector, null);
    assert.equal(out.plain, null);
    assert.equal(out.otherBot, null);
    assert.equal(out.marked, null);
    assert.equal(out.script, null);
    assert.equal(out.saved, null);
    assert.equal(out.close, null);
    assert.equal(out.navigate, null);
    assert.equal(out.fill, null);
    assert.equal(out.read, null);
  });
});

test('the gate answers only with its token', async (t) => {
  const gate = await createAskBeforeDoGate();
  t.after(() => gate.stop());
  const post = (headers) => fetch(`${gate.url}/decide`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'cron_x', category: 'send' }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await (await post({ Authorization: `Bearer ${gate.token}` })).json()).allow, false);
});

test('the concise approval line comes from the operation, not model wording', () => {
  const line = 'Delete a.txt';
  assert.deepEqual(approvalCard('rm a.txt', 'concise', 'This deletes another file.'), { text: `Do you approve?\n\n${line}`, line });
  assert.deepEqual(approvalCard('rm a.txt', undefined), { text: `Do you approve?\n\n${line}`, line });
  assert.deepEqual(approvalCard('rm a.txt', 'verbose', 'different wording'), {
    text: `Do you approve?\n\n${line}\n\nThis approval covers this action once in this reply.`, line, summary: line,
  });
});

test('verbose approvals keep the action but never persist raw URLs or tokens', () => {
  const secretUrl = 'https://example.test/reset?token=fixture-private-value';
  const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`;
  for (const raw of [`Click Send on ${secretUrl}`, `Run code with ${jwt}`]) {
    const card = approvalCard(raw, 'verbose', 'model wording');
    assert.ok(card.text.includes(card.line));
    assert.ok(card.text.includes('This approval covers this action once'));
    assert.doesNotMatch(JSON.stringify(card), /fixture-private-value|eyJ[a-z]+\.eyJ/);
  }
});

test('the actual browser action line is short and drops URL credentials', () => {
  assert.equal(approvalCard('Click Send on https://example.test/reset?token=secret', 'concise', 'This is harmless').line, 'Click Send on https://example.test');
  assert.equal(approvalCard('Click ' + 'x'.repeat(500), 'concise').line, 'Click [value]');
});

test('the approval line says in plain words what the command will do, never the command', () => {
  const line = (summary) => approvalCard(summary, 'concise').line;
  assert.equal(line('rm -rf build dist node_modules old'), 'Delete build, dist and 2 more');
  assert.equal(line('cd x && rm notes.txt'), 'Delete notes.txt');
  assert.equal(line('ls -la /tmp/notes.txt && rm /tmp/notes.txt'), 'Delete notes.txt', 'the risky part of a combined command');
  assert.equal(line('mv a.txt b.pdf ~/.Trash/'), 'Move a.txt and b.pdf to the Trash');
  assert.equal(line('find . -name x -delete'), 'Delete files found in this folder');
  assert.equal(line('git push origin main'), 'Push your changes to origin/main');
  assert.equal(line('gh pr create --title x'), 'Open a pull request on GitHub');
  assert.equal(line('curl -X POST https://api.example.test/v1?token=abc -d {}'), 'Send data to api.example.test');
  assert.equal(line('mcp_google_workspace_gmail_send {"to":"a@example.test","subject":"Invoice"}'), 'Send an email "Invoice" to a@example.test with Gmail');
  assert.equal(line('mcp__google__google_docs_create {"title":"Weekly plan"}'), 'Create a document "Weekly plan" in Google Docs');
  assert.equal(line('mcp__google__google_drive_delete_file {}'), 'Delete a file in Google Drive');
  assert.equal(line('mcp__linear__create_issue {"title":"Fix login"}'), 'Create an issue "Fix login" in Linear');
  assert.equal(line('mcp__slack__post_message {"text":"hi"}'), 'Post a message in Slack');
  assert.equal(line('mcp__google__google_docs_create {"title":"ghp_abcdefghijklmnopqrstuvwxyz0123456789ab"}'), 'Create a document in Google Docs');
  assert.equal(line('Run code: os.remove("a")'), 'Run code that can change or delete files');
  assert.equal(line('rm ghp_abcdefghijklmnopqrstuvwxyz0123456789ab'), 'Delete files', 'a value that looks secret is never shown');
  for (const summary of ['rm a.txt', 'git push origin main', 'curl -d x https://a.example.test']) assert.doesNotMatch(line(summary), /^Run (rm|git|curl)\b/);
});

test('a yes to editing one document covers more edits to it in the same reply, and nothing else', async () => {
  const context = bound();
  const { gate, turn, shown } = context;
  turn();
  const docA = 'a'.repeat(64), docB = 'b'.repeat(64);
  const edit = (fingerprint, repeatKey) => gate.decide({ sessionId: 'stored', category: 'change', summary: 'mcp__google__google_docs_append {}', fingerprint, repeatKey });
  const first = edit('append-1', docA);
  assert.equal(first.allow, false);
  const answer = await asking(context, first.message, (request) => gate.answer({ id: request.id, requester: 'a@example.com', approved: true }));
  assert.equal(answer.approved, true);
  assert.equal(shown[0].repeatable, true, 'the card says it covers more edits');
  assert.equal(edit('append-1', docA).allow, true, 'the approved call');
  assert.equal(edit('append-2', docA).allow, true, 'more text to the same document');
  assert.equal(edit('append-3', docA).allow, true);
  assert.equal(edit('append-4', docB).allow, false, 'another document asks');
  assert.equal(gate.decide({ sessionId: 'stored', category: 'send', summary: 'send', fingerprint: 'send-1' }).allow, false, 'sending still asks');
  assert.equal(gate.decide({ sessionId: 'stored', category: 'delete',
    summary: 'mcp_google_sheets_batch_update {"miaNestedAction":"deleteSheet"}',
    fingerprint: 'delete-sheet-1', repeatKey: '' }).allow, false,
  'a nested sheet deletion on the same target needs its own approval');
  turn();
  assert.equal(edit('append-5', docA).allow, false, 'a new reply asks again');
});

test('only edits to a named item can be covered; sending, deleting and creating cannot', async () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", sys.argv[1] + "/__init__.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
k = m._repeat_key
print(json.dumps({
  "append": bool(k("mcp__google__google_docs_append", {"documentId": "d1", "text": "a"})),
  "sameDoc": k("mcp__google__google_docs_append", {"documentId": "d1", "text": "a"}) == k("mcp__google__google_docs_append", {"documentId": "d1", "text": "b"}),
  "otherDoc": k("mcp__google__google_docs_append", {"documentId": "d1"}) == k("mcp__google__google_docs_append", {"documentId": "d2"}),
  "sheet": bool(k("mcp__google__google_sheets_update_values", {"spreadsheetId": "s1", "values": []})),
  "noTarget": bool(k("mcp__google__google_docs_append", {"text": "a"})),
  "create": bool(k("mcp__google__google_docs_create", {"documentId": "d1"})),
  "send": bool(k("mcp__google__google_gmail_send", {"fileId": "f"})),
  "delete": bool(k("mcp__google__google_drive_delete_file", {"fileId": "f"})),
  "terminal": bool(k("terminal", {"command": "rm a"})),
  "batchEdit": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": [{"updateCells": {"rows": []}}]})),
  "batchDelete": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": [{"deleteSheet": {"sheetId": 1}}]})),
  "encodedBatchEdit": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": '[{"updateCells": {}}]'})),
  "encodedBatchDelete": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": '[{"deleteSheet": {"sheetId": 1}}]'})),
  "encodedBatchDeleteCategory": m.classify("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": '[{"deleteSheet": {"sheetId": 1}}]'})[0],
  "malformedBatch": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": '[{"deleteSheet":'})),
  "opaqueBatch": bool(k("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": 'deleteSheet'})),
  "batchDeleteCategory": m.classify("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": [{"deleteSheet": {"sheetId": 1}}]})[0],
  "batchDeleteSummary": m.classify("mcp_google_sheets_batch_update", {"spreadsheetId": "s1", "requests": [{"deleteSheet": {"sheetId": 1}}]})[1],
}))
`;
  const { stdout } = await promisify(execFile)('python3', ['-c', script, pluginDir]);
  const result = JSON.parse(stdout);
  assert.deepEqual({ ...result, batchDeleteSummary: undefined }, {
    append: true, sameDoc: true, otherDoc: false, sheet: true, noTarget: false,
    create: false, send: false, delete: false, terminal: false,
    batchEdit: true, batchDelete: false, batchDeleteCategory: 'delete', batchDeleteSummary: undefined,
    encodedBatchEdit: true, encodedBatchDelete: false, encodedBatchDeleteCategory: 'delete', malformedBatch: false, opaqueBatch: false,
  });
  assert.equal(approvalCard(result.batchDeleteSummary, 'verbose', '').line, 'Delete a sheet in Google Sheets');
  assert.equal(approvalCard('mcp__google__google_docs_append {"documentId":"d1"}', 'concise', '', true).line, 'Add to a document in Google Docs, and keep editing it in this reply');
});
