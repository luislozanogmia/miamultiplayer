import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('better-sqlite3');
const {createHubBotClient,materializeSharedSkills}=require('./hub-bot-client');
const owner='owner@example.test',teamId='a'.repeat(32),channelId='c'.repeat(32);
function fixture(t,localOwner=owner,bundleSkills=()=>[]) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const dataDirectory=mkdtempSync(join(tmpdir(),'mia-hub-bindings-'));
  writeFileSync(join(dataDirectory,'hub-connection.json'),JSON.stringify({url:'https://hub.example.test'}));
  const requests=[];
  let memberEmail=owner, active=true, fail=false;
  let identity={email:owner,subject:'user_owner',issuer:'https://clerk.miamultiplayer.com'};
  const bot={id:'local-private-id',name:'Helper',instructions:'Private instructions stay local',owner};
  let versionAnswer=null, shareAnswer=null, definition=null, placed=false;
  const client=createHubBotClient({db,dataDirectory,isOwnerActive:()=>active,bundleSkills,
    getAccountIdentity:()=>identity,
    getBot:(id,email)=>id===bot.id && email===localOwner?bot:null,listBots:email=>email===localOwner?[bot]:[],
    fetcher:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/v1/me')) return new Response(JSON.stringify({teams:[{teamId,membership:{clerk_user_id:'user_owner',email:memberEmail}}]}));
      if(fail) throw new Error('connection interrupted');
      const id=url.split('/').at(-1);
      if(options.method==='PUT') return placed?new Response(JSON.stringify({bot:{id,is_owner:true}})):new Response(JSON.stringify({error:'not_found'}),{status:404});
      if(options.method==='GET') return definition?new Response(JSON.stringify({bot:{id,is_owner:definition.owner!==false},definition})):new Response(JSON.stringify({error:'not_found'}),{status:404});
      const body=JSON.parse(options.body);
      if(url.endsWith('/versions')) return versionAnswer?versionAnswer():new Response(JSON.stringify({bot:{id:url.split('/').at(-2)},version:2}));
      return shareAnswer?shareAnswer():new Response(JSON.stringify({bot:{id:body.id,name:body.name,shared_by:'user_owner',is_owner:true}}));
    }});
  return {client,requests,bot,setDefinition:value=>definition=value,setVersionAnswer:value=>versionAnswer=value,setShareAnswer:value=>shareAnswer=value,setPlaced:value=>placed=value,
    input:{teamId,channelId,localBotId:bot.id},setIdentity:value=>identity=value,setEmail:value=>memberEmail=value,setActive:value=>active=value,setFail:value=>fail=value};
}
const posts=f=>f.requests.filter(r=>r.options.method==='POST').map(r=>({url:r.url,body:JSON.parse(r.options.body)}));

test('sharing puts the bot in the company marketplace in one step, with no approval, and a retry keeps the same bot',async t=>{
  const f=fixture(t);
  f.setFail(true);
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),/connection interrupted/);
  f.setFail(false);
  const result=await f.client.share(owner,f.input,'fixture.token');
  const sent=posts(f);
  assert.equal(sent.length,2);
  assert.equal(sent[0].body.id,sent[1].body.id,'the retry is the same bot, not a second one');
  assert.match(sent[0].url,new RegExp('/v1/teams/'+teamId+'/market/bots$'));
  assert.deepEqual(sent[0].body,{id:result.bot.id,name:'Helper',avatar_color:'',instructions:'Private instructions stay local',skills:[],tags:[],channel_id:channelId,access:{kind:'channel'}});
  assert.equal(JSON.stringify(sent[0].body).includes('local-private-id'),false);
  assert.equal(f.requests.some(r=>/\/channels\/[a-f0-9]+\/bots/.test(r.url)),false,'the old route that waited for an admin is not used');
  assert.deepEqual(f.client.available(owner),{bots:[{id:'local-private-id',name:'Helper',sharedAs:[{teamId,registrationId:result.bot.id}]}]},
    'each bot lists its company copies, so a company can grey out the Solo bot it already shares');
});

