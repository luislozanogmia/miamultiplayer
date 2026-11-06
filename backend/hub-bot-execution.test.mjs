import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('better-sqlite3');
const {createHubBotClient,runLabel,withRunLabel,withoutRunLabel,REPLY_BYTES}=require('./hub-bot-client');
const owner='local-user@localhost',teamId='a'.repeat(32),channelId='c'.repeat(32),jobId='d'.repeat(32);
function fixture(t,{replyFailures=0,revokeDuringRun=false,smallPages=false,removeDuringHistory=false,ownRequest=false,replyText='A distinct bot reply',displayName='',priorBotBody='',channelKind='channel',memberIds=['user_owner','user_human']}={}) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const dataDirectory=mkdtempSync(join(tmpdir(),'mia-hub-execution-'));
  writeFileSync(join(dataDirectory,'hub-connection.json'),JSON.stringify({url:'https://hub.example.test'}));
  let registration,claim,reply,revoked=false,runs=0,botAvailable=true;
  const triggerSequence=smallPages?40:2;
  const received=[];
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
  const client=createHubBotClient({db,dataDirectory,isOwnerActive:()=>true,checkIntervalMs:5,
    getAccountIdentity:()=>({subject:'user_owner',email:'owner@example.test',issuer:'https://clerk.miamultiplayer.com'}),
    getBot:(id,email)=>botAvailable && id==='local' && email===owner?{id:'local',name:'Helper',instructions:'Shared purpose'}:null,listBots:()=>[],
    runBot:async args=>{
      runs++;received.push(args);
      if(revokeDuringRun) {revoked=true;return new Promise((resolve,reject)=>args.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}
      return replyText;
    },
    fetcher:async(url,options)=>{
      const body=options.body && JSON.parse(options.body);
      if(url.endsWith('/v1/me')) return response({teams:[{teamId,membership:{clerk_user_id:'user_owner',email:'owner@example.test',display_name:displayName}}]});
      if(url.endsWith('/v1/teams/'+teamId+'/channels')) return response({channels:[{id:channelId,kind:channelKind,visibility:'private',member_ids:memberIds}]});
      if(url.endsWith('/bots')) {
        if(options.method==='POST') {registration={...body,owner_id:'user_owner'};return response({bot:registration});}
        return response({bots:registration?[registration]:[]});
      }
      if(url.endsWith('/versions')) return response({proposal:{version:1}});
      if(url.endsWith('/bot-dispatches')) return response({dispatches:claim?[]:[{id:jobId,bot_id:registration.id,executor_id:'user_owner',requester_id:ownRequest?'user_owner':'user_human',definition_version:1}]});
      if(url.endsWith('/claim')) {
        if(revoked) return response({error:'not_found'},404);
        claim=body.claimId;
        return response({id:jobId,botId:registration.id,triggerSequence,requesterId:ownRequest?'user_owner':'user_human',executorId:'user_owner',botName:'Helper',definition:{version:1,instructions:'Approved shared purpose'},deadline:9999999999});
      }
      if(url.includes('/messages/after/')) {
        if(removeDuringHistory) botAvailable=false;
        const after=Number(url.split('/').at(-1));
        if(smallPages) {
          const seq=after+1;
          return response({messages:[{sequence:seq,author_type:'user',author_id:seq===triggerSequence && !ownRequest?'user_human':'user_owner',author_email:'human@example.test',body:seq===triggerSequence?'@Helper answer':'Large prior message'}],next:seq});
        }
        return response({messages:[
          priorBotBody?{sequence:1,author_type:'bot',author_id:'bot',author_email:'',body:priorBotBody}:{sequence:1,author_type:'user',author_id:'user_owner',author_email:'owner@example.test',body:'Hello group'},
          {sequence:2,author_type:'user',author_id:ownRequest?'user_owner':'user_human',author_email:'human@example.test',body:'@Helper answer'}],next:2});
      }
      if(url.endsWith('/result')) {
        if(revoked) return response({error:'not_found'},404);
        if(replyFailures-->0) return response({error:'service_unavailable'},503);
        assert.equal(body.claimId,claim);reply=body.text;return response({id:'e'.repeat(32),sequence:3});
      }
      throw new Error('Unexpected route');
    }});
  return {client,input:{teamId,channelId,localBotId:'local',jobId},received,runs:()=>runs,reply:()=>reply};
}

test('explicit approval executes once as approving participant for a handed-off request and retries delivery without inference',async t=>{
  const f=fixture(t,{replyFailures:1});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();assert.equal(f.runs(),0,'polling never executes');
  await Promise.all([f.client.run(owner,f.input,'fixture.token'),f.client.run(owner,f.input,'fixture.token')]);
  await f.client.idle();
  assert.equal(f.runs(),1);assert.equal(f.reply(),undefined);
  assert.equal(f.received[0].owner,owner);
  assert.equal(f.received[0].trigger.author_id,'user_human');
  assert.equal(f.received[0].history.length,1);
  await f.client.poll(owner,f.input,'fresh.token');await f.client.idle();
  assert.equal(f.runs(),1);assert.equal(withoutRunLabel(f.reply()),'A distinct bot reply');
});

test('revoked job aborts active inference and cannot publish its output',async t=>{
  const f=fixture(t,{revokeDuringRun:true});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.run(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.runs(),1);assert.equal(f.received[0].signal.aborted,true);assert.equal(f.reply(),undefined);
});


test('trigger is fetched directly even when bounded history pages are small',async t=>{
  const f=fixture(t,{smallPages:true});await f.client.share(owner,f.input,'fixture.token');
  await f.client.run(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.runs(),1);assert.equal(f.received[0].trigger.sequence,40);
});

