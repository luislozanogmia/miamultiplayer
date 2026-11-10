import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('better-sqlite3');
const {createHubBotClient,withoutRunLabel,stoppedReply,hubStopReason}=require('./hub-bot-client');
const owner='local-user@localhost',teamId='a'.repeat(32),channelId='c'.repeat(32),jobId='d'.repeat(32);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// A Hub that takes only the newest sign-in token, as Clerk's ~60-second tokens
// behave once a run outlives one. Claim checks run every 5 ms here; 40 of them
// stand for ten minutes at the real 15-second interval.
function fixture(t,{runMs=0,claimStatus=()=>200,runBot,runTimeoutMs=10*60*1000,identity=()=>'user_owner',meSubject=()=>'user_owner'}={}) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const dataDirectory=mkdtempSync(join(tmpdir(),'mia-hub-run-tokens-'));
  writeFileSync(join(dataDirectory,'hub-connection.json'),JSON.stringify({url:'https://hub.example.test'}));
  let registration,current='token.0',reply,claims=0,started=false;
  const rejected=[],logged=[];
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
  const client=createHubBotClient({db,dataDirectory,isOwnerActive:()=>true,checkIntervalMs:5,retryDelayMs:1,tokenWaitMs:200,tokenPollMs:2,runTimeoutMs,
    log:(event,code)=>logged.push({event,code}),
    getAccountIdentity:()=>({subject:identity(),email:'owner@example.test',issuer:'https://clerk.miamultiplayer.com'}),
    getBot:id=>id==='local'?{id:'local',name:'Helper',instructions:'Shared purpose'}:null,listBots:()=>[],
    runBot:runBot||(async({signal})=>{
      started=true;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,runMs);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});
      });
      return 'Found it in mdLite';
    }),
    fetcher:async(url,options)=>{
      const body=options.body && JSON.parse(options.body);
      const token=options.headers.authorization.slice(7);
      if(url.endsWith('/v1/me')) return response({teams:[{teamId,membership:{clerk_user_id:meSubject(),email:'owner@example.test',display_name:'Ana'}}]});
      if(token!==current) {rejected.push(url.split('/').at(-1));return response({error:'unauthorized'},401);}
      if(url.endsWith('/v1/teams/'+teamId+'/channels')) return response({channels:[]});
      if(url.endsWith('/bots')) {
        if(options.method==='POST') {registration={...body,owner_id:'user_owner'};return response({bot:registration});}
        return response({bots:registration?[registration]:[]});
      }
      if(url.endsWith('/versions')) return response({proposal:{version:1}});
      if(url.endsWith('/bot-dispatches')) return response({dispatches:reply!==undefined?[]:[{id:jobId,bot_id:registration.id,executor_id:'user_owner',requester_id:'user_owner',definition_version:1}]});
      if(url.endsWith('/claim')) {
        claims++;
        const status=started?claimStatus(claims):200;
        if(status!==200) return response({error:'dispatch_claimed'},status);
        return response({id:jobId,botId:registration.id,triggerSequence:1,requesterId:'user_owner',executorId:'user_owner',botName:'Helper',definition:{version:1,instructions:'Shared purpose'},deadline:9999999999});
      }
      if(url.includes('/messages/after/')) return response({messages:[{sequence:1,author_type:'user',author_id:'user_owner',author_email:'owner@example.test',body:'@Helper why are the dashes gone?'}],next:1});
      if(url.endsWith('/result')) {
        const status=claimStatus(claims);
        if([403,404,409].includes(status)) return response({error:'dispatch_claimed'},status);
        reply=body.text;return response({id:'e'.repeat(32),sequence:2});}
      throw new Error('Unexpected route');
    }});
  const input={teamId,channelId,localBotId:'local'};
  return {client,input,logged,rejected,reply:()=>reply,
    // The app's refresh: a new token, sent the way the app sends it.
    // The Hub stops taking the old token a little before the app sends the new one.
    rotate:async()=>{current='token.'+(Number(current.split('.')[1])+1);await wait(8);return client.refresh(owner,current);},
    start:async()=>{await client.share(owner,input,current);return client.poll(owner,input,current);}};
}

