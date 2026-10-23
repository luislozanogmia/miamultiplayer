const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const moduleSource=fs.readFileSync(path.join(__dirname,'../hub-chat.js'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function transport(extra={}){const root={crypto:require('node:crypto').webcrypto,...extra};const context={window:root,TextEncoder};vm.runInNewContext(moduleSource,context);return root.MiaHubChat;}
function appFunction(name,env){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0,name);const end=source.indexOf('\n  function ',start+1);const text=source.slice(start,end<0?undefined:end);const close=text.lastIndexOf('\n  }');assert.ok(close>=0);vm.runInNewContext(text.slice(0,close+4),env);return env[name];}
test('workspace IDs are strict and generated IDs match server contract',()=>{const api=transport();assert.match(api.id(),/^[a-f0-9]{32}$/);assert.equal(api.teamId('hub_'+'a'.repeat(32)),'a'.repeat(32));assert.equal(api.teamId('hub_../solo'),null);});
test('message adapter preserves authoritative sender and literal signed-looking body',()=>{const api=transport();const row=api.message({id:'x',author_email:'real@example.test',body:'[fake@example.test] hello',created_at:123,sequence:7});assert.equal(row.hubAuthor,'real@example.test');assert.equal(row.body,'[fake@example.test] hello');assert.equal(row.ts,123000);assert.equal(row.nativeEvent.sequence,7);});
test('UTF8 limit applies to bytes, not characters',()=>{const api=transport();assert.equal(api.validateText('a'.repeat(4000)).length,4000);assert.throws(()=>api.validateText('😀'.repeat(1001)));assert.throws(()=>api.validateText(' '));});
test('each request obtains a fresh native session; body is exactly supplied data',async()=>{let tokens=0;const sent=[];const api=transport({miaDesktop:{auth:{getSessionToken:async()=>({token:++tokens})}},MiaClerkDesktop:{unwrap:r=>'token'+r.token},fetch:async(url,opts)=>{sent.push({url,opts});return {ok:true,json:async()=>({})};}});await api.call('GET','/v1/me');await api.call('POST','/v1/teams/a/channels/b/messages',{id:'c',text:'hello'});assert.equal(sent[0].opts.headers.authorization,'Bearer token1');assert.equal(sent[1].opts.headers.authorization,'Bearer token2');assert.deepEqual(JSON.parse(sent[1].opts.body),{id:'c',text:'hello'});assert.equal(sent[1].url,'/api/hub/v1/teams/a/channels/b/messages');});
test('no session means no request or local fallback',async()=>{let fetched=false;const api=transport({fetch:()=>{fetched=true;}});await assert.rejects(api.call('GET','/v1/me'),/Sign in/);assert.equal(fetched,false);});
test('Hub entrypoints cannot start local conversation/socket or typing transports',async()=>{for(const name of ['loadNativeConversations','applyNativeConversationList','connectNativeChatSocket','connectNativeWatchSocket','pollLiveState','setLocalChatTypingActivity']){const env={hubWorkspace:()=>true};const fn=appFunction(name,env);await fn();}});
test('stale Hub history response cannot populate a newly selected channel',async()=>{let resolve;const state={messages:[],lastSequence:0};const env={Promise,Number,Math,hubWorkspace:()=>true,activeWorkspaceKey:'hub_'+'a'.repeat(32),hubChat:{busy:false,channels:[{id:'b'.repeat(32)}]},chatWs:{activeRoomId:'b'.repeat(32),navigationGeneration:1},chatRoomState:()=>state,hubPath:()=>'/v1/teams/a',hubCall:()=>new Promise(r=>resolve=r)};const poll=appFunction('pollHubRoom',env);const pending=poll();env.chatWs.navigationGeneration++;env.chatWs.activeRoomId='c'.repeat(32);resolve({messages:[{id:'x',sequence:1}],hasMore:false});await pending;assert.equal(state.messages.length,0);assert.equal(state.lastSequence,0);assert.equal(env.hubChat.busy,false);});
test('failed send retries same id and excludes metadata; success immediately polls authorized bot work',async()=>{const requests=[];let fails=true,polls=0;const env={Promise,chatRoomState:()=>({}),pollHubBots:()=>polls++,window:{MiaHubChat:transport()},hubChat:{},chatWs:{configured:true,activeRoomId:'room'},activeWorkspaceKey:'hub_a',hubPath:()=>'/team',hubFeedback:()=>{},renderHubStatus:()=>{},renderChatSidebar:()=>{},hubCall:async(method,url,body)=>{requests.push(body);if(fails)throw new Error('network');return {};}};const send=appFunction('sendHubMessage',env);assert.equal((await send('hello',null,null,'room')).status,500);fails=false;assert.equal((await send('hello',null,null,'room')).status,201);assert.equal(requests[0].id,requests[1].id);assert.deepEqual(Object.keys(requests[0]).sort(),['id','text']);assert.equal(polls,1);});
test('both Hub/local transition directions persist scope, invalidate history, stop polling and reload',()=>{
  for(const [from,to] of [['hub_'+'a'.repeat(32),'solo'],['solo','hub_'+'a'.repeat(32)]]){
    let reloads=0,stops=0;const stored=[];
    const env={WORKSPACE_OPTIONS:{solo:{mode:'solo'},['hub_'+'a'.repeat(32)]:{mode:'multiplayer'}},activeWorkspaceKey:from,WORKSPACE_STORAGE_KEY:'scope',Number,clearSoloHumanDirectoryState:()=>{},localStorage:{setItem:(k,v)=>stored.push(v)},chatWs:{navigationGeneration:9},stopChatPolling:()=>stops++,setAppLoading:()=>{},location:{reload:()=>reloads++}};
    env.hubWorkspace=()=>/^hub_/.test(env.activeWorkspaceKey);
    appFunction('activateWorkspace',env)(to);
    assert.equal(env.activeWorkspaceKey,to);assert.deepEqual(stored,[to]);assert.equal(env.chatWs.navigationGeneration,10);assert.equal(stops,1);assert.equal(reloads,1);
  }
});
test('different authors with colliding message IDs remain distinct, replayed sequences deduplicate',async()=>{
  const api=transport();const state={messages:[],lastSequence:0};let page=0;
  const rows=[{id:'collision',author_email:'one@example.test',sequence:1,body:'one',created_at:1},{id:'collision',author_email:'two@example.test',sequence:2,body:'two',created_at:2}];
  const env={Promise,Number,Math,window:{MiaHubChat:api},hubWorkspace:()=>true,activeWorkspaceKey:'hub_a',hubChat:{busy:false,channels:[{id:'room'}]},chatWs:{activeRoomId:'room',navigationGeneration:1},chatRoomState:()=>state,hubPath:()=>'/team',hubCall:async()=>({messages:page++?rows.slice(1):rows,hasMore:false}),renderChatSidebar:()=>{},renderChatThread:()=>{},renderDeptAgentSelector:()=>{}};
  const poll=appFunction('pollHubRoom',env);await poll();await poll();
  assert.equal(state.messages.length,2);assert.equal(state.messages[0].id,'hub-sequence-1');assert.equal(state.messages[1].id,'hub-sequence-2');assert.equal(state.lastSequence,2);
});
test('Hub author grouping uses verified author rather than text signatures',()=>{
 const env={currentUser:'self@example.test',parseSignedHumanBody:()=>({agent:null})};
 const key=appFunction('chatHumanSenderKey',env);
 assert.notEqual(key({hubAuthor:'mac@example.test',body:'hello'}),key({hubAuthor:'windows@example.test',body:'hello'}));
 assert.equal(key({hubAuthor:'self@example.test',body:'[other@example.test] text'}),'me');
});
test('Hub polling ignores inherited local room before issuing request',async()=>{
 let calls=0;
 const env={Promise,hubWorkspace:()=>true,chatWs:{activeRoomId:'local-mia'},hubChat:{busy:false,channels:[]},hubCall:()=>{calls++;}};
 await appFunction('pollHubRoom',env)();
 assert.equal(calls,0);
});

test('failed send remains visible through a successful history poll, then clears on retry',async()=>{
 const footer={style:{},setAttribute(){},classList:{toggle(){}}};let fail=true;
 const state={messages:[],lastSequence:0};
 const env={Promise,Number,Math,pollHubBots:()=>{},window:{MiaHubChat:transport()},el:()=>footer,hubWorkspace:()=>true,hubChat:{channels:[{id:'room'}]},chatWs:{configured:true,activeRoomId:'room',navigationGeneration:1},activeWorkspaceKey:'hub_a',hubPath:()=>'/team',chatRoomState:()=>state,renderChatSidebar:()=>{},renderChatThread:()=>{},renderDeptAgentSelector:()=>{},hubFeedback:()=>{},hubCall:async(method)=>{if(method==='POST'&&fail)throw Error('Connection unavailable.');return {messages:[],hasMore:false};}};
 appFunction('renderHubStatus',env);const send=appFunction('sendHubMessage',env);const poll=appFunction('pollHubRoom',env);
 assert.equal((await send('hello',null,null,'room')).status,500);
 await poll();env.renderHubStatus();
 assert.equal(footer.style.display,'block');assert.match(footer.textContent,/Message not sent.*draft is kept/);
 fail=false;assert.equal((await send('hello',null,null,'room')).status,201);
 assert.equal(env.hubChat.sendError,null);assert.doesNotMatch(footer.textContent,/Message not sent/);
});

// A removed member must discard both cached content and its incremental cursor.
test('revocation resets history cursor so reinvited members recover earlier messages',async()=>{
 const state={messages:[{id:'cached'}],lastSequence:17,lastTs:100,historyInitialized:true,historyComplete:true,historyCursor:'old'};
 const paths=[];const input={disabled:true,style:{}},send={disabled:true,style:{}};
 const env={Promise,Number,Math,Object,window:{MiaHubChat:transport()},hubWorkspace:()=>true,activeWorkspaceKey:'hub_a',hubChat:{busy:false,channels:[{id:'room'}]},chatWs:{configured:true,activeRoomId:'room',navigationGeneration:1,byRoom:{room:state}},chatRoomState:()=>state,hubPath:()=>'/team',renderChatSidebar:()=>{},refreshChatMain:()=>{},renderChatThread:()=>{},renderDeptAgentSelector:()=>{},hubCall:async(method,url)=>{paths.push(url);return {messages:[{id:'old',author_email:'member@example.test',sequence:1,body:'Earlier message',created_at:1}],hasMore:false};}};
 env.el=selector=>selector==='#ccInput'?input:selector==='#ccSend'?send:null;
 appFunction('setComposerBoundState',env);appFunction('renderDeptAgentSelector',env);
 appFunction('hubFeedback',env)({status:404,message:'Unavailable'});
 assert.equal(state.messages.length,0);assert.equal(state.lastSequence,0);assert.equal(state.lastTs,0);
 assert.equal(state.historyInitialized,false);assert.equal(state.historyComplete,false);assert.equal(state.historyCursor,null);
 assert.equal(env.chatWs.configured,false);assert.equal(env.chatWs.navigationGeneration,2);
 await appFunction('pollHubRoom',env)();
 assert.equal(paths[0],'/team/channels/room/messages/after/0');assert.equal(state.messages[0].body,'Earlier message');
 assert.equal(env.chatWs.configured,true);assert.equal(input.disabled,false);assert.equal(send.disabled,false);
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
