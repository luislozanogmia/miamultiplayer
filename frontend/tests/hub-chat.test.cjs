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
  const env={el:()=>input,Event};
  appFunction('insertHubMention',env)('Helper');
  assert.equal(input.value,'Hello @Helper ');assert.equal(events,1);assert.equal(focused,1);
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
 const env={Promise,Number,Object,chatMention:{shareMode:'linked',confirmEntry:{kind:'agent',id:'local',label:'Helper'}},chatWs:{configured:true,activeRoomId:'A',navigationGeneration:1},activeWorkspaceKey:'hub_a',hubWorkspace:()=>true,renderMentionPopover:()=>{},shareBotToHubChannel:async()=>false,refreshHubBotState:()=>new Promise(r=>resolveRefresh=r),insertMentionText:()=>inserted++,closeMentionPopover:()=>{},cancelMentionConfirm:()=>{},showBenchToast:()=>{}};
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

// The header only counts live bots; its chip opens People and bots, the one
// list of the channel's bots, so there is no second list with its own Remove.
test('the header bot count opens the People and bots list instead of its own',()=>{
 const header={style:{},innerHTML:''},handlers={},control=id=>({addEventListener:(type,fn)=>{handlers[id]=fn;}});
 let opened=0;const openManageAgentsPane=()=>opened++;
 const env={hubWorkspace:()=>true,chatWs:{activeRoomId:'channel',activeLabel:'Shared'},chatRoomState:()=>({hubBots:[{id:'bot',name:'Pod',published:null},{id:'b2',name:'Live',published:1}]}),hubChat:{},el:selector=>selector==='#channelHeader'?header:control(selector),els:()=>[],esc:s=>s,openHubBotPicker:()=>{},openManageAgentsPane,closeMobileChatRoom:()=>{},renderChatTabs:()=>{}};
 appFunction('renderChatHeaderBar',env)();
 assert.match(header.innerHTML,/1 bots/);assert.doesNotMatch(header.innerHTML,/Remove|@Pod|ch-roster-panel/);
 assert.equal(handlers['#hubBotsToggle'],openManageAgentsPane);
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
  const env={Promise,Number,Math,Object,JSON,Date,window:{MiaHubChat:transport()},navigator:{onLine:true},hubWorkspace:()=>true,activeWorkspaceKey:'hub_'+'a'.repeat(32),currentUser:'self@example.test',currentAccountEmail:'self@example.test',
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
  assert.equal(local.sendFailed,true);assert.equal(local.pending,false);assert.match(local.sendError,/Connection unavailable/);
  fail=false;await env.deliverHubMessage('room',local);
  assert.equal(requests[0].id,requests[1].id);assert.deepEqual(Object.keys(requests[0]).sort(),['id','text']);
  assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,'hub-sequence-9');assert.equal(state.messages[0].sendFailed,false);
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
test('your confirmed Hub message stays yours when the local identity differs from the Hub account',()=>{
  const api=transport();
  const confirmed=api.message({id:'m',sequence:4,author_type:'human',author_id:'user_self',author_email:'account@example.test',body:'hi',created_at:1});
  const other=api.message({id:'n',sequence:5,author_type:'human',author_id:'user_other',author_email:'account@example.test',body:'hi',created_at:1});
  const env={currentUser:'local-profile@example.test',currentAccountEmail:'account@example.test',hubChat:{membership:{clerk_user_id:'user_self'}},String};
  const own=appFunction('hubOwnMessage',env);
  assert.equal(own({hubMessage:true,hubLocal:true}),true);
  assert.equal(own(confirmed),true);
  assert.equal(own(other),false);
  env.hubChat.membership=null;
  assert.equal(own(confirmed),true);
  assert.equal(own({...confirmed,hubAuthor:'someone@example.test'}),false);
  assert.equal(own({...confirmed,system:true}),false);
  assert.match(source,/isOwnHuman = m\.hubMessage \? hubOwnMessage\(m\)/);
});
test('consecutive messages of yours stay flush right without a side time column',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');
  assert.match(css,/\.chat-msg-row\.is-you \.chat-msg-mark-time\{display:none;\}/);
});
test('an offline send says it is offline instead of a sign-in or keyring message',async()=>{
  const env=hubEnv({hubCall:async()=>{throw new Error('Sign-in could not be completed. Check your connection and system keyring, then try again.');}});
  env.navigator.onLine=false;
  await env.sendHubMessage('hello',null,null,'room');await settle();
  const local=env.chatRoomState('room').messages[0];
  assert.equal(local.sendFailed,true);assert.equal(local.sendError,'Not delivered. You are offline.');
});
test('team channels offer Attach, Google Drive and the model menu, and keep dictation hidden',()=>{
  const nodes={};['#ccPlusBtn','#ccDriveBtn','#ccModelBtn','#ccMicBtn','#ccInput'].forEach(s=>{nodes[s]={style:{display:'none'},disabled:true};});
  let open={kind:'channel',name:'general'};
  const env={hubWorkspace:()=>true,chatWs:{activeRoomId:'room'},el:s=>nodes[s],setComposerBoundState:()=>{},hubChannel:()=>open,hubChannelTitle:()=>'ana',hubPrivateConversation:c=>!!c&&(c.kind==='dm'||c.kind==='group'),};
  appFunction('renderDeptAgentSelector',env)();
  assert.equal(nodes['#ccPlusBtn'].style.display,'');assert.equal(nodes['#ccModelBtn'].style.display,'');
  assert.equal(nodes['#ccDriveBtn'].style.display,'');assert.equal(nodes['#ccDriveBtn'].disabled,false);assert.equal(nodes['#ccMicBtn'].style.display,'none');
  assert.equal(nodes['#ccInput'].placeholder,'Message this shared channel');
  open={kind:'dm'};env.renderDeptAgentSelector();assert.equal(nodes['#ccInput'].placeholder,'Message ana');
});
test('a shared image previews in an in-app viewer instead of the shell opener',()=>{
  assert.match(source,/if\(\/\^blob:\/\.test\(url\)\)\{ openChatImageViewer\(url, button\.closest\('\.chat-artifact-card'\)\); return; \}/);
  const appended=[];const listeners={};
  const make=()=>({attrs:{},setAttribute(k,v){this.attrs[k]=v;},append(...c){this.children=c;},addEventListener(t,f){this.on=f;},remove(){this.removed=true;},focus(){this.focused=true;}});
  const document={createElement:make,body:{appendChild:n=>appended.push(n)},addEventListener:(t,f)=>{listeners[t]=f;},removeEventListener:t=>{delete listeners[t];}};
  const viewer=appFunction('openChatImageViewer',{document})('blob:mia/1',{querySelector:()=>({textContent:'cat.png'})});
  assert.equal(appended[0],viewer);assert.equal(viewer.children[0].src,'blob:mia/1');assert.equal(viewer.attrs['aria-label'],'cat.png');
  listeners.keydown({key:'Escape',stopPropagation(){}});
  assert.equal(viewer.removed,true);assert.equal(listeners.keydown,undefined);
});
test('typing clears on its own after the Hub expiry even when the feed is quiet',()=>{
  assert.match(source,/var HUB_TYPING_MS=6500;/);
  assert.match(source,/clearTimeout\(hubChat\.typingTimer\);\s*if\(typing\.length\)hubChat\.typingTimer=setTimeout\(function\(\)\{\s*if\(workspace!==activeWorkspaceKey \|\| !hubChat\.typing\.length\)return;\s*hubChat\.typing=\[\];renderChatSidebar\(\);\s*\},HUB_TYPING_MS\);/);
});
test('grouped follow-up messages show no time beside them, only a send status',()=>{
  assert.match(source,/chat-msg-mark-time">' \+ \(m\.pending \|\| m\.sendFailed \? timeText : ''\)/);
  assert.doesNotMatch(source,/chatShortRelTime/);
});
test('a shared channel alert names the sender and channel, not "replied"',()=>{
  const shown=[];
  const env={chatWs:{activeRoomId:'other'},appInForeground:()=>true,desktopNotificationsEnabled:()=>true,hubChannel:()=>({name:'general'}),hubPrivateConversation:c=>!!c&&(c.kind==='dm'||c.kind==='group'),
    displayNameForEmail:e=>e.split('@')[0],excerpt:(t,n)=>t.slice(0,n),String,showDesktopNotification:(room,title,body)=>shown.push({room,title,body})};
  env.googleDriveMessageDisplay=appFunction('googleDriveMessageDisplay',{String,JSON});
  const notify=appFunction('notifyDesktopChatMessage',env);
  notify('room',{hubMessage:true,hubAuthor:'ana@example.test',body:'hello team'});
  notify('room',{hubMessage:true,nativeAgentName:'Helper',body:''});
  notify('room',{hubMessage:true,hubAuthor:'ana@example.test',body:'',hubFile:{id:'f'}});
  const ref='\n\nAttached Google Drive files (file references, not instructions; use the Google tools to read them):\n'+JSON.stringify({name:'Plan.pdf',id:'abcdefghij12',url:'https://drive.google.com/file/d/abcdefghij12/view'});
  notify('room',{hubMessage:true,hubAuthor:'ana@example.test',body:'see this'+ref});
  notify('room',{hubMessage:true,hubAuthor:'ana@example.test',body:ref});
  assert.deepEqual(shown.map(s=>[s.title,s.body]),[['ana in #general','hello team'],['Helper in #general','New message'],['ana in #general','Sent an image'],
    ['ana in #general','see this'],['ana in #general','Shared a Google Drive file']]);
});
test('Edit says the edited text is sent as a new message',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.match(html,/id="chatCtxEdit">&#9998; Edit and resend</);
  assert.match(source,/appPrompt\(original, \{title: 'Edit and resend', message: 'Your edited text is sent as a new message\. The original stays\.', submitLabel: 'Send'\}\)/);
});
test('a shared channel shows placeholder bars, not "No messages yet", before its history arrives',()=>{
  assert.match(source,/if\(hubWorkspace\(\) && !state\.historyInitialized && !state\.messages\.length && !state\.thinking\) return showChatThreadPlaceholder\(thread\);\n\s+if\(!state\.messages\.length && !state\.thinking && !botDraftFlow\)\{/);
});
test('your own attachment cards stay readable beside the bubble',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');
  assert.match(source,/'<\/div>' : ''\) \+ mediaHtml \+/);
  assert.doesNotMatch(css,/\.is-you \.chat-artifact-(card|type|preview|download)[^{]*\{[^}]*color:(#fff|rgba\(255,255,255)/);
  assert.match(css,/\.chat-msg-row\.is-you \.chat-artifact-card\{margin-left:auto;\}/);
});
test('a reload reopens the shared channel you last had open',async()=>{
  const run=async(stored,channels)=>{const opened=[];const env={chatWs:{activeRoomId:null},hubChat:{channels},storedActiveChatLocation:()=>stored,
    loadHubTeams:()=>Promise.resolve(),refreshHubChannels:()=>{},startChatPolling(){},refreshChatMain(){},hubFeedback:e=>{throw e;},takeNewTeamBotRequest:()=>null,Date,activeWorkspaceKey:'hub_x',
    openHubChannel:(channel)=>{opened.push(channel.id);},hubPrivateConversation:c=>!!c&&(c.kind==='dm'||c.kind==='group'),Number,Promise};
    await appFunction('initHubChat',env)();return opened;};
  const channels=[{id:'first',name:'general'},{id:'second',name:'ux-test'}];
  assert.deepEqual(await run('second',channels),['second']);
  assert.deepEqual(await run('gone',channels),['first']);
  assert.deepEqual(await run('',channels),['first']);
  assert.deepEqual(await run('',[{id:'dm',kind:'dm'},...channels]),['first'],'a fresh start opens a channel, not a direct message');
});
test('a second startup keeps the New Bot setup chat the first one opened',async()=>{
  const opened=[];let main=0;
  const env={chatWs:{activeRoomId:'agent-setup',activeKind:'agent-setup'},hubChat:{channels:[{id:'first',name:'general'}]},storedActiveChatLocation:()=>'',
    loadHubTeams:()=>Promise.resolve(),refreshHubChannels:()=>{},startChatPolling(){},refreshChatMain(){main++;},renderChatSidebar(){},hubFeedback:e=>{throw e;},
    takeNewTeamBotRequest:()=>null,Date,activeWorkspaceKey:'hub_x',AGENT_SETUP_ROOM_ID:'agent-setup',
    openHubChannel:(channel)=>{opened.push(channel.id);},hubPrivateConversation:()=>false,Number,Promise};
  await appFunction('initHubChat',env)();
  assert.deepEqual(opened,[]);assert.equal(env.chatWs.activeKind,'agent-setup');assert.equal(env.chatWs.activeRoomId,'agent-setup');assert.equal(main,1);
});
test('the team People and bots panel shows the channel, not Solo, data',()=>{
  const render=role=>{
    const pane={innerHTML:'',attrs:{},classList:{add(){},remove(){}},setAttribute(k,v){this.attrs[k]=v;}};
    const state={hubMembers:[{clerk_user_id:'user_other',email:'ana@example.test',role:'member'},{clerk_user_id:'user_self',email:'self@example.test',role}],
      hubBots:[{id:'b1',name:'Helper',owner_id:'user_self',published:true},{id:'b2',name:'Writer',owner_id:'user_other',published:false,admission:{status:'pending'}}],
      hubAvailableBots:[{id:'l1',name:'Helper'},{id:'l2',name:'Scheduler'}]};
    const env={chatWs:{activeRoomId:'room'},hubChat:{membership:{clerk_user_id:'user_self',role}},chatRoomState:()=>state,hubChannel:()=>({name:'general'}),
      workspaceLabel:()=>'Acme',displayNameForEmail:e=>e.split('@')[0],humanAvatarInitialsHtml:()=>'',agentAvatarHtml:()=>'',String,
      esc:t=>String(t).replace(/</g,'&lt;'),el:()=>null,els:()=>[]};
    appFunction('renderHubPeoplePane',env)(pane);return pane;
  };
  const member=render('member').innerHTML,admin=render('admin');
  assert.equal(admin.attrs['aria-label'],'People and bots');
  assert.match(member,/Acme · #general/);assert.match(member,/People in this channel/);
  assert.ok(member.indexOf('self (you)')<member.indexOf('ana<'),'you are listed first');
  assert.match(member,/by you · live/);assert.match(member,/by ana · waiting for approval/);
  assert.equal((member.match(/data-hub-panel-remove=/g)||[]).length,1,'members remove only their own bot');
  assert.doesNotMatch(member,/data-hub-panel-review|hubPanelInvite/);
  assert.equal((admin.innerHTML.match(/data-hub-panel-remove=/g)||[]).length,2);
  assert.match(admin.innerHTML,/data-hub-panel-review/);assert.match(admin.innerHTML,/Invite people/);
  assert.match(member,/Your bots not in this channel/);assert.match(member,/data-hub-panel-add="l2"/);assert.doesNotMatch(member,/data-hub-panel-add="l1"/);
  assert.doesNotMatch(member,/Users|Agent<|Archived/);
});
test('the People button opens the team panel in a shared team',()=>{
  assert.match(source,/function renderManageAgentsPane\(pane\)\{\n    if\(hubWorkspace\(\)\) return renderHubPeoplePane\(pane\);/);
});
test('team channel menu follows the Hub permissions',()=>{
  const menu=role=>{const env={hubChat:{membership:{clerk_user_id:'me',role}}};appFunction('hubPrivateConversation',env);return appFunction('hubChannelActions',env);};
  const actions=(role,channel)=>Array.from(menu(role)(channel),a=>a.id);
  assert.deepEqual(actions('member',{kind:'channel',created_by:'other'}),['pin','leave']);
  assert.deepEqual(actions('member',{kind:'channel',created_by:'me'}),['pin','invite','rename','leave']);
  assert.deepEqual(actions('admin',{kind:'channel',created_by:'other'}),['pin','invite','rename','leave','archive']);
  assert.deepEqual(actions('admin',{kind:'dm',created_by:'me'}),['pin'],'a direct message can only be pinned');
  assert.deepEqual(actions('member',{kind:'group',created_by:'me'}),['pin','invite','leave'],'a group is never renamed or archived here');
  assert.deepEqual(actions('member',{kind:'group',created_by:'other'}),['pin','leave']);
  assert.equal(menu('member')({kind:'group'})[1].label,'Leave group');
  assert.equal(menu('member')({kind:'channel',pinned:true})[0].label,'Unpin');
});
test('a direct message shows the other person, never its internal name',()=>{
  const env={hubChat:{membership:{clerk_user_id:'me'},members:[{clerk_user_id:'me',email:'self@example.test'},{clerk_user_id:'ana',email:'ana@example.test'}]},displayNameForEmail:e=>e.split('@')[0]};
  appFunction('hubPrivateConversation',env);const title=appFunction('hubChannelTitle',env);const label=appFunction('hubChannelLabel',env);
  assert.equal(title({kind:'dm',name:'dm:ana:me',member_ids:['me','ana']}),'ana');
  assert.equal(title({kind:'dm',name:'dm:gone:me',member_ids:['me','gone']}),'Former teammate');
  assert.equal(label({kind:'dm',name:'dm:ana:me',member_ids:['me','ana']}),'ana');
  assert.equal(label({name:'general'}),'# general','channels from an older Hub have no kind');
  env.hubChat.members.push({clerk_user_id:'bo',email:'bo@example.test'});
  assert.equal(label({kind:'group',name:'Group',member_ids:['me','ana','bo']}),'ana, bo','an unnamed group shows its members');
  assert.equal(label({kind:'group',name:'Launch',member_ids:['me','ana','bo']}),'Launch');
});
test('losing the open channel moves you to a channel you can still use',async()=>{
  const opened=[];let mainRefreshed=0;
  const env={activeWorkspaceKey:'hub_x',hubPath:()=>'/t',Promise,
    hubCall:(m,p)=>Promise.resolve(p==='/t/channels'?{channels:[{id:'group',kind:'group'},{id:'dm',kind:'dm'},{id:'general',kind:'channel'}]}:p==='/t/channel-invites'?{invites:[{channel_id:'x'}]}:{members:[]}),hubPrivateConversation:c=>c.kind==='dm'||c.kind==='group',
    hubChat:{channels:[],members:[]},chatWs:{activeRoomId:'archived',activeKind:'group',rooms:{}},hubRoom:c=>c,
    hubChannel:id=>env.hubChat.channels.filter(c=>c.id===id)[0]||null,openHubChannel:c=>opened.push(c.id),refreshChatMain:()=>mainRefreshed++,renderChatSidebar(){}};
  await appFunction('refreshHubChannels',env)();
  assert.deepEqual(opened,['general']);assert.equal(env.chatWs.activeRoomId,null);
  assert.deepEqual(env.hubChat.invites,[{channel_id:'x'}],'pending invitations load with the channel list');
  env.chatWs.activeRoomId='general';opened.length=0;
  await env.refreshHubChannels();assert.deepEqual(opened,[],'an open channel that still exists stays open');
  env.chatWs.activeRoomId='agent-setup';env.chatWs.activeKind='agent-setup';
  await env.refreshHubChannels();assert.deepEqual(opened,[],'the local New Bot setup chat stays open');
  assert.equal(env.chatWs.activeRoomId,'agent-setup');
});
test('the Admin Center New bot request opens setup once, for this team and a live channel',async()=>{
  const team='a'.repeat(32),channel='b'.repeat(32),store={};
  const env={NEW_TEAM_BOT_KEY:'miaNewTeamBot',sessionStorage:{getItem:k=>store[k]??null,removeItem:k=>{delete store[k];}},JSON,Number,
    hubChannelTitle:c=>'# '+c.name};
  const take=appFunction('takeNewTeamBotRequest',env);
  const channels=[{id:channel,name:'ux-test',kind:'channel'},{id:'c'.repeat(32),name:'dm:x',kind:'dm'}];
  const put=(req)=>{store.miaNewTeamBot=JSON.stringify(req);};
  put({teamId:team,channelId:channel,at:1000});
  assert.deepEqual({...take('hub_'+team,channels,2000)},{teamId:team,channelId:channel,label:'# ux-test'});
  assert.equal(take('hub_'+team,channels,2000),null,'the request is read only once');
  put({teamId:team,channelId:channel,at:1000});assert.equal(take('hub_'+'d'.repeat(32),channels,2000),null,'another team ignores it');
  put({teamId:team,channelId:channel,at:1000});assert.equal(take('hub_'+team,channels,1000+11*60*1000),null,'a stale request is dropped');
  put({teamId:team,channelId:'c'.repeat(32),at:1000});assert.equal(take('hub_'+team,channels,2000),null,'a direct message cannot get a team bot');
});
test('team sidebar splits pinned, channels and direct messages and offers Browse',()=>{
  const body=source.slice(source.indexOf('  function renderHubSidebar(){'),source.indexOf('  function hubActionError('));
  assert.match(body,/filter\(function\(channel\)\{return !!channel\.pinned;\}\)/);
  assert.match(body,/section\('channels','Channels','Add a channel',openHubChannelAddMenu\)/);
  assert.match(body,/section\('dms','Direct messages','New direct message',openHubDirectMessagePicker\)/);
  assert.doesNotMatch(body,/New shared channel/,'creating a channel moved to the Channels +');
  assert.match(body,/addEventListener\('contextmenu'/);
  const add=source.slice(source.indexOf('  function openHubChannelAddMenu('),source.indexOf('  function hubInviteRow('));
  assert.match(add,/\[\['New channel',openNewChannelFlow\],\['Browse channels',openHubBrowseChannels\]\]/,'the Channels + offers New channel and Browse channels');
});
test('team sidebar sections fold and remember it',()=>{
  const body=source.slice(source.indexOf('  function renderHubSidebar(){'),source.indexOf('  function hubInviteRow('));
  assert.match(body,/hubSidebarSections\[key\]=!expanded;/);
  assert.match(body,/localStorage\.setItem\('miaHubSidebarSections'/);
  assert.match(body,/' is-collapsed'/);
});
test('the workspace rail lists Solo first, then each team by its initials, then +',()=>{
  const start=source.indexOf('  function workspaceCode(');
  const code=new Function(source.slice(start,source.indexOf('  function renderWorkspaceSwitcher(')) + 'return workspaceCode;')();
  assert.equal(code('Mia AWS live test'),'MA');
  assert.equal(code('Multiplayer Test'),'MT');
  assert.equal(code('# ventas'),'VE');
  assert.equal(code(''),'MI');
  const html=require('fs').readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  const rail=html.slice(html.indexOf('<nav class="workspace-rail"'),html.indexOf('</nav>',html.indexOf('<nav class="workspace-rail"')));
  assert.ok(rail.indexOf('data-workspace-key="solo"')<rail.indexOf('workspace-rail-sep'),'Solo comes first, above the line');
  assert.ok(rail.indexOf('data-workspace-key="multiplayer_test"')<rail.indexOf('id="workspaceRailAdd"'),'+ comes last');
  assert.doesNotMatch(html,/data-mia-mark="18"/,'the workspace is not shown with the Mia mark');
  const teams=source.slice(source.indexOf('  function renderHubTeamOptions('),source.indexOf('  renderHubTeamOptions(cachedHubTeams());'));
  assert.match(teams,/esc\(workspaceCode\(team\.name\)\)/);
  assert.match(teams,/rail\.insertBefore\(button,add\)/,'teams go above +');
  assert.match(teams,/if\(key!==activeWorkspaceKey\) switchWorkspace\(key\)/,'clicking the current team does not reload the window');
  assert.match(source,/add\.addEventListener\('click', function\(\)\{ openSettingsDrawer\('teams'\); \}\)/);
});test('archive asks first and never deletes',()=>{
  const body=source.slice(source.indexOf('  function runHubChannelAction('),source.indexOf('  function openHubListDialog('));
  assert.match(body,/appConfirm\('Archive '/);assert.match(body,/'\/archive'/);assert.doesNotMatch(body,/'DELETE',base\)/);
});
test('the People panel lists the channel members, falling back to the team on an older Hub',()=>{
  assert.match(source,/hubCall\('GET',hubPath\(\)\+'\/channels\/'\+roomId\+'\/members'\)\.catch\(function\(error\)\{\n\s+if\(error && error\.status===404\)return hubCall\('GET',hubPath\(\)\+'\/members'\);throw error;/);
});
test('invitations show in the sidebar with Join and Decline',()=>{
  const body=source.slice(source.indexOf('  function hubInviteRow('),source.indexOf('  function hubActionError('));
  assert.match(body,/hubCall\('POST',base\+'\/join'\)/);assert.match(body,/hubCall\('DELETE',base\+'\/invites\/me'\)/);
  assert.match(source,/\(hubChat\.invites\|\|\[\]\)\.forEach\(function\(invite\)\{all\.appendChild\(hubInviteRow\(invite\)\);\}\);/);
});
test('inviting people sends a channel invitation, not a team invitation',()=>{
  const body=source.slice(source.indexOf('  function openHubInvitePeople('),source.indexOf('  function openHubDirectMessagePicker('));
  assert.match(body,/hubCall\('POST',hubPath\(\)\+'\/channels\/'\+channel\.id\+'\/invites',\{member:member\.clerk_user_id\}\)/);
  assert.match(body,/present\.indexOf\(member\.clerk_user_id\)<0/);
});
test('invitation and channel-list events refresh the sidebar',async()=>{
  let refreshed=0;
  const env={hubChat:{membership:{clerk_user_id:'me'},channels:[]},chatWs:{byRoom:{}},hubChannel:()=>null,
    refreshHubChannels:()=>{refreshed++;return Promise.resolve();},renderChatSidebar(){},renderChatThread(){}};
  const apply=appFunction('applyHubEvents',env);
  apply([{kind:'channel_invite'}]);apply([{kind:'channels_changed'}]);apply([{kind:'typing'}]);
  assert.equal(refreshed,2);
});
test('creating a team channel shows progress and explains who is in it',async()=>{
  const nodes={'#channelNameInput':{value:'launch'},'#channelNameCreate':{disabled:false,textContent:'Create channel'}};
  let finish;const toasts=[];
  const env={el:s=>nodes[s],channelNameCompose:{busy:false},hubPath:()=>'/t',window:{MiaHubChat:{id:()=>'x'}},
    hubCall:()=>new Promise((resolve,reject)=>{finish=reject;}),refreshHubChannels(){},closeChannelNameFlow(){},openHubChannel(){},hubChannel(){},
    hubActionError:(e,f)=>e.code==='channel_name_taken'?'Another channel already has that name.':f,showBenchToast:t=>toasts.push(t)};
  appFunction('createHubChannel',env)();
  assert.equal(nodes['#channelNameCreate'].disabled,true);assert.equal(nodes['#channelNameCreate'].textContent,'Creating…');
  finish({code:'channel_name_taken'});await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(toasts,['Another channel already has that name.']);
  assert.equal(nodes['#channelNameCreate'].disabled,false);assert.equal(nodes['#channelNameCreate'].textContent,'Create channel');
  const body=source.slice(source.indexOf('  function openNewChannelFlow('),source.indexOf('  (function(){\n    var overlay = el(\'#channelNameOverlay\')'));
  assert.match(body,/You\\'re its first member\./);
});
test('the invite dialog names the channel without a stray space',()=>{
  const body=source.slice(source.indexOf('  function openHubInvitePeople('),source.indexOf('  function openHubDirectMessagePicker('));
  assert.match(body,/'Invite people to '\+\(hubPrivateConversation\(channel\) \? hubChannelTitle\(channel\) : '#'\+channel\.name\)/);
});
test('a team channel can be created private',async()=>{
  for(const checked of [true,false]){
    const nodes={'#channelNameInput':{value:'launch'},'#channelNameCreate':{},'#channelPrivateInput':{checked}};const sent=[];
    const env={el:s=>nodes[s],channelNameCompose:{busy:false},hubPath:()=>'/t',window:{MiaHubChat:{id:()=>'x'}},
      hubCall:(m,p,b)=>{sent.push([m,p,b]);return new Promise(()=>{});},hubActionError:(e,f)=>f,showBenchToast(){}};
    appFunction('createHubChannel',env)();
    assert.equal(JSON.stringify(sent),JSON.stringify([['POST','/t/channels',{id:'x',name:'launch',visibility:checked?'private':'open'}]]));
  }
  assert.match(source,/if\(privateRow\) privateRow\.hidden = !team;/);
});
test('a group starts once two teammates are picked and adds them all at once',async()=>{
  let dialog;const sent=[];const opened=[];
  const env={hubChat:{membership:{clerk_user_id:'me'}},hubPath:()=>'/t',window:{MiaHubChat:{id:()=>'g'}},displayNameForEmail:e=>e.split('@')[0],
    openHubListDialog:o=>{dialog=o;},
    hubCall:(m,p,b)=>{sent.push([m,p,b]);return Promise.resolve(m==='GET'?{members:[{clerk_user_id:'me',email:'me@x'},{clerk_user_id:'a',email:'ana@x'},{clerk_user_id:'b',email:'bo@x'}]}:{channel:{id:'g'}});},
    refreshHubChannels:()=>Promise.resolve(),hubChannel:id=>({id}),openHubChannel:c=>opened.push(c.id)};
  appFunction('openHubGroupPicker',env)();
  let rows=await dialog.load();
  assert.equal(rows.map(r=>r.label).join(),'ana,bo');
  assert.equal(dialog.primary().disabled,true);assert.equal(dialog.primary().label,'Pick at least 2 people');
  rows[0].run();rows=await dialog.load();rows[1].run();rows=await dialog.load();
  assert.equal(rows.map(r=>r.actionLabel).join(),'Remove,Remove');
  assert.equal(dialog.primary().disabled,false);assert.equal(dialog.primary().label,'Start group (3 people)');
  assert.equal(await dialog.primary().run(),'close');
  assert.equal(JSON.stringify(sent.filter(s=>s[0]==='POST')),JSON.stringify([['POST','/t/groups',{id:'g',member_ids:['a','b']}]]));
  assert.equal(opened.join(),'g');
  assert.match(source,/label:'New group…',run:function\(\)\{openHubGroupPicker\(\);return 'close';\}/);
});
test('renaming a channel uses a one-line box that submits on Enter',()=>{
  assert.match(source,/inputLabel:'Channel name',submitLabel:'Rename',singleLine:true\}/);
  const body=source.slice(source.indexOf('  function appPrompt('),source.indexOf('\n  }\n',source.indexOf('  function appPrompt(')));
  assert.match(body,/document\.createElement\(options\.singleLine \? 'input' : 'textarea'\)/);
  assert.match(body,/options\.singleLine && event\.key === 'Enter'/);
});
test('a group picker says when the team is too small for a group',async()=>{
  let dialog;
  const env={hubChat:{membership:{clerk_user_id:'me'}},hubPath:()=>'/t',window:{MiaHubChat:{id:()=>'g'}},displayNameForEmail:e=>e,openHubListDialog:o=>{dialog=o;},
    hubCall:()=>Promise.resolve({members:[{clerk_user_id:'me',email:'me@x'},{clerk_user_id:'a',email:'ana@x'}]})};
  appFunction('openHubGroupPicker',env)();
  await dialog.load();
  assert.equal(dialog.primary().label,'Needs 2+ teammates');assert.equal(dialog.primary().disabled,true);
  assert.match(source,/renderPrimary\(\); filter\.focus\(\); load\(\);/);
});
// Adding an existing bot and creating a new one share one path: an admin's
// bot is published at once, anyone else's waits for an admin.
test('adding a bot to a channel publishes it only when you are an admin',async()=>{
  const run=async role=>{const calls=[];
    const env={hubChat:{membership:{role}},hubPath:()=>'/v1/teams/t',
      window:{MiaHubChat:{localCall:(m,p,b)=>{calls.push([m,p,b]);return Promise.resolve({bot:{id:'bot1'},proposal:{version:2}});}}},
      hubCall:(m,p)=>{calls.push([m,p]);return Promise.resolve({});}};
    const published=await appFunction('shareBotToHubChannel',env)('t','chan','local7','fork');
    return {published,calls};};
  const admin=await run('admin');
  assert.equal(admin.published,true);
  assert.deepEqual(JSON.parse(JSON.stringify(admin.calls)),[['POST','/share',{teamId:'t',channelId:'chan',localBotId:'local7',mode:'fork'}],
    ['POST','/v1/teams/t/channels/chan/bots/bot1/versions/2/approve']]);
  const member=await run('member');
  assert.equal(member.published,false);assert.equal(member.calls.length,1);
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','app.js'),'utf8');
  assert.equal((source.match(/localCall\('POST', ?'\/share'/g)||[]).length,1,'only shareBotToHubChannel shares a bot');
  for(const caller of ['function addCreatedBotToTeam(','function confirmMentionAdd(']){
    const start=source.indexOf(caller);assert.match(source.slice(start,start+2500),/shareBotToHubChannel\(/);
  }
});
test('Hub and shared-bot errors use one message table, with status fallbacks',async()=>{
  const reply=(status,body)=>async()=>({ok:false,status,json:async()=>body});
  const auth={miaDesktop:{auth:{getSessionToken:async()=>({token:1})}},MiaClerkDesktop:{unwrap:()=>'t'}};
  const fail=async(fetch,local)=>{const api=transport({...auth,fetch});try{await (local?api.localCall:api.call)('GET','/x');}catch(error){return error;}assert.fail('expected failure');};
  let error=await fail(reply(409,{error:'owner_must_transfer'}));
  assert.equal(error.code,'owner_must_transfer');assert.equal(error.status,409);assert.match(error.message,/owner first/);
  error=await fail(reply(401,{error:'hub_sign_in_required'}),true);assert.match(error.message,/Sign in to your Mia account/);
  error=await fail(reply(404,{error:'bot_not_found'}),true);assert.match(error.message,/no longer available on this computer/);
  error=await fail(reply(403,{}));assert.match(error.message,/no longer available to you/);
  error=await fail(reply(502,null));assert.match(error.message,/Can’t reach the shared team service/);
  error=await fail(async()=>{throw new TypeError('offline');});assert.equal(error.code,'hub_unavailable');
  error=await fail(reply(400,{error:'brand_new_code'}));assert.match(error.message,/\(brand_new_code\)/);
  const none=transport({});await assert.rejects(none.call('GET','/x'),{code:'sign_in_required'});
});
test('Settings and the Admin Center reuse the shared Hub call instead of their own tables',()=>{
  const teams=fs.readFileSync(path.join(__dirname,'../hub-teams.js'),'utf8'),admin=fs.readFileSync(path.join(__dirname,'../admin.js'),'utf8');
  assert.match(teams,/window\.MiaHubChat\.call/);assert.doesNotMatch(teams,/fetch\('\/api\/hub'/);
  assert.doesNotMatch(admin,/TEAM_ERRORS/);
});
test('a failed Solo send stays in the timeline and Retry resends it once with the same key',async()=>{
  const byRoom={},calls=[];let fail=true;
  const env={chatRoomState:id=>byRoom[id]||(byRoom[id]={messages:[]}),activeRoomTask:()=>null,nativeThinkingAgentName:()=>null,
    startChatThinking:()=>{},stopChatThinking:()=>{},renderChatSidebar:()=>{},renderChatThread:()=>{},renderComposerTaskControl:()=>{},
    chatSenderLabel:()=>'me',chatModelSelectionMetadata:()=>null,window:{},navigator:{onLine:true},chatWs:{activeRoomId:'room'},
    nativeConversationPath:(r,p)=>'/c/'+r+p,applyNativeEvent:e=>byRoom.room.messages.push({id:e.id,body:e.content.text}),
    setRoomNativeDispatches:()=>{},Math,Date,Object,
    api:async(url,opts)=>{calls.push(opts.body);if(fail)throw new TypeError('network');return {status:201,data:{event:{id:'ev1',content:{text:'hi'}}}};}};
  appFunction('deliverNativeMessage',env);appFunction('sendNativeConversationEvent',env);
  const first=await env.sendNativeConversationEvent('hi',null,null,'room');
  assert.equal(first.undelivered,true);
  const kept=byRoom.room.messages[0];
  assert.equal(byRoom.room.messages.length,1);assert.equal(kept.body,'hi');assert.equal(kept.sendFailed,true);assert.equal(kept.pending,false);
  assert.equal(kept.sendError,'Not delivered. Mia isn’t responding right now.');
  fail=false;await env.deliverNativeMessage('room',kept);
  assert.deepEqual(byRoom.room.messages.map(m=>m.id),['ev1']);
  assert.equal(calls.length,2);assert.equal(calls[0].clientIdempotencyKey,calls[1].clientIdempotencyKey);
});
test('Solo Retry, delete and composer hand-off cover undelivered messages',()=>{
  assert.match(source,/else if\(local\.soloSend\)deliverNativeMessage\(roomId,local\)/);
  assert.match(source,/if\(m\.sendFailed\) return true; \/\/ an undelivered copy exists only here/);
  assert.match(source,/result\.status === 201 \|\| result\.undelivered/);
});
