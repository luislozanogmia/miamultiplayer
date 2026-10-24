const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const moduleSource=fs.readFileSync(path.join(__dirname,'../hub-chat.js'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function transport(extra={}){const root={crypto:require('node:crypto').webcrypto,...extra};const context={window:root,TextEncoder};vm.runInNewContext(moduleSource,context);return root.MiaHubChat;}
function appFunction(name,env){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0,name);const first=source.slice(start,source.indexOf('\n',start));const end=/}\s*$/.test(first)?start+first.length:source.indexOf('\n  }\n',start)+4;assert.ok(end>start,name);vm.runInNewContext(source.slice(start,end),env);return env[name];}
test('workspace IDs are strict and generated IDs match server contract',()=>{const api=transport();assert.match(api.id(),/^[a-f0-9]{32}$/);assert.equal(api.teamId('hub_'+'a'.repeat(32)),'a'.repeat(32));assert.equal(api.teamId('hub_../solo'),null);});
test('message adapter preserves authoritative sender and literal signed-looking body',()=>{const api=transport();const row=api.message({id:'x',author_email:'real@example.test',body:'[fake@example.test] hello',created_at:123,sequence:7});assert.equal(row.hubAuthor,'real@example.test');assert.equal(row.body,'[fake@example.test] hello');assert.equal(row.ts,123000);assert.equal(row.nativeEvent.sequence,7);});
test('UTF8 limit applies to bytes, not characters',()=>{const api=transport();assert.equal(api.validateText('a'.repeat(16000)).length,16000);assert.throws(()=>api.validateText('😀'.repeat(4001)));assert.equal(api.validateText('',true),'');assert.throws(()=>api.validateText(' '));});
test('each request obtains a fresh native session; body is exactly supplied data',async()=>{let tokens=0;const sent=[];const api=transport({miaDesktop:{auth:{getSessionToken:async()=>({token:++tokens})}},MiaClerkDesktop:{unwrap:r=>'token'+r.token},fetch:async(url,opts)=>{sent.push({url,opts});return {ok:true,json:async()=>({})};}});await api.call('GET','/v1/me');await api.call('POST','/v1/teams/a/channels/b/messages',{id:'c',text:'hello'});assert.equal(sent[0].opts.headers.authorization,'Bearer token1');assert.equal(sent[1].opts.headers.authorization,'Bearer token2');assert.deepEqual(JSON.parse(sent[1].opts.body),{id:'c',text:'hello'});assert.equal(sent[1].url,'/api/hub/v1/teams/a/channels/b/messages');});
test('no session means no request or local fallback',async()=>{let fetched=false;const api=transport({fetch:()=>{fetched=true;}});await assert.rejects(api.call('GET','/v1/me'),/Sign in/);assert.equal(fetched,false);});
test('Hub entrypoints cannot start local conversation/socket or typing transports',async()=>{for(const name of ['loadNativeConversations','applyNativeConversationList','connectNativeChatSocket','connectNativeWatchSocket','pollLiveState','setLocalChatTypingActivity']){const env={hubWorkspace:()=>true};const fn=appFunction(name,env);await fn();}});
test('both Hub/local transition directions persist scope, invalidate history, stop polling and reload',()=>{
  for(const [from,to] of [['hub_'+'a'.repeat(32),'solo'],['solo','hub_'+'a'.repeat(32)]]){
    let reloads=0,stops=0;const stored=[];
    const env={WORKSPACE_OPTIONS:{solo:{mode:'solo'},['hub_'+'a'.repeat(32)]:{mode:'multiplayer'}},activeWorkspaceKey:from,WORKSPACE_STORAGE_KEY:'scope',Number,clearSoloHumanDirectoryState:()=>{},localStorage:{setItem:(k,v)=>stored.push(v)},chatWs:{navigationGeneration:9},stopChatPolling:()=>stops++,setAppLoading:()=>{},location:{reload:()=>reloads++}};
    env.hubWorkspace=()=>/^hub_/.test(env.activeWorkspaceKey);
    appFunction('activateWorkspace',env)(to);
    assert.equal(env.activeWorkspaceKey,to);assert.deepEqual(stored,[to]);assert.equal(env.chatWs.navigationGeneration,10);assert.equal(stops,1);assert.equal(reloads,1);
  }
});
test('Hub author grouping uses verified author rather than text signatures',()=>{
 const env={currentUser:'self@example.test',parseSignedHumanBody:()=>({agent:null})};
 const key=appFunction('chatHumanSenderKey',env);
 assert.notEqual(key({hubAuthor:'mac@example.test',body:'hello'}),key({hubAuthor:'windows@example.test',body:'hello'}));
 assert.equal(key({hubAuthor:'self@example.test',body:'[other@example.test] text'}),'me');
});
test('Hub bot messages use explicit bot identity and cannot masquerade as humans',()=>{
  const api=transport();
  const message=api.message({id:'m',sequence:3,author_type:'bot',author_id:'bot:abc',author_name:'Helper',author_email:'',body:'[owner@example.test] literal',created_at:1});
  assert.equal(message.nativeAgentName,'Helper');assert.equal(message.hubAuthor,null);
  assert.equal(message.body,'[owner@example.test] literal');
  const human=appFunction('isHumanSender',{hubWorkspace:()=>true});
  assert.equal(human(message.sender),false);assert.equal(human('owner@example.test'),true);
});

