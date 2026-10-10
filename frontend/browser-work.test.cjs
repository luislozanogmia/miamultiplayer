'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectedConnectedModel, taskRecoveryState, configuredModelIndex, connectedModels, recoveryState, pageOrigin, visibleTabs, projection } = require('./browser-work.js');

test('connected inventory selects exact bot modelProvider and never substitutes an unavailable model', () => {
  const models = connectedModels([{id:'openai-codex',label:'ChatGPT',models:['gpt-6.1-sol','gpt-6-luna']},{id:'other',models:['gpt-6.1-sol']}]);
  assert.equal(configuredModelIndex(models,{model:'gpt-6.1-sol',modelProvider:'other'}),2);
  assert.equal(configuredModelIndex(models,{model:'unavailable',modelProvider:'openai-codex'}),-1);
  assert.equal(models[0].provider,'openai-codex');
  assert.deepEqual(connectedModels(null),[]);
});
test('personal model choice requires an explicit inventory index and never defaults to first model', () => {
  const models=connectedModels([{id:'api',models:['pro','flash']}]);
  assert.equal(selectedConnectedModel(models,''),null); assert.equal(selectedConnectedModel(models,'99'),null);
  assert.deepEqual(selectedConnectedModel(models,'1'),{provider:'api',model:'flash',label:'api · flash'});
});

test('recovery blocks uncertain writes including dependent workers and only offers interrupted work', () => {
  const work={status:'waiting_for_user',workers:[{id:'a',status:'waiting_for_user'},{id:'b',status:'failed'}],dependencies:{a:[],b:['a']},operations:[{workerId:'b',status:'uncertain'}]};
  assert.deepEqual(recoveryState(work,'a'),{held:true,eligible:false,workerIds:['a','b']});
  work.operations=[]; assert.equal(recoveryState(work,'a').eligible,true);
  work.status='working'; assert.equal(recoveryState(work,'a').eligible,false);
});

test('stopped streaming response is visible as incomplete/unverified and never a completed result', () => {
  const record={id:'w',groupId:'g',goal:'Compare both websites',context:{groupName:'Research'},status:'cancelled',workers:[{id:'a',botName:'Reader',goal:'Read Alpha',status:'cancelled'}],results:{a:{text:'Alpha appears to be 17; comparison unfinished.',verified:false,incomplete:true,status:'stopped',workEpoch:1,workerEpoch:2,browserEvidence:[],reasoning:'not visible'}}};
  const shown=projection(record,'g');
  assert.equal(shown.status,'Stopped'); assert.equal(shown.results.length,0);
  assert.equal(shown.preservedResponses.length,1);
  assert.deepEqual(shown.preservedResponses[0].tags,['Stopped','Incomplete','Unverified']);
  assert.equal(shown.preservedResponses[0].text,record.results.a.text);
  assert.equal(shown.preservedResponses[0].goal,'Read Alpha'); assert.equal(shown.preservedResponses[0].overallGoal,'Compare both websites');
  assert.equal(shown.preservedResponses[0].context,JSON.stringify(record.context));
  assert.equal('reasoning' in shown.preservedResponses[0],false); assert.equal('browserEvidence' in shown.preservedResponses[0],false);
  assert.equal(record.results.a.status,'stopped','projection does not rewrite durable state');
});
test('recovery keeps historical text distinct while new current completion retains its own verification', () => {
  const previous={text:'Unfinished earlier answer',status:'stopped',incomplete:true,verified:false,workEpoch:1,workerEpoch:1};
  const record={id:'w',groupId:'g',goal:'Compare',status:'working',workers:[{id:'a',goal:'Read Alpha',status:'working',previousAttempts:[previous]}],results:{}};
  let shown=projection(record,'g'); assert.equal(shown.results.length,0); assert.equal(shown.preservedResponses[0].historical,true);
  assert.deepEqual(shown.preservedResponses[0].tags,['Previous attempt','Stopped','Incomplete','Unverified for current attempt']);
  record.results.a={text:'Fresh result',verified:true,browserEvidence:[{operationId:'fresh'}]};
  shown=projection(record,'g'); assert.equal(shown.results[0].text,'Fresh result'); assert.equal(shown.preservedResponses[0].text,previous.text);
  assert.equal(shown.results[0].verified,true); assert.equal('verified' in shown.preservedResponses[0],false);
});
test('incomplete failure is not labelled stopped and empty partial text does not invent an answer', () => {
  const record={id:'w',groupId:'g',goal:'Read',status:'failed',workers:[{id:'a'}],results:{a:{text:'Partial visible text',incomplete:true,status:'incomplete',verified:false}}};
  assert.deepEqual(projection(record,'g').preservedResponses[0].tags,['Incomplete','Unverified']);
  record.results.a.text=' '; assert.deepEqual(projection(record,'g').preservedResponses,[]); assert.equal(projection(record,'g').results.length,0);
});