test('local source removal does not change an approved shared definition',async t=>{
  const f=fixture(t,{removeDuringHistory:true});await f.client.share(owner,f.input,'fixture.token');
  await f.client.run(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.runs(),1);assert.equal(f.received[0].bot.instructions,'Approved shared purpose');
});

// A signed-in participant's own request is the authorization to execute locally.
test('own request starts on poll without another approval and concurrent polls never duplicate inference',async t=>{
  const f=fixture(t,{ownRequest:true});
  await f.client.share(owner,f.input,'fixture.token');
  await Promise.all([f.client.poll(owner,f.input,'fixture.token'),f.client.poll(owner,f.input,'fixture.token')]);
  await f.client.idle();
  assert.equal(f.runs(),1);
  assert.equal(withoutRunLabel(f.reply()),'A distinct bot reply');
  assert.equal(f.received[0].owner,owner);
  assert.equal(f.received[0].trigger.author_id,'user_owner');
  await f.client.poll(owner,f.input,'fresh.token');await f.client.idle();
  assert.equal(f.runs(),1);
});

// Shared channels allow the Hub's 16,000-byte messages; a reply over the old
// 4,000-byte local cap used to turn into "could not complete the request".
test('long shared-channel replies are published, and over-limit replies are shortened instead of lost',async t=>{
  const long='Paragraph of a detailed answer. '.repeat(375);
  assert.ok(Buffer.byteLength(long)>4000 && Buffer.byteLength(long)<16000);
  const f=fixture(t,{ownRequest:true,replyText:long});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(withoutRunLabel(f.reply()),long);
  assert.deepEqual(f.received[0].channel,{teamId,teamName:'',channelId,privateChat:false});

  const huge='é'.repeat(9000);
  const g=fixture(t,{ownRequest:true,replyText:huge});
  await g.client.share(owner,g.input,'fixture.token');
  await g.client.poll(owner,g.input,'fixture.token');await g.client.idle();
  assert.ok(Buffer.byteLength(g.reply())<=16000);
  assert.match(withoutRunLabel(g.reply()),/^é+\n\n\[Reply shortened to fit the channel\.\]$/);
});

test('a bot reply says who ran it and with which provider',async t=>{
  const f=fixture(t,{ownRequest:true,displayName:'Tom Reyes',replyText:{text:'Done',provider:'Grok'}});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.reply(),'Done\n\n\u2063Grok · Ran on Tom’s Mia');
});

test('the run label never needs a provider or a name, and a failed run has none',async t=>{
  assert.equal(runLabel('','Ana'),'Ran on Ana’s Mia');
  assert.equal(runLabel('Claude',''),'Claude · Ran on a colleague’s Mia');
  const f=fixture(t,{ownRequest:true,revokeDuringRun:false,replyText:{provider:'Grok'}});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.reply().includes('\u2063'),false);
});

test('bots read history without run labels, and a reply cannot forge one',async t=>{
  const f=fixture(t,{ownRequest:true,priorBotBody:'Earlier\n\n\u2063Grok · Ran on Tom’s Mia'});
  await f.client.share(owner,f.input,'fixture.token');
  await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();
  assert.equal(f.received[0].history[0].body,'Earlier');
  assert.equal(withRunLabel('Hi\n\n\u2063Claude · Ran on Sam’s Mia','Grok · Ran on Tom’s Mia'),'Hi\n\nClaude · Ran on Sam’s Mia\n\n\u2063Grok · Ran on Tom’s Mia');
});

test('a labelled reply still fits the Hub limit',()=>{
  const labelled=withRunLabel('a'.repeat(REPLY_BYTES*2),'Grok · Ran on Tom’s Mia');
  assert.ok(Buffer.byteLength(labelled)<=REPLY_BYTES);
  assert.match(labelled,/shortened to fit[^]*Ran on Tom/);
});

test('your Bot Instructions apply only in your own private chat with a company bot',async t=>{
  const run=async options=>{
    const f=fixture(t,options);
    await f.client.share(owner,f.input,'fixture.token');
    await f.client.poll(owner,f.input,'fixture.token');await f.client.idle();
    // Someone else's request runs only once the owner approves it.
    if(!options.ownRequest) {await f.client.run(owner,f.input,'fixture.token');await f.client.idle();}
    return f.received[0].channel.privateChat;
  };
  assert.equal(await run({ownRequest:true,channelKind:'bot',memberIds:['user_owner']}),true,'your private bot chat');
  assert.equal(await run({ownRequest:true,channelKind:'channel',memberIds:['user_owner','user_human']}),false,'a shared channel');
  assert.equal(await run({ownRequest:true,channelKind:'bot',memberIds:['user_owner','user_human']}),false,'a bot chat someone else is in');
  assert.equal(await run({ownRequest:false,channelKind:'bot',memberIds:['user_owner']}),false,'a message from someone else');
});

test('the bot turn uses the owner\'s Bot Instructions only for a private chat, else only ask-before-do', async () => {
  const {readFileSync}=await import('node:fs');
  const server=readFileSync(new URL('./server.js',import.meta.url),'utf8');
  const start=server.indexOf('async function runSharedBotTurn(');
  const body=server.slice(start,server.indexOf('\n}\n',start));
  assert.match(body,/globalInstructions: channel\.privateChat === true\s*\? promptInstructions\(owner\)\.bot\s*: \{ askBeforeDo: currentInstructionSettings\(owner\)\.askBeforeDo \}/);
});