test('Hub roster contains only shared bots and offers local bots through explicit sharing',async()=>{
  const state={},calls=[];
  const env={Promise,Date,Number,window:{MiaHubChat:{localCall:async(method,path,body)=>{
    calls.push({method,path,body});return path==='/available'?{bots:[{id:'local',name:'Private bot'}]}:{running:0};
  }}},hubWorkspace:()=>true,activeWorkspaceKey:'hub_'+'a'.repeat(32),chatWs:{configured:true,activeRoomId:'channel'},chatRoomState:()=>state,hubPath:()=>'/team',
  hubCall:async(method,path)=>path.endsWith('/bots')?{bots:[{id:'shared',name:'Shared bot',published:1}]}:{members:[{email:'human@example.test'}]},
  chatMention:{open:false},renderChatHeaderBar:()=>{},renderChatThread:()=>{},renderMentionPopover:()=>{}};
  await appFunction('refreshHubBotState',env)('channel',true);
  assert.equal(state.mentionRoster.agents.length,1);assert.equal(state.mentionRoster.agents[0].id,'shared');
  assert.equal(state.mentionRoster.privateAgents.length,0);
  assert.equal(state.mentionRoster.notInChatAgents[0].id,'local');
  assert.equal(calls.some(call=>call.path==='/share'),false);
});

test('clicking a shared bot mention updates composer via input event, without private IIFE helper',()=>{
  let events=0,focused=0;const input={value:'Hello',focus:()=>focused++,dispatchEvent:event=>{assert.equal(event.type,'input');events++;}};
  const env={el:()=>input,Event,hubChat:{botsOpen:true},renderChatHeaderBar:()=>{}};
  appFunction('insertHubMention',env)('Helper');
  assert.equal(input.value,'Hello @Helper ');assert.equal(events,1);assert.equal(focused,1);assert.equal(env.hubChat.botsOpen,false);
});

test('mention typing respects roster throttle and cannot trigger execution polling',async()=>{
  let reads=0,executes=0;const state={};
  const env={Promise,Date:{now:()=>120000},Number,window:{MiaHubChat:{localCall:async(method,path)=>{if(path==='/poll')executes++;return {bots:[]};}}},
    hubWorkspace:()=>true,activeWorkspaceKey:'hub_'+'a'.repeat(32),chatWs:{configured:true,activeRoomId:'channel'},chatRoomState:()=>state,hubPath:()=>'/team',
    hubCall:async(method,path)=>{reads++;return path.endsWith('/bots')?{bots:[{id:'shared',name:'Shared'}]}:{members:[]};},chatMention:{open:false},renderChatHeaderBar:()=>{},renderChatThread:()=>{},renderMentionPopover:()=>{}};
  env.refreshHubBotState=appFunction('refreshHubBotState',env);
  const load=appFunction('loadMentionRoster',env);
  for(let n=0;n<20;n++)await load('channel');
  assert.equal(reads,2);assert.equal(executes,0);
});

