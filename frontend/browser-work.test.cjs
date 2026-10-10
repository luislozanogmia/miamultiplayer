'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleTabs, projection } = require('./browser-work.js');

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
  for(const id of ['browserWorkPanel','browserWorkError','browserGroupList','browserGroupName','browserMoveTabGroup','browserMoveTab','browserGroupEarlier','browserWorkList','browserWorkEmpty','browserWorkCandidates','browserGroupAdd','browserGroupNewName','browserGroupRename','browserGroupRemove','browserWorkAssignments','browserWorkCreate','browserWorkStart','localBrowserOverlay']) nodes[id]=new Element();
  global.document={getElementById:id=>nodes[id],createElement:tag=>new Element(tag),activeElement:null,querySelectorAll:()=>[]};
  global.MutationObserver=class {observe(){}};
  const originalSetInterval=global.setInterval; global.setInterval=()=>1;
  delete require.cache[require.resolve('./browser-work.js')]; const ui=require('./browser-work.js');
  const state={tabs:[{id:1}],activeId:1,groups:[{id:'g',name:'Work',tabIds:[1]}],selectedGroupId:'g'};
  let calls=[], refreshQueue=[], stopped=false, callback;
  const record={id:'work',groupId:'g',goal:'Read',status:'needs_approval',workers:[{id:'worker',actorId:'actor',tabId:1,status:'working'}],approvals:[{id:'approval',status:'pending',tabId:1,actorId:'actor'}],results:{worker:{text:'Partial'}}};
  ui.mount({browser:{onState:fn=>callback=fn,command:async()=>state},getBots:async()=>[],transport:{
    list:async()=>{ if(refreshQueue.length) return await refreshQueue.shift(); return [record]; },
    approval:async(id,approval,accept)=>{calls.push(['approval',id,approval.id,accept]);},
    cancel:async(id,workerId)=>{calls.push(['stop',id,workerId]);stopped=true;record.status='cancelled';}
  }});
  await flush(); await flush();
  const buttons=nodes.browserWorkList.querySelectorAll('button');
  buttons.find(b=>b.textContent==='Reject').listeners.click(); await flush();
  assert.deepEqual(calls[0],['approval','work','approval',false]);
  // A rejected API response alone cannot make the UI invent a rejected record.
  assert.ok(nodes.browserWorkList.querySelectorAll('button').some(b=>b.textContent==='Approve once'));
  nodes.browserWorkList.querySelectorAll('button').find(b=>b.textContent==='Stop bot').listeners.click(); await flush();
  assert.equal(stopped,true); assert.deepEqual(calls[1],['stop','work','worker']);
  assert.equal(nodes.browserWorkList.querySelectorAll('button').length,2); // only authoritative pending approval remains
  assert.equal(ui.projection(record,'g').results[0].text,'Partial');
  let resolveOld;
  refreshQueue.push(new Promise(resolve=>resolveOld=resolve)); const old=ui.refresh();
  callback({...state,selectedGroupId:'other',groups:[...state.groups,{id:'other',name:'Other',tabIds:[]}]}); await flush();
  resolveOld([record]); await old;
  assert.equal(nodes.browserWorkList.children.length,0, 'late old-group response cannot render in new group');
  global.setInterval=originalSetInterval; delete global.document; delete global.MutationObserver;
});