test('personal Mia partial synthesis and its history remain distinct from workers and completed synthesis', () => {
  const record={id:'w',groupId:'g',goal:'Combine findings',context:'Original overall context',status:'cancelled',workers:[],synthesis:{text:'The comparison is unfinished',incomplete:true,verified:false,status:'stopped',workEpoch:1,synthesisEpoch:2}};
  let shown=projection(record,'g'); assert.equal(shown.workers.length,0); assert.equal(shown.synthesis,null);
  assert.equal(shown.preservedResponses[0].name,'Mia · Personal agent'); assert.equal(shown.preservedResponses[0].personal,true);
  assert.deepEqual(shown.preservedResponses[0].tags,['Stopped','Incomplete','Unverified']);
  record.previousSynthesisAttempts=[{...record.synthesis,goal:'Combine findings',status:'historical',truncated:true}]; record.synthesis={text:'Fresh combined answer',status:'complete',incomplete:false};
  shown=projection(record,'g'); assert.equal(shown.synthesis.text,'Fresh combined answer'); assert.equal(shown.preservedResponses.length,1);
  assert.deepEqual(shown.preservedResponses[0].tags,['Previous attempt','Incomplete','Unverified for current attempt','Saved text truncated']);
  assert.equal(shown.preservedResponses[0].goal,'Combine findings'); assert.equal(shown.preservedResponses[0].text,'The comparison is unfinished');
});

test('stopped personal synthesis exposes safe task recovery even when every worker is done', () => {
  const work={id:'w',groupId:'g',goal:'Combine',status:'cancelled',workers:[{id:'a',status:'done'},{id:'b',status:'done'}],synthesis:{text:'Unfinished synthesis',status:'stopped',incomplete:true},operations:[{workerId:'a',status:'done'}]};
  let shown=projection(work,'g'); assert.deepEqual(taskRecoveryState(shown),{held:false,workerIds:['a','b'],eligible:true});
  assert.equal(recoveryState(shown,'a').eligible,false,'task recovery covers the completed-worker gap');
  work.status='waiting_for_user';assert.equal(taskRecoveryState(projection(work,'g')).eligible,true);
  work.operations.push({workerId:'b',status:'uncertain'});assert.equal(taskRecoveryState(projection(work,'g')).eligible,false);assert.equal(taskRecoveryState(work).held,true);
  work.operations=[];work.status='working';assert.equal(taskRecoveryState(work).eligible,false);
});

test('planning context removes URL paths, queries, fragments and unsupported schemes', () => {
  assert.equal(pageOrigin('https://example.test/private-path?q=private#private'), 'https://example.test');
  assert.equal(pageOrigin('file:///private/location'), '');
  assert.equal(pageOrigin('invalid'), '');
});

test('selected group shows only its ordered live tabs, including an empty group', () => {
  const state = { tabs: [{id:1}, {id:2}, {id:3}], groups: [{id:'research',tabIds:[3,2,99]}, {id:'empty',tabIds:[]}], selectedGroupId:'research' };
  assert.deepEqual(visibleTabs(state), [{id:3}, {id:2}]);
  state.selectedGroupId = 'empty'; assert.deepEqual(visibleTabs(state), []);
  assert.deepEqual(visibleTabs({tabs:state.tabs}), state.tabs);
});
test('projection never invents progress; uses stored results and personal synthesis', () => {
  const record = {id:'w', groupId:'g', goal:'Compare', status:'queued', workers:[{actorId:'a',status:'queued'}], results:{a:{text:'Evidence',model:'requested'}}, approvals:[{id:'1',status:'pending'},{id:'2',status:'rejected'}], synthesis:{text:'Combined'} };
  assert.equal(projection(record,'other'), null);
  const shown = projection(record,'g'); assert.equal(shown.status,'Queued'); assert.equal(shown.terminal,false);
  assert.equal(shown.results[0].text,'Evidence'); assert.deepEqual(shown.synthesis,{text:'Combined'}); assert.equal(shown.approvals.length,1);
  record.results.a.verified = false; assert.equal(projection(record, 'g').results[0].title, 'Unverified bot response · a');
  record.status = 'cancelled'; assert.equal(projection(record,'g').terminal,true); assert.equal(projection(record,'g').results[0].text,'Evidence');
  record.status = 'unknown'; assert.equal(projection(record,'g').status,'Unknown state');
});