test('a team bot run that outlives many sign-in tokens keeps going and publishes its reply',async t=>{
  const f=fixture(t,{runMs:220});
  assert.equal((await f.start()).running,1);
  // Mia sends a fresh token every ~20 seconds while a run is going, whatever
  // room is open; the Hub stops taking each old one.
  let rotations=0;
  while(f.reply()===undefined && rotations<100) {await wait(4);await f.rotate();rotations++;}
  await f.client.idle();
  assert.ok(rotations>=10,'the run outlived many tokens');
  assert.ok(f.rejected.includes('claim'),'some claim checks hit an expired token');
  assert.equal(withoutRunLabel(f.reply()),'Found it in mdLite');
  assert.ok(!f.logged.some(entry=>entry.event==='run stopped'),'nothing cancelled the run');
  assert.ok(f.logged.some(entry=>entry.event==='claim check missed' && entry.code==='sign_in_expired'),'a missed check says why');
  assert.deepEqual(await f.client.refresh(owner,'token.later'),{running:0},'with no run left, the app is told to stop sending');
});

test('a 401 on a claim check never cancels the run; a 409 does',async t=>{
  const unauthorized=fixture(t,{runMs:80,claimStatus:()=>401});
  await unauthorized.start();await unauthorized.client.idle();
  assert.equal(withoutRunLabel(unauthorized.reply()),'Found it in mdLite');

  const taken=fixture(t,{runMs:5000,claimStatus:()=>409});
  await taken.start();await taken.client.idle();
  assert.deepEqual(taken.logged.filter(entry=>entry.event==='run stopped'),[{event:'run stopped',code:'claim_gone'}]);
  assert.equal(taken.reply(),undefined,'a taken claim publishes nothing');
  assert.ok(taken.logged.some(entry=>entry.event==='reply discarded' && entry.code==='claim_gone'));
});

test('every way a run stops logs a reason code and tells the person in a few words',async t=>{
  const timedOut=fixture(t,{runMs:5000,runTimeoutMs:40});
  await timedOut.start();await timedOut.client.idle();
  assert.ok(timedOut.logged.some(entry=>entry.event==='run stopped' && entry.code==='time_limit'));
  assert.equal(timedOut.reply(),'This bot could not complete the request (time limit). Please send a new message to try again.');

  let subject='user_owner';
  const switched=fixture(t,{runMs:5000,identity:()=>subject});
  await switched.start();await wait(20);subject='user_other';await switched.client.idle();
  assert.ok(switched.logged.some(entry=>entry.event==='run stopped' && entry.code==='owner_changed'));

  const broken=fixture(t,{runBot:async()=>{throw Object.assign(new Error('provider said no'),{status:401});}});
  await broken.start();await broken.client.idle();
  assert.ok(broken.logged.some(entry=>entry.event==='run stopped' && entry.code==='bot_failed'),'a model 401 is the bot failing, not the sign-in');
  assert.equal(broken.reply(),stoppedReply('bot_failed'));

  for(const [status,code] of [[401,'sign_in_expired'],[404,'claim_gone'],[409,'claim_gone'],[403,'claim_gone'],[503,'hub_unreachable'],[undefined,'hub_unreachable'],[400,'hub_refused']])
    assert.equal(hubStopReason(status===undefined?new TypeError('fetch failed'):{status}),code);
  for(const code of ['time_limit','sign_in_expired','claim_gone','owner_changed','hub_unreachable','bot_failed'])
    assert.doesNotMatch(stoppedReply(code),/token|Bearer|@/i);
});

test('the refresh route takes a token only when the Hub says it is this account’s',async t=>{
  let me='user_owner';
  const f=fixture(t,{runMs:100,meSubject:()=>me});
  await f.start();
  me='user_other';
  await assert.rejects(f.client.refresh(owner,'token.other'),{code:'account_mismatch'});
  await f.client.idle();
  assert.equal(withoutRunLabel(f.reply()),'Found it in mdLite','the run kept the token it had');
});
