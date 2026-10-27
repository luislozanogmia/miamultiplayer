import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const Database=require('better-sqlite3');
const {createHubBotJournal}=require('./hub-bot-journal');
const scope={origin:'https://hub.example.test',owner:'owner@example.test',subject:'user_owner',teamId:'a'.repeat(32),channelId:'c'.repeat(32)};

test('journal claims one execution, survives reopen and publishes stored replies without rerun',t=>{
  const filename=join(mkdtempSync(join(tmpdir(),'mia-hub-journal-')),'test.sqlite');
  let db=new Database(filename), journal=createHubBotJournal(db);
  t.after(()=>db.close());
  const binding=journal.bind(scope,{id:'local-bot',name:'Helper'});
  assert.deepEqual(journal.bind(scope,{id:'local-bot',name:'Helper'}),binding);
  const job={id:'d'.repeat(32),bot_id:binding.registration_id};
  const prepared=journal.prepare(scope,job);
  assert.deepEqual(journal.prepare(scope,job),prepared);
  assert.equal(journal.start(scope,job.id),true);
  assert.equal(journal.start(scope,job.id),false);
  db.close(); db=new Database(filename); journal=createHubBotJournal(db);
  assert.equal(journal.start(scope,job.id),false,'started work cannot rerun after process restart');
  journal.saveReply(scope,job.id,'Saved reply');
  db.close(); db=new Database(filename); journal=createHubBotJournal(db);
  assert.equal(journal.unfinished(scope)[0].reply,'Saved reply');
  journal.saveReply(scope,job.id,'Saved reply');
  assert.throws(()=>journal.saveReply(scope,job.id,'Changed reply'),/reply_conflict/);
  assert.equal(journal.published(scope,job.id),true);
  assert.equal(journal.start(scope,job.id),false);
  assert.equal(journal.unfinished(scope).length,0);
});

test('journal scope prevents account, origin, team and channel crossover',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  const j=createHubBotJournal(db), binding=j.bind(scope,{id:'local',name:'Helper'});
  const job={id:'d'.repeat(32),bot_id:binding.registration_id};j.prepare(scope,job);
  for(const [key,value] of [['origin','https://other.example.test'],['owner','other@example.test'],['subject','replacement_user'],['teamId','b'.repeat(32)],['channelId','d'.repeat(32)]]) {
    const other={...scope,[key]:value};
    assert.equal(j.bindings(other).length,0);assert.equal(j.unfinished(other).length,0);
    // A participant may execute a shared definition without owning its solo source.
    // Identity authorization occurs before journal preparation in the client.
    assert.equal(j.start(other,job.id),false);
  }
  assert.throws(()=>j.saveReply(scope,job.id,'No execution'),/invalid_run_state/);
  j.discard(scope,job.id);assert.equal(j.start(scope,job.id),false);
});