test('revoked roster response cannot repopulate bot identities',async()=>{
 let resolve;const state={};
 const env={Promise,Date,Number,window:{MiaHubChat:{localCall:async()=>({bots:[]})}},hubWorkspace:()=>true,activeWorkspaceKey:'hub_a',chatWs:{configured:true,activeRoomId:'room',navigationGeneration:1},chatRoomState:()=>state,hubPath:()=>'/team',hubCall:()=>new Promise(r=>{if(!resolve)resolve=r;else r({members:[]});}),chatMention:{open:false},renderChatHeaderBar:()=>{},renderChatThread:()=>{},renderMentionPopover:()=>{}};
 const pending=appFunction('refreshHubBotState',env)('room',true);
 env.chatWs.navigationGeneration++;env.chatWs.configured=false;
 resolve({bots:[{id:'old',name:'Old'}]});await pending;
 assert.equal(state.hubBots,undefined);assert.equal(state.mentionRoster,undefined);
});

test('share completion cannot insert a mention after navigation during roster refresh',async()=>{
 let resolveRefresh,inserted=0;
 const env={Promise,Number,Object,chatMention:{shareMode:'linked',confirmEntry:{kind:'agent',id:'local',label:'Helper'}},chatWs:{configured:true,activeRoomId:'A',navigationGeneration:1},activeWorkspaceKey:'hub_a',hubWorkspace:()=>true,renderMentionPopover:()=>{},window:{MiaHubChat:{localCall:async()=>({})}},refreshHubBotState:()=>new Promise(r=>resolveRefresh=r),insertMentionText:()=>inserted++,closeMentionPopover:()=>{},cancelMentionConfirm:()=>{},showBenchToast:()=>{}};
 appFunction('confirmMentionAdd',env)();await new Promise(r=>setImmediate(r));
 env.chatWs.activeRoomId='B';env.chatWs.navigationGeneration++;
 resolveRefresh();await new Promise(r=>setImmediate(r));
 assert.equal(inserted,0);
});

test('Add bot click does not bubble into the document popover dismiss handler',()=>{
 let stopped=false,opened=false;const input={value:'',focus(){},setSelectionRange(){}};
 const env={el:()=>input,mentionTriggerAt:()=>({atPos:0,query:''}),openMentionPopover:()=>opened=true};
 appFunction('openHubBotPicker',env)({stopPropagation:()=>stopped=true});
 assert.equal(stopped,true);assert.equal(opened,true);assert.equal(input.value,'@');
});

test('unshared Hub bot selection requires sharing confirmation instead of inserting a plain mention',()=>{
 let inserted=false,rendered=false;const entry={kind:'agent',id:'local',label:'Helper',inChat:false};
 const env={hubWorkspace:()=>true,chatWs:{activeKind:'group'},chatMention:{},insertMentionText:()=>inserted=true,closeMentionPopover:()=>{},renderMentionPopover:()=>rendered=true,renderMentionConfirm:()=>rendered=true};
 appFunction('selectMentionEntry',env)(entry);
 assert.equal(inserted,false);assert.equal(env.chatMention.confirmEntry,entry);assert.equal(rendered,true);
});

test('sharing requires an explicit linked or fork choice before any request',()=>{
 let calls=0,notice='';
 const env={chatWs:{activeRoomId:'room'},chatMention:{confirmEntry:{kind:'agent',id:'local',label:'Helper'}},hubWorkspace:()=>true,showBenchToast:m=>notice=m,window:{MiaHubChat:{localCall:()=>calls++}}};
 appFunction('confirmMentionAdd',env)();
 assert.equal(calls,0);assert.match(notice,/Choose linked/);
});

