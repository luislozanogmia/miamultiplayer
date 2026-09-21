import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { preferredName, openingMessage, nameAnswer, newsBriefing, NEWS_INTRO } = require('./onboarding-chat');
const db = require('./db');

test('greeting confirms a real name and never derives one from an email', () => {
  assert.equal(openingMessage('Luis'), 'Hi Luis! Is Luis what you’d like me to call you?');
  for (const value of ['', 'Local user', 'rockefellerboster911@gmail.com']) {
    assert.equal(openingMessage(value), 'Hi, I’m Mia! What should I call you?');
    assert.equal(preferredName(value), '');
  }
});

test('name answers support confirmation, correction and skipping without treating tasks as names', () => {
  assert.deepEqual(nameAnswer('Yes', 'Luis'), { name: 'Luis' });
  assert.deepEqual(nameAnswer('Yes', ''), { askName: true });
  assert.deepEqual(nameAnswer('Use another name', 'Luis'), { askName: true });
  assert.deepEqual(nameAnswer('Call me María José', 'Luis'), { name: 'María José' });
  assert.deepEqual(nameAnswer("I'd like Luis", 'Luis Lozano'), { name: 'Luis' });
  assert.deepEqual(nameAnswer("I’d like a proposal", 'Luis Lozano'), { passthrough: true });
  assert.deepEqual(nameAnswer('Skip for now', 'Luis'), { skip: true });
  assert.deepEqual(nameAnswer('Help me write a proposal', 'Luis'), { passthrough: true });
  assert.deepEqual(nameAnswer('rockefellerboster911@gmail.com', ''), { passthrough: true });
  assert.deepEqual(nameAnswer('I am working on a proposal', ''), { passthrough: true });
});

test('local HTTP onboarding stores one greeting, persists the preferred name, and resumes after reload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-onboarding-test-'));
  await mkdir(path.join(root, 'hermes'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, PORT: String(port), MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: path.join(root, 'mia.db'), DATA_DIR: root, MIAOS_ENV_FILE: path.join(root, 'missing.env'),
      HERMES_HOME: path.join(root, 'hermes'), MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'),
      MIAOS_NO_AUTH: '1', MIAOS_LOCAL_PROFILE: '1', MIAOS_CLERK_AUTH: '0',
      HERMES_BIN: '/usr/bin/false', MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(root, 'artifacts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  let conn;
  t.after(async () => {
    if (conn) conn.close();
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + '/healthz')).ok; } catch (_) {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'local server starts: ' + logs);
  async function post(body = {}) {
    const response = await fetch(origin + '/api/onboarding/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await post()).status, 409, 'AI setup remains required');
  conn = db.openDb(path.join(root, 'mia.db'));
  const owner = 'local-user@localhost';
  db.updateUserProfile(conn, owner, { displayName: 'rockefellerboster911@gmail.com' });
  // A fixture models completed setup; no model call is claimed by this test.
  db.saveSingleton(conn, 'settings', { harnessByUser: { [owner]: {
    provider: 'openai-api', apiProvider: 'deepseek', mode: 'solo', onboardingComplete: true,
  } } });
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.data.phase, 'name');
  assert.equal(first.data.suggestedName, '');
  assert.equal((await post()).data.conversationId, first.data.conversationId);
  const events = () => conn.prepare('SELECT content FROM events WHERE conversation_id = ? ORDER BY sequence').all(first.data.conversationId).map((row) => JSON.parse(row.content).text);
  assert.deepEqual(events(), ['Hi, I’m Mia! What should I call you?']);
  const answer = await post({ text: 'Call me María José' });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.phase, 'topics');
  assert.equal(db.getUserByEmail(conn, owner).displayName, 'María José');
  assert.deepEqual(events(), [
    'Hi, I’m Mia! What should I call you?', 'Call me María José',
    'Nice to meet you, María José. ' + NEWS_INTRO,
  ]);
  assert.equal((await post()).data.phase, 'topics');
  assert.equal(events().length, 3);
  assert.equal(db.loadAll(conn, 'bots').length, 0, 'greeting does not create an automation');
  const topics = await post({action:'topics', topics:['Technology & AI', 'Architecture']});
  assert.equal(topics.data.phase, 'schedule');
  assert.deepEqual((await post()).data.topics, ['Technology & AI', 'Architecture']);
  assert.equal(db.loadAll(conn, 'bots').length, 0, 'choosing topics does not create an automation');
  assert.equal((await post({action:'skip-news'})).data.phase, 'done');
});