// Behavioral DOM harness for actions and refresh races; this is mocked UI
// evidence, distinct from the required real Electron manual acceptance.
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.attributes={}; this.listeners={}; this.value=''; this.hidden=false; this.className=''; this.textContent=''; this.classList={toggle:()=>{}}; }
  append(...nodes) { this.children.push(...nodes); nodes.forEach(n => n.parent=this); }
  replaceChildren(...nodes) { this.children=[]; this.append(...nodes); }
  setAttribute(k,v) { this.attributes[k]=String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k,v) { this.listeners[k]=v; }
  querySelectorAll(selector) { const found=[]; for(const child of this.children){ if ((selector==='input'&&child.tag==='input') || (selector==='select'&&child.tag==='select') || (selector==='button'&&child.tag==='button') || (selector==='.browser-work-candidate'&&child.className===selector.slice(1))) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(c=>c!==this); }
}
const flush = () => new Promise(resolve=>setImmediate(resolve));
test('approval reject and Stop call matching IDs, wait for authoritative state, preserve partial results', async () => {
  const nodes={};
  for(const id of ['browserWorkPanel','browserWorkError','browserGroupList','browserGroupName','browserMoveTabGroup','browserMoveTab','browserGroupEarlier','browserWorkList','browserWorkEmpty','browserWorkCandidates','browserGroupAdd','browserGroupNewName','browserGroupRename','browserGroupRemove','browserWorkAssignments','browserWorkCreate','browserWorkStart','browserWorkGoal','localBrowserOverlay']) nodes[id]=new Element();
  global.document={getElementById:id=>nodes[id] || nodes.browserWorkCandidates.children.flatMap(row=>row.children).find(child=>child.id===id),createElement:tag=>new Element(tag),activeElement:null,querySelectorAll:selector=>nodes.browserWorkCandidates.querySelectorAll(selector)};
  global.MutationObserver=class {observe(){}};
  const originalSetInterval=global.setInterval; global.setInterval=()=>1;
  delete require.cache[require.resolve('./browser-work.js')]; const ui=require('./browser-work.js');
  const state={tabs:[{id:1}],activeId:1,groups:[{id:'g',name:'Work',tabIds:[1]}],selectedGroupId:'g'};
  let calls=[], refreshQueue=[], stopped=false, callback;
  const record={id:'work',groupId:'g',goal:'Read',status:'needs_approval',workers:[{id:'worker',actorId:'actor',tabId:1,status:'working'}],approvals:[{id:'approval',status:'pending',tabId:1,actorId:'actor'}],results:{worker:{text:'Partial'}}};
  const records=[record];
  ui.mount({browser:{onState:fn=>callback=fn,command:async()=>state},getBots:async()=>[{id:'bot',model:'chosen',modelProvider:'connected'}],getModels:async()=>[{id:'connected',models:['unrequested-pro','chosen']}],transport:{
    list:async()=>{ if(refreshQueue.length) return await refreshQueue.shift(); return records; },
    approval:async(id,approval,accept)=>{calls.push(['approval',id,approval.id,accept]);},
    cancel:async(id,workerId)=>{calls.push(['stop',id,workerId]);stopped=true;record.status='cancelled';},
    recover:async(id,ids)=>{calls.push(['recover',id,ids]);record.workers[0].previousAttempts=[record.results.worker];delete record.results.worker;record.status='queued';record.workers[0].status='queued';},
    exportReusable:async(id,workerId)=>{calls.push(['export',id,workerId]);record.reusable=[{id:'saved',workerId:'worker',proof:[{operationId:'step'}]}];},
    plan:async(payload)=>{calls.push(['plan',payload]);}
  }});
  await flush(); await flush();
  const buttons=nodes.browserWorkList.querySelectorAll('button');
  buttons.find(b=>b.textContent==='Reject').listeners.click(); await flush();
  assert.deepEqual(calls[0],['approval','work','approval',false]);
  // A rejected API response alone cannot make the UI invent a rejected record.
  assert.ok(nodes.browserWorkList.querySelectorAll('button').some(b=>b.textContent==='Approve once'));
  nodes.browserWorkList.querySelectorAll('button').find(b=>b.textContent==='Stop bot').listeners.click(); await flush();
  assert.equal(stopped,true); assert.deepEqual(calls[1],['stop','work','worker']);
  assert.equal(nodes.browserWorkList.querySelectorAll('button').length,3); // only authoritative pending approval remains
  assert.equal(ui.projection(record,'g').results[0].text,'Partial');
  await nodes.browserWorkAssignments.onclick();
  const candidate=nodes.browserWorkCandidates.children.find(row=>row.className==='browser-work-candidate'); const picks=candidate.querySelectorAll('select');
  picks[0].value='bot'; picks[0].listeners.change(); assert.equal(picks[1].value,'1'); assert.equal(candidate.querySelectorAll('input').length,0);
  record.results.worker={text:'Preserved streamed answer',verified:false,incomplete:true,status:'stopped'}; await ui.refresh();
  const allText=n=>[n.textContent,...n.children.flatMap(c=>allText(c))];
  let displayed=allText(nodes.browserWorkList); assert.ok(displayed.includes('Preserved streamed answer')); assert.ok(displayed.includes('Stopped')); assert.ok(displayed.includes('Incomplete')); assert.ok(displayed.includes('Unverified'));
  record.workers[0].status='cancelled';record.operations=[{workerId:'worker',status:'uncertain'}];
  await ui.refresh(); assert.equal(nodes.browserWorkList.querySelectorAll('button').some(b=>b.textContent==='Restart bot and dependents'),false);
  record.operations=[]; await ui.refresh();
  nodes.browserWorkList.querySelectorAll('button').find(b=>b.textContent==='Restart bot and dependents').listeners.click(); await flush();
  assert.deepEqual(calls.at(-1),['recover','work',['worker']]); displayed=allText(nodes.browserWorkList); assert.ok(displayed.includes('Preserved streamed answer')); assert.ok(displayed.includes('Previous attempt')); assert.ok(displayed.includes('Unverified for current attempt'));
  record.status='done'; record.workers[0].status='done'; record.operations=[{id:'step',workerId:'worker',status:'done'}]; await ui.refresh();
  nodes.browserWorkList.querySelectorAll('button').find(b=>b.textContent==='Save reusable steps').listeners.click(); await flush();
  assert.deepEqual(calls.at(-1),['export','work','worker']);
  await nodes.browserWorkList.querySelectorAll('button').find(b=>b.textContent==='Choose tab for saved steps').listeners.click();
  const reusePicks=nodes.browserWorkCandidates.children.find(row=>row.className==='browser-work-candidate').querySelectorAll('select'); reusePicks[0].value='bot'; reusePicks[0].listeners.change(); reusePicks[2].value=JSON.stringify({sourceWorkId:'work',reusableId:'saved'});
  nodes.browserWorkGoal.value='Run the saved steps';
  const callsBeforeMissingPersonal=calls.length; await nodes.browserWorkCreate.listeners.submit({preventDefault(){}}); assert.equal(calls.length,callsBeforeMissingPersonal); assert.equal(nodes.browserWorkError.textContent,'Choose a connected model for your personal Mia agent.');
  const personalModel=global.document.getElementById('browserWorkPersonalModel'); assert.equal(personalModel.value,''); personalModel.value='1'; personalModel.listeners.change();
  await nodes.browserWorkCreate.listeners.submit({preventDefault(){}});
  assert.equal(calls.at(-1)[0],'plan'); assert.deepEqual(calls.at(-1)[1].personalSelection,{model:'chosen',provider:'connected'}); assert.deepEqual(calls.at(-1)[1].candidates[0],{botId:'bot',tabId:1,model:'chosen',provider:'connected',reusable:{sourceWorkId:'work',reusableId:'saved'}});
  let resolveOld;
  refreshQueue.push(new Promise(resolve=>resolveOld=resolve)); const old=ui.refresh();
  callback({...state,selectedGroupId:'other',groups:[...state.groups,{id:'other',name:'Other',tabIds:[]}]}); await flush();
  resolveOld([record]); await old;
  assert.equal(nodes.browserWorkList.children.length,0, 'late old-group response cannot render in new group');
  global.setInterval=originalSetInterval; delete global.document; delete global.MutationObserver;
});