test('a bot the company already has is only placed in another channel, and chosen teams are passed on',async t=>{
  const f=fixture(t),other='d'.repeat(32),team='e'.repeat(32);
  const first=await f.client.share(owner,{...f.input,access:{kind:'teams',team_ids:[team,'not-a-team']}},'fixture.token');
  assert.deepEqual(posts(f)[0].body.access,{kind:'teams',team_ids:[team]});
  f.setPlaced(true);
  const again=await f.client.share(owner,{...f.input,channelId:other},'fixture.token');
  assert.equal(again.bot.id,first.bot.id);
  assert.equal(again.placed,true);
  assert.equal(posts(f).length,1,'no second company bot is made');
  assert.match(f.requests.at(-1).url,new RegExp('/channels/'+other+'/market-bots/'+first.bot.id+'$'));
  // A bot downloaded from this company goes back as the company's own bot.
  const g=fixture(t);g.setPlaced(true);
  g.bot.marketSource={teamId,botId:'f'.repeat(32),version:3};
  assert.equal((await g.client.share(owner,g.input,'fixture.token')).bot.id,'f'.repeat(32));
  assert.equal(posts(g).length,0);
});

test('a name the company already uses is reported as that',async t=>{
  const f=fixture(t);
  f.setShareAnswer(()=>new Response(JSON.stringify({error:'bot_name_taken'}),{status:409}));
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),{status:409,code:'bot_name_taken'});
});

test('an edit made inside the company is live for everyone at once, and only when something changed',async t=>{
  const skill={name:'Review',description:'',body:'Use the scorer.'};
  const f=fixture(t,owner,()=>[skill]);
  const versions=()=>posts(f).filter(r=>r.url.endsWith('/versions'));
  assert.deepEqual(await f.client.update(owner,{teamId,localBotId:f.bot.id},'fixture.token'),{updated:[]},'a bot never shared here has no copy to update');
  assert.equal(f.requests.length,0);
  const shared=await f.client.share(owner,f.input,'fixture.token');
  f.setDefinition({version:1,name:'Helper',avatar_color:'#123456',instructions:f.bot.instructions,skills:[skill],tags:['ops']});
  assert.deepEqual(await f.client.update(owner,{teamId,localBotId:f.bot.id},'fixture.token'),{updated:[]});
  assert.equal(versions().length,0,'the same name, instructions and skills are not sent again');
  f.bot.instructions='Answer in one line';
  assert.deepEqual(await f.client.update(owner,{teamId,localBotId:f.bot.id},'fixture.token'),{updated:[{botId:shared.bot.id,version:2}]});
  assert.deepEqual(versions()[0].body,{name:'Helper',avatar_color:'#123456',instructions:'Answer in one line',skills:[skill],tags:['ops']});
  assert.match(versions()[0].url,new RegExp('/v1/teams/'+teamId+'/market/bots/'+shared.bot.id+'/versions$'));
  f.setDefinition({version:2,name:'Helper',instructions:'Something else',skills:[skill],owner:false});
  assert.deepEqual(await f.client.update(owner,{teamId,localBotId:f.bot.id},'fixture.token'),{updated:[]},'only an owner of the company bot changes it');
  assert.deepEqual(await f.client.update(owner,{teamId:'b'.repeat(32),localBotId:f.bot.id},'fixture.token'),{updated:[]},'another company keeps its own copy');
});

test('a copy from another company shares the skills its owner reviewed, not the library ones',async t=>{
  const f=fixture(t);
  await f.client.share(owner,{...f.input,skills:[{name:'Weekly report',description:'',body:'Write the [Company] report.',files:[{path:'score.py',body:'print(1)'}],folder:'/private/local/skill'},{name:'Empty',body:' '}]},'fixture.token');
  const version=posts(f).map(r=>r.body);
  assert.deepEqual(version[0].skills,[{name:'Weekly report',description:'',body:'Write the [Company] report.',files:[{path:'score.py',body:'print(1)'}]}]);
  assert.equal(JSON.stringify(version[0]).includes('/private/local/skill'),false);
});

test('sharing a local bot includes the skill files without its private folder path',async t=>{
  const f=fixture(t,owner,()=>[{name:'Review',description:'',body:'Use the scorer.',files:[{path:'score.py',body:'print(1)'}],folder:'/private/local/skill'}]);
  await f.client.share(owner,f.input,'fixture.token');
  const version=posts(f)[0].body;
  assert.deepEqual(version.skills,[{name:'Review',description:'',body:'Use the scorer.',files:[{path:'score.py',body:'print(1)'}]}]);
  assert.equal(JSON.stringify(version).includes('/private/local/skill'),false);
});