test('news briefing validates user choices and creates one explicit research task', () => {
  const input = {topics:['Science & health'], schedule:'weekdays', time:'09:00', utcOffsetMinutes:360};
  const result = newsBriefing(input);
  assert.equal(result.frequency, 'daily');
  assert.equal(result.weekdaysOnly, true);
  assert.equal(result.utcOffsetMinutes, 360);
  assert.match(result.prompt, /Science & health/);
  assert.match(result.prompt, /source links/);
  assert.match(result.prompt, /do not invent news/);
  for(const invalid of [{topics:[]}, {time:'25:00'}, {schedule:'hourly'}, {utcOffsetMinutes:9999}, {schedule:'weekly',day:'nonsense'}]){
    assert.throws(() => newsBriefing({...input,...invalid}));
  }
});

test('creation handler confirms scheduler success once and cleans up a failed attempt (mocked scheduler)', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/onboarding/news'");
  const route = source.slice(start, source.indexOf('\n});', start) + 4);
  for(const fail of [false, true]){
    let handler, scheduled = 0, removed = 0, published = 0;
    let state = {phase:'schedule',topics:['Technology & AI'],conversationId:'mia-room'};
    const bots = new Map();
    const context = {
      app:{post:(_path,_auth,fn) => {handler = fn;}}, requireAuth(){},
      nativeConversationPrincipal:() => ({principalId:'owner',companyId:'solo-owner'}),
      onboardingNewsInFlight:new Set(), onboardingState:() => state, onboardingKey:() => 'state',
      newsBriefing, chatModelSelectionForUser:async () => ({model:'chosen-model',provider:'chosen-provider'}),
      MAX_BOTS:20, crypto:{randomUUID:() => 'stable-id'},
      db:{loadAll:() => [...bots.values()], setMeta:(_c,_k,value) => {state=JSON.parse(value);}, saveOne:(_c,_table,id,record) => bots.set(id,structuredClone(record))},
      conn:{transaction:fn => fn}, ensureNativeBotConversation:async () => {},
      syncBotAutomationWithInstructions:async record => {scheduled++; if(fail) throw new Error('scheduler unavailable'); record.hermesCronJobIds={'news-briefing':'job-id'};},
      cronSync:{removeBotCron:async () => {removed++;}},
      nativeConversationRepository:{createEvent:() => ({event:{id:'event'}})},
      nativeConversationRealtime:{publish:() => {published++;}}, bumpVersion(){},
    };
    vm.createContext(context);
    vm.runInContext(route, context);
    async function invoke(){
      let status=200, body;
      const response = {status(value){status=value;return this;},json(value){body=value;return this;}};
      await handler({userEmail:'owner',body:{schedule:'daily',time:'09:00',utcOffsetMinutes:360,modelSelection:{model:'chosen-model'}}},response);
      return {status,body};
    }
    const result = await invoke();
    assert.equal(scheduled,1);
    assert.equal(context.onboardingNewsInFlight.size,0);
    if(fail){
      assert.equal(result.status,400);
      assert.equal(state.phase,'schedule');
      assert.equal(removed,1);
      assert.equal(published,0);
      assert.equal([...bots.values()][0].automations[0].enabled,false);
    } else {
      assert.equal(result.status,200);
      assert.equal(state.phase,'news-created');
      assert.equal([...bots.values()][0].model,'chosen-model');
      assert.equal([...bots.values()][0].automations[0].deliveryConversationId,'mia-room');
      assert.equal((await invoke()).status,200);
      assert.equal(scheduled,1,'retry does not create another schedule');
      assert.equal(published,1);
    }
  }
});