test('shared roster refreshes on the next four-second poll after another participant adds a bot',async()=>{
  const state={hubBotsAt:Date.now()-4001};let requests=0;
  const env={Promise,Date,Number,window:{MiaHubChat:{localCall:async()=>({bots:[]})}},hubWorkspace:()=>true,activeWorkspaceKey:'hub_a',chatWs:{configured:true,activeRoomId:'channel',navigationGeneration:1},chatRoomState:()=>state,hubPath:()=>'/team',hubCall:async(method,path)=>{requests++;return path.endsWith('/bots')?{bots:[{id:'one',name:'One'},{id:'two',name:'Two'}]}:{members:[]};},chatMention:{open:false},renderChatHeaderBar:()=>{},renderChatThread:()=>{},renderMentionPopover:()=>{}};
  await appFunction('refreshHubBotState',env)('channel',false);
  assert.equal(requests,2);assert.equal(state.hubBots.length,2);
});
test('server system notices render as inert system rows',()=>{
  const row=transport().message({id:'joined',sequence:9,author_type:'system',author_id:'system:bot-joined',author_email:'',body:'Helper joined the chat.',created_at:100});
  assert.equal(row.system,true);assert.equal(row.hubAuthor,null);assert.equal(row.body,'Helper joined the chat.');
});

test('frequent roster refresh reuses the membership directory to preserve request budget',async()=>{
 const state={hubBotsAt:Date.now()-4001,hubDirectoryAt:Date.now(),hubMembers:[{email:'member@example.test'}],hubAvailableBots:[]};const paths=[];
 const env={Promise,Date,Number,window:{MiaHubChat:{localCall:async()=>{throw Error('directory must be cached');}}},hubWorkspace:()=>true,activeWorkspaceKey:'hub_a',chatWs:{configured:true,activeRoomId:'channel',navigationGeneration:1},chatRoomState:()=>state,hubPath:()=>'/team',hubCall:async(method,path)=>{paths.push(path);return {bots:[{id:'two',name:'Two'}]};},chatMention:{open:false},renderChatHeaderBar:()=>{},renderChatThread:()=>{},renderMentionPopover:()=>{}};
 await appFunction('refreshHubBotState',env)('channel',false);
 assert.deepEqual(paths,['/team/channels/channel/bots']);assert.equal(state.mentionRoster.humans[0].email,'member@example.test');
});

test('unpublished roster bot is visibly awaiting admin approval',()=>{
 const header={style:{},innerHTML:''},control={addEventListener(){}};
 const env={hubWorkspace:()=>true,chatWs:{activeRoomId:'channel',activeLabel:'Shared'},chatRoomState:()=>({hubBots:[{id:'bot',name:'Pod',published:null}]}),hubChat:{botsOpen:true},el:selector=>selector==='#channelHeader'?header:control,els:()=>[],esc:s=>s,openHubBotPicker:()=>{},closeMobileChatRoom:()=>{}};
 appFunction('renderChatHeaderBar',env)();
 assert.match(header.innerHTML,/0 bots/);assert.match(header.innerHTML,/@Pod/);assert.match(header.innerHTML,/Awaiting admin approval/);
});

test('administrator approval button is visible without expanding instruction details',async()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.style={};this.isConnected=true;}append(n){this.children.push(n);n.parent=this;}setAttribute(){}replaceChildren(){this.children=[];}showModal(){}remove(){this.isConnected=false;}close(){}}
 const document={querySelector:()=>null,createElement:tag=>new Element(tag),body:new Element('body')};
 const window={MiaHubChat:{localCall:async()=>({pending:[]}),call:async(method,path)=>{
   if(path.endsWith('/bots'))return {bots:[{id:'bot',name:'Pod'}]};
   if(path.endsWith('/definition'))return {mode:'linked',definition:null,isAdmin:true};
   if(path.endsWith('/versions'))return {versions:[{version:1,instructions:'Shared instruction'}]};
   return {members:[]};
 }}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../hub-bot-manager.js'),'utf8'),{window,document});
 await window.MiaHubBots.open({teamId:'team',channelId:'channel',refresh:async()=>{}});
 const all=[];function visit(n){all.push(n);n.children.forEach(visit);}visit(document.body);
 const button=all.find(n=>n.tag==='button' && n.textContent==='Approve version 1');
 assert.ok(button);assert.equal(button.parent.tag,'section');
});