test('a shared bot receives executable skill files only inside a temporary folder',()=>{
  const prepared=materializeSharedSkills([{name:'Review',body:'Run score.py.',files:[{path:'score.py',body:'print(1)'}]}]);
  const folder=prepared.skills[0].folder;
  assert.equal(readFileSync(join(folder,'SKILL.md'),'utf8'),'Run score.py.');
  assert.equal(readFileSync(join(folder,'score.py'),'utf8'),'print(1)');
  prepared.cleanup();
  assert.equal(existsSync(folder),false);
  // A skill with no extra files still gets a folder, so its prompt can say where it is.
  const plain=materializeSharedSkills([{name:'Plain',body:'Just steps.'}]);
  assert.equal(readFileSync(join(plain.skills[0].folder,'SKILL.md'),'utf8'),'Just steps.');
  plain.cleanup();
  for(const badPath of ['../escape.py','nested/../escape.py','/absolute.py','CON.py'])
    assert.throws(()=>materializeSharedSkills([{name:'Bad',body:'Bad',files:[{path:badPath,body:'x'}]}]),/invalid_shared_skill_file/);
  assert.throws(()=>materializeSharedSkills([{name:'Bad',body:'Bad',files:[{path:'a.py',body:'x'},{path:'A.py',body:'y'}]}]),/invalid_shared_skill_file/);
});

test('different Hub identity, disabled account, unknown local bot and invalid scope fail closed',async t=>{
  const f=fixture(t);
  f.setEmail('other@example.test');
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),{code:'account_mismatch'});
  assert.equal(f.requests.filter(r=>r.options.method==='POST').length,0);
  f.setEmail(owner);
  await assert.rejects(f.client.share(owner,{...f.input,localBotId:'other-bot'},'fixture.token'),{code:'bot_not_found'});
  await assert.rejects(f.client.share(owner,{...f.input,channelId:'../channel'},'fixture.token'),{code:'invalid_channel'});
  f.setActive(false);
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),{code:'account_unavailable'});
});


test('Clerk local-profile alias uses linked external identity while preserving local bot ownership',async t=>{
  const localOwner='local-user@localhost',f=fixture(t,localOwner);
  const result=await f.client.share(localOwner,f.input,'fixture.token');
  assert.equal(result.bot.shared_by,'user_owner');
  const binding=f.client.journal.bindings({origin:'https://hub.example.test',owner:localOwner,subject:'user_owner',teamId,channelId})[0];
  assert.equal(binding.local_bot_id,'local-private-id');
  assert.equal(binding.owner,localOwner);
  for(const identity of [null,{email:owner,subject:'replacement_user',issuer:'https://clerk.miamultiplayer.com'},{email:owner,subject:'user_owner',issuer:'https://test.example.test'}]) {
    f.setIdentity(identity);
    await assert.rejects(f.client.share(localOwner,f.input,'fixture.token'));
  }
});

test('a full team storage allowance is reported as itself, not as an oversized bot',async t=>{
  const f=fixture(t);
  f.setShareAnswer(()=>new Response(JSON.stringify({error:'bot_storage_limit'}),{status:413}));
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),{status:413,code:'bot_storage_limit'});
  f.setShareAnswer(()=>new Response(JSON.stringify({error:'body_too_large'}),{status:413}));
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),{status:413,code:'bot_too_large_for_team'});
});

test('a shared bot turn receives the file on the message it answers',async()=>{
  const source=require('node:fs').readFileSync(new URL('./hub-bot-client.js',import.meta.url),'utf8');
  assert.match(source,/const attached=await triggerFile\(s,trigger,token\)/);
  assert.match(source,/modelSelection:selections\.get\(runKey\(s,run\.job_id\)\)\|\|null,asker:asker\(s,run\.registration_id,claim\.requesterId===s\.subject,openPages\.get\(runKey\(s,run\.job_id\)\)\),\.\.\.attached\}/);
  assert.match(source,/unreadableFiles:\[item\.filename\|\|'image'\]/);
});

test('a company run gets Solo\'s turn time, ends before the Hub claim does, and reads 100 messages', () => {
  const { sharedRunTimeoutMs, SHARED_RUN_HISTORY } = require('./hub-bot-client.js');
  const now = 1_800_000_000_000, solo = 10 * 60 * 1000;
  assert.equal(sharedRunTimeoutMs(solo, undefined, now), solo, 'no deadline: Solo\'s time');
  assert.equal(sharedRunTimeoutMs(solo, now / 1000 + 900, now), solo, 'a 15-minute claim leaves Solo\'s 10 minutes');
  assert.equal(sharedRunTimeoutMs(solo, now / 1000 + 300, now), 300000 - 30000, 'a short claim: stop 30 seconds before it ends');
  assert.equal(sharedRunTimeoutMs(solo, now / 1000 - 5, now), 1000, 'an ended claim stops at once');
  assert.equal(SHARED_RUN_HISTORY, 100);
});

