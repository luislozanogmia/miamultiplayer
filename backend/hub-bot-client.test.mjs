import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('better-sqlite3');
const {createHubBotClient}=require('./hub-bot-client');
const owner='owner@example.test',teamId='a'.repeat(32),channelId='c'.repeat(32);
function fixture(t,localOwner=owner) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const dataDirectory=mkdtempSync(join(tmpdir(),'mia-hub-bindings-'));
  writeFileSync(join(dataDirectory,'hub-connection.json'),JSON.stringify({url:'https://hub.example.test'}));
  const requests=[];
  let memberEmail=owner, active=true, fail=false;
  let identity={email:owner,subject:'user_owner',issuer:'https://clerk.miamultiplayer.com'};
  const bot={id:'local-private-id',name:'Helper',instructions:'Private instructions stay local',owner};
  const client=createHubBotClient({db,dataDirectory,isOwnerActive:()=>active,
    getAccountIdentity:()=>identity,
    getBot:(id,email)=>id===bot.id && email===localOwner?bot:null,listBots:email=>email===localOwner?[bot]:[],
    fetcher:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/v1/me')) return new Response(JSON.stringify({teams:[{teamId,membership:{clerk_user_id:'user_owner',email:memberEmail}}]}));
      if(fail) throw new Error('connection interrupted');
      const body=JSON.parse(options.body);
      if(url.endsWith('/versions')) return new Response(JSON.stringify({proposal:{version:1}}));
      return new Response(JSON.stringify({bot:{...body,owner_id:'user_owner'}}));
    }});
  return {client,requests,input:{teamId,channelId,localBotId:bot.id,mode:'linked'},setIdentity:value=>identity=value,setEmail:value=>memberEmail=value,setActive:value=>active=value,setFail:value=>fail=value};
}

test('sharing binds the same local and Hub account, publishes explicitly shared instructions without local identifiers, and retries one registration',async t=>{
  const f=fixture(t);
  f.setFail(true);
  await assert.rejects(f.client.share(owner,f.input,'fixture.token'),/connection interrupted/);
  const first=JSON.parse(f.requests.find(r=>r.options.method==='POST').options.body);
  f.setFail(false);
  const result=await f.client.share(owner,f.input,'fixture.token');
  assert.equal(result.bot.id,first.id);
  assert.deepEqual(Object.keys(first).sort(),['id','name']);
  assert.equal(JSON.stringify(first).includes('Private'),false);
  assert.equal(JSON.stringify(first).includes('local-private-id'),false);
  assert.deepEqual(f.client.available(owner),{bots:[{id:'local-private-id',name:'Helper'}]});
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
  assert.equal(result.bot.owner_id,'user_owner');
  const binding=f.client.journal.bindings({origin:'https://hub.example.test',owner:localOwner,subject:'user_owner',teamId,channelId})[0];
  assert.equal(binding.local_bot_id,'local-private-id');
  assert.equal(binding.owner,localOwner);
  for(const identity of [null,{email:owner,subject:'replacement_user',issuer:'https://clerk.miamultiplayer.com'},{email:owner,subject:'user_owner',issuer:'https://test.example.test'}]) {
    f.setIdentity(identity);
    await assert.rejects(f.client.share(localOwner,f.input,'fixture.token'));
  }
});