// Shared environment for the live-feed client functions.
function hubEnv(overrides={}){
  const byRoom={};
  const env={Promise,Number,Math,Object,JSON,Date,window:{MiaHubChat:transport()},hubWorkspace:()=>true,activeWorkspaceKey:'hub_'+'a'.repeat(32),currentUser:'self@example.test',
    hubChat:{channels:[{id:'room',name:'general'}],typing:[],readRequests:{},membership:{clerk_user_id:'user_self',role:'member'}},
    chatWs:{configured:true,activeRoomId:'room',navigationGeneration:1,byRoom},
    chatRoomState:id=>byRoom[id]||(byRoom[id]={messages:[]}),hubPath:()=>'/team',appInForeground:()=>true,
    renderChatSidebar:()=>{},renderChatThread:()=>{},renderDeptAgentSelector:()=>{},renderChatHeaderBar:()=>{},refreshChatMain:()=>{},
    showBenchToast:()=>{},showDesktopNotification:()=>{},notifyDesktopChatMessage:()=>{},pollHubBots:()=>{},refreshHubBotState:()=>{},refreshHubChannels:()=>Promise.resolve(),
    startChatThinking:()=>{},stopChatThinking:()=>{},hubCall:async()=>({messages:[],hasMore:false}),...overrides};
  for(const name of ['hubChannel','hubSequence','hubOwnMessage','hubLatestSequence','applyHubRows','markHubRead','loadHubRoom','loadOlderHubMessages','sendHubMessage','deliverHubMessage','hubMessageDeletable','deleteHubMessage','applyHubEvents','trackHubDispatch','hubRoomThinking','hubFeedback','stopHubFeed'])
    if(!(name in overrides))env[name]=appFunction(name,env);
  return env;
}
const row=(sequence,extra={})=>({id:'m'+sequence,channel_id:'room',author_id:'user_other',author_email:'other@example.test',author_type:'human',body:'hello '+sequence,created_at:sequence,sequence,...extra});
const settle=()=>new Promise(r=>setImmediate(r));