// A marketplace bot asked in a channel: the asker's own Mia answers with the
// company's latest version, and nobody approves anything.
function asking(t,{runBot,messages}={}) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const dataDirectory=mkdtempSync(join(tmpdir(),'mia-hub-ask-'));
  writeFileSync(join(dataDirectory,'hub-connection.json'),JSON.stringify({url:'https://hub.example.test'}));
  const botId='b'.repeat(32),replyId='d'.repeat(32),calls=[],runs=[];
  const rows=messages||[{sequence:1,author_type:'user',author_id:'user_other',body:'Earlier'},{sequence:2,author_type:'user',author_id:'user_owner',body:'@Helper sum it up'}];
  const client=createHubBotClient({db,dataDirectory,isOwnerActive:()=>true,
    getAccountIdentity:()=>({email:owner,subject:'user_owner',issuer:'https://clerk.miamultiplayer.com'}),
    getBot:()=>null,listBots:()=>[],
    runBot:runBot||(async args=>{runs.push(args);return {text:'Here is the summary.',provider:'codex'};}),
    fetcher:async(url,options)=>{
      const body=options.body?JSON.parse(options.body):null;calls.push({method:options.method,url,body});
      if(url.endsWith('/v1/me')) return new Response(JSON.stringify({teams:[{teamId,name:'Company',membership:{clerk_user_id:'user_owner',email:owner,display_name:'Owner'}}]}));
      if(url.endsWith('/market/bots/'+botId)) return new Response(JSON.stringify({bot:{id:botId,name:'Helper'},definition:{version:4,name:'Helper',instructions:'Latest company instructions',skills:[]}}));
      if(url.includes('/messages/after/')) {const after=Number(url.split('/').at(-1));return new Response(JSON.stringify({messages:rows.filter(row=>row.sequence>after)}));}
      return new Response(JSON.stringify({id:replyId,sequence:3}));
    }});
  return {client,calls,runs,db,input:{teamId,channelId,botId,replyId,triggerSequence:2},replies:()=>calls.filter(c=>c.url.includes('/market-bots/'+botId+'/replies'))};
}

test('a bot asked in a channel answers from the asker\'s Mia with the company\'s latest version',async t=>{
  const f=asking(t);
  assert.deepEqual(await f.client.ask(owner,f.input,'fixture.token'),{replyId:f.input.replyId});
  await f.client.idle();
  const [working,done]=f.replies();
  assert.deepEqual([working.method,working.body.status,working.body.trigger_sequence,working.body.id],['POST','working',2,f.input.replyId]);
  assert.equal(done.method,'PATCH');
  assert.match(done.url,new RegExp('/replies/'+f.input.replyId+'$'));
  assert.equal(done.body.status,'done');
  assert.match(done.body.body,/^Here is the summary\./);
  assert.equal(f.runs.length,1);
  assert.equal(f.runs[0].bot.instructions,'Latest company instructions');
  assert.equal(f.runs[0].bot.registrationId,f.input.botId);
  assert.deepEqual(f.runs[0].history.map(row=>row.sequence),[1]);
  assert.equal(f.calls.some(c=>/bot-dispatches|\/claim/.test(c.url)),false,'no Hub hand-off and no approval is involved');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hub_bot_runs WHERE state<>'discarded'").get().n,0,'nothing is left to pick up later');
});

test('a bot never answers a message somebody else wrote, and a failed run says so in the channel',async t=>{
  const other=asking(t,{messages:[{sequence:2,author_type:'user',author_id:'user_other',body:'@Helper hi'}]});
  await other.client.ask(owner,other.input,'fixture.token');await other.client.idle();
  assert.equal(other.replies().length,0);
  assert.equal(other.runs.length,0);
  const failed=asking(t,{runBot:async()=>{throw new Error('model down');}});
  await failed.client.ask(owner,failed.input,'fixture.token');await failed.client.idle();
  assert.deepEqual(failed.replies().map(c=>c.body.status),['working','failed']);
  await assert.rejects(failed.client.ask(owner,{...failed.input,botId:'nope'},'fixture.token'),{code:'invalid_bot'});
});

test('Stop ends a channel bot\'s run on this computer and the channel sees it stopped',async t=>{
  let release;
  const f=asking(t,{runBot:({signal})=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason));})});
  await f.client.ask(owner,f.input,'fixture.token');
  while(!release) await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(f.client.stop('someone-else@example.test',{replyId:f.input.replyId}),{stopped:false});
  assert.deepEqual(f.client.stop(owner,{replyId:f.input.replyId}),{stopped:true});
  await f.client.idle();
  assert.deepEqual(f.replies().map(c=>[c.body.status,c.body.body]).at(-1),['failed','Stopped.']);
});