test('stale Hub history response cannot populate a newly selected channel',async()=>{
  let resolve;const env=hubEnv({hubCall:()=>new Promise(r=>resolve=r)});
  const pending=env.loadHubRoom();env.chatWs.navigationGeneration++;env.chatWs.activeRoomId='other';
  resolve({messages:[row(1)],hasMore:false});await pending;
  assert.equal(env.chatRoomState('room').messages.length,0);
});
test('opening a channel ignores an inherited local room before issuing a request',async()=>{
  let calls=0;const env=hubEnv({hubCall:()=>{calls++;}});env.chatWs.activeRoomId='local-mia';
  await env.loadHubRoom();assert.equal(calls,0);
});
test('opening a channel loads the newest page, keeps the older-page cursor and marks it read',async()=>{
  const paths=[],bodies=[];const env=hubEnv({hubCall:async(method,url,body)=>{paths.push(method+' '+url);bodies.push(body);return method==='GET'?{messages:[row(41),row(42)],hasMore:true,before:41}:{};}});
  await env.loadHubRoom();
  const state=env.chatRoomState('room');
  assert.equal(paths[0],'GET /team/channels/room/messages/before/0');
  assert.deepEqual([...state.messages.map(m=>m.id)],['hub-sequence-41','hub-sequence-42']);
  assert.equal(state.historyCursor,41);assert.equal(state.historyComplete,false);
  assert.equal(paths[1],'POST /team/channels/room/read');assert.equal(JSON.stringify(bodies[1]),'{"sequence":42}');
  env.hubCall=async(method,url)=>{paths.push(url);return {messages:[row(40)],hasMore:false,before:40};};
  env.loadOlderHubMessages=appFunction('loadOlderHubMessages',env);
  await env.loadOlderHubMessages('room');
  assert.equal(paths[2],'/team/channels/room/messages/before/41');
  assert.deepEqual([...state.messages.map(m=>m.id)],['hub-sequence-40','hub-sequence-41','hub-sequence-42']);
  assert.equal(state.historyCursor,null);assert.equal(state.historyComplete,true);
});
test('different authors with colliding message IDs remain distinct, replayed sequences deduplicate',()=>{
  const api=transport();
  const rows=[row(1,{id:'collision',author_email:'one@example.test'}),row(2,{id:'collision',author_email:'two@example.test'})];
  const merged=api.merge(api.merge([],rows),rows.slice(1));
  assert.deepEqual(merged.map(m=>m.id),['hub-sequence-1','hub-sequence-2']);
});
test('a send shows immediately, and a failed delivery stays in the timeline and retries with the same id',async()=>{
  const requests=[];let fail=true;
  const env=hubEnv({hubCall:async(method,url,body)=>{requests.push(body);if(fail)throw new Error('Connection unavailable.');return {sequence:9,dispatches:[]};}});
  const state=env.chatRoomState('room');
  assert.equal((await env.sendHubMessage('hello',null,null,'room')).status,201);
  assert.equal(state.messages.length,1);assert.equal(state.messages[0].body,'hello');
  await settle();
  const local=state.messages[0];
  assert.equal(local.hubFailed,true);assert.equal(local.pending,false);assert.match(local.hubError,/Connection unavailable/);
  fail=false;await env.deliverHubMessage('room',local);
  assert.equal(requests[0].id,requests[1].id);assert.deepEqual(Object.keys(requests[0]).sort(),['id','text']);
  assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,'hub-sequence-9');assert.equal(state.messages[0].hubFailed,false);
});
test('the live copy of a sent message replaces the local copy instead of duplicating it',async()=>{
  const env=hubEnv({hubCall:async()=>new Promise(()=>{})});
  const state=env.chatRoomState('room');state.historyInitialized=true;
  await env.sendHubMessage('hi',null,null,'room');
  const id=state.messages[0].hubMessageId;
  env.applyHubEvents([{kind:'message',channel_id:'room',message:row(5,{id,author_id:'user_self',author_email:'self@example.test',body:'hi'})}]);
  assert.deepEqual([...state.messages.map(m=>m.id)],['hub-sequence-5']);
});
test('thread replies and images are sent with the thread root and uploaded file',async()=>{
  const calls=[];const env=hubEnv({hubCall:async(method,url,body)=>{calls.push({url,body});return url.endsWith('/files')?{file:{id:'f'.repeat(32)}}:{sequence:12};}});
  const upload={filename:'a.png',mimeType:'image/png',contentBase64:'AAAA',previewUrl:'blob:x'};
  await env.sendHubMessage('',{hubUpload:upload},'hub-sequence-7','room');await settle();await settle();
  assert.equal(calls[0].url,'/team/channels/room/files');
  assert.deepEqual(calls[1].body.threadRoot,7);assert.equal(calls[1].body.attachmentId,'f'.repeat(32));
  const sent=env.chatRoomState('room').messages[0];
  assert.equal(sent.threadRoot,'hub-sequence-7');assert.equal(sent.hubFile.id,'f'.repeat(32));
});
test('messages from others raise unread on closed channels and mark the open channel read',()=>{
  const reads=[];const env=hubEnv({hubCall:async(method,url,body)=>{reads.push({url,body});return {};}});
  env.hubChat.channels.push({id:'side',name:'side'});
  env.chatRoomState('room').historyInitialized=true;
  env.applyHubEvents([{kind:'message',channel_id:'side',message:row(3,{channel_id:'side'})},{kind:'message',channel_id:'room',message:row(4)}]);
  assert.equal(env.hubChannel('side').unread,1);assert.equal(env.hubChannel('room').unread,0);
  assert.equal(JSON.stringify(reads),JSON.stringify([{url:'/team/channels/room/read',body:{sequence:4}}]));
  env.applyHubEvents([{kind:'message',channel_id:'side',message:row(6,{channel_id:'side',author_id:'user_self'})}]);
  assert.equal(env.hubChannel('side').unread,1);
  env.applyHubEvents([{kind:'read',channel_id:'side',last_read:6}]);
  assert.equal(env.hubChannel('side').unread,0);
});
test('a pending bot request from this member starts on this computer right away',()=>{
  let polls=0;const env=hubEnv({pollHubBots:()=>polls++});
  env.applyHubEvents([{kind:'dispatch',channel_id:'room',dispatch:{id:'d1',state:'pending',executor_id:'user_other',requester_id:'user_other'}}]);
  assert.equal(polls,0);
  env.applyHubEvents([{kind:'dispatch',channel_id:'room',dispatch:{id:'d2',state:'pending',executor_id:'user_self',requester_id:'user_self'}}]);
  assert.equal(polls,1);
});
test('only the author or an admin can delete; deleted messages stay as a marker',async()=>{
  const env=hubEnv({hubCall:async()=>({})});
  const own={id:'hub-sequence-3',hubMessage:true,hubAuthor:'self@example.test',body:'mine'},other={id:'hub-sequence-4',hubMessage:true,hubAuthor:'other@example.test',body:'theirs'};
  assert.equal(env.hubMessageDeletable(own),true);assert.equal(env.hubMessageDeletable(other),false);
  env.hubChat.membership.role='admin';assert.equal(env.hubMessageDeletable(other),true);
  env.chatRoomState('room').messages=[other];
  await env.deleteHubMessage('room','hub-sequence-4');
  assert.equal(other.deleted,true);assert.equal(other.body,'Message deleted');
});
test('revocation resets history so a reinvited member reloads from the newest page',async()=>{
  const env=hubEnv();let stopped=0;env.hubChat.feed={stop:()=>stopped++};
  const state=env.chatRoomState('room');Object.assign(state,{messages:[{id:'cached'}],lastSequence:17,lastTs:100,historyInitialized:true,historyComplete:true,historyCursor:3});
  env.hubFeedback({status:404,message:'Unavailable'});
  assert.equal(state.messages.length,0);assert.equal(state.lastSequence,0);assert.equal(state.historyInitialized,false);assert.equal(state.historyCursor,null);
  assert.equal(env.chatWs.configured,false);assert.equal(env.chatWs.navigationGeneration,2);assert.equal(stopped,1);
  const paths=[];env.hubCall=async(method,url)=>{paths.push(url);return {messages:[row(1,{body:'Earlier message'})],hasMore:false};};
  env.loadHubRoom=appFunction('loadHubRoom',env);await env.loadHubRoom();
  assert.equal(paths[0],'/team/channels/room/messages/before/0');assert.equal(state.messages[0].body,'Earlier message');assert.equal(env.chatWs.configured,true);
});
test('live feed resumes from its cursor, reports offline, backs off and asks for a reload after a gap',async()=>{
  const timers=[];const root={crypto:require('node:crypto').webcrypto,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){}};
  const context={window:root,TextEncoder};vm.runInNewContext(moduleSource,context);
  const answers=[{events:[],next:10},Promise.reject(Object.assign(new Error('down'),{status:502})),{events:[{kind:'channel'}],next:12,typing:[{channel_id:'room'}]},{events:[],next:20,reset:true}];
  const paths=[],seen=[];let resets=0;
  answers[1].catch(()=>{});
  root.MiaHubChat.feed({teamId:'t',call:(m,p)=>{paths.push(p);return Promise.resolve(answers.shift());},onEvents:e=>seen.push(...e),onReset:lost=>resets+=lost?10:1,onTyping:()=>{},onStatus:(s)=>seen.push(s)});
  for(let n=0;n<4;n++){timers.shift().fn();await settle();}
  assert.deepEqual(paths,['/v1/teams/t/events/after/0','/v1/teams/t/events/after/10','/v1/teams/t/events/after/10','/v1/teams/t/events/after/12']);
  assert.ok(seen.includes('offline'));assert.equal(resets,11);assert.equal(seen.filter(e=>e.kind==='channel').length,1);
});
