'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {projection, workLabel, workerLabel, displayOrder} = require('./browser-work.js');

test('a task with a rejected action is partly done, never done', () => {
  const work={id:'w',groupId:'g',status:'done',workers:[{id:'a',status:'done',declinedActions:1},{id:'b',status:'done'}]};
  assert.equal(projection(work,'g').status,'Partly done');
  assert.equal(workerLabel(work.workers[0]),'Partly done · you rejected 1 action');
  assert.equal(workerLabel({status:'done',declinedActions:3}),'Partly done · you rejected 3 actions');
  assert.equal(workerLabel(work.workers[1]),'Done');
  assert.equal(workLabel({status:'done',workers:[{status:'done'}]}),'Done');
  assert.equal(workLabel({status:'working',workers:[{status:'done',declinedActions:1},{status:'working'}]}),'Working','a running task keeps its live state');
  for(const declinedActions of [0,-1,'2',null,{},NaN,1.5]) assert.equal(workerLabel({status:'done',declinedActions}),'Done',String(declinedActions));
});

test('work the person ended reads as stopped or tab closed; only a bot failure reads as failed', () => {
  assert.equal(workLabel({status:'cancelled',workers:[{status:'done'},{status:'cancelled',stopReason:'stopped'}]}),'Stopped');
  assert.equal(workLabel({status:'cancelled',workers:[{status:'done'},{status:'cancelled',stopReason:'tab_closed'}]}),'Tab closed');
  assert.equal(workLabel({status:'cancelled',workers:[{status:'cancelled',stopReason:'tab_closed'},{status:'cancelled',stopReason:'stopped'}]}),'Stopped');
  assert.equal(workLabel({status:'cancelled',workers:[]}),'Stopped');
  assert.equal(workLabel({status:'failed',workers:[{status:'failed'},{status:'cancelled',stopReason:'tab_closed'}]}),'Failed');
  assert.equal(workerLabel({status:'cancelled',stopReason:'tab_closed'}),'Tab closed');
  assert.equal(workerLabel({status:'cancelled',stopReason:'stopped'}),'Stopped');
  assert.equal(workerLabel({status:'failed',stopReason:'tab_closed'}),'Failed','a stop reason never relabels a failure');
  assert.equal(workerLabel({status:'mystery'}),'Unknown state');
});

test('tasks waiting for the person come first, then running work, then the newest', () => {
  const stored=[
    {id:'old-done',groupId:'g',status:'done',createdAt:1,workers:[]},
    {id:'running',groupId:'g',status:'working',createdAt:2,workers:[]},
    {id:'new-done',groupId:'g',status:'done',createdAt:3,workers:[]},
    {id:'asks',groupId:'g',status:'needs_approval',createdAt:0,workers:[],approvals:[{id:'p',status:'pending'}]},
    {id:'undated-a',groupId:'g',status:'failed',workers:[]},{id:'undated-b',groupId:'g',status:'failed',workers:[]},
  ];
  assert.deepEqual(displayOrder(stored.map(work=>projection(work,'g'))).map(work=>work.id),['asks','running','new-done','old-done','undated-b','undated-a']);
  assert.equal(stored[0].id,'old-done','ordering must not reorder durable records');
});

test('a new approval request is first in its card and scrolled into view once', t => {
  const chrome = ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',process.env.MIA_TEST_CHROME].find(file=>file&&fs.existsSync(file));
  if (!chrome) return t.skip('Chromium required for production DOM interaction');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mia-work-outcome-'));
  try {
    const source = fs.readFileSync(path.join(__dirname,'browser-work.js'),'utf8');
    const css = fs.readFileSync(path.join(__dirname,'browser-work.css'),'utf8');
    const ids = [...new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(m=>m[1]))];
    const nodes = ids.filter(id=>!['browserWorkList','browserWorkPanel','browserWorkGoal'].includes(id)).map(id=>`<div id="${id}"></div>`).join('');
    const script = `
      setInterval=()=>1;
      const state={tabs:[{id:1}],activeId:1,groups:[{id:'g',name:'Group',tabIds:[1]}],selectedGroupId:'g'};
      const older=Array.from({length:6},(_,i)=>({id:'old'+i,groupId:'g',goal:'Earlier task '+i,status:'done',createdAt:i+1,workers:[{id:'w',actorId:'a'+i,tabId:1,status:'done',goal:'Long earlier goal '.repeat(30)}],results:{}}));
      const asking={id:'asking',groupId:'g',goal:'Needs you',status:'working',createdAt:50,workers:[{id:'w',actorId:'actor',tabId:1,status:'working',goal:'Type into the page'}],approvals:[],results:{}};
      const works=[...older,asking];
      const panel=()=>document.querySelector('.browser-work-content');
      const inView=()=>{const card=document.querySelector('.browser-work-approval');if(!card)return null;const a=card.getBoundingClientRect(),b=panel().getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;};
      (async()=>{try{
        MiaBrowserWork.mount({browser:{onState:()=>{},command:async()=>state},transport:{list:async()=>works},getBots:async()=>[],getModels:async()=>[]});
        await Promise.resolve();await MiaBrowserWork.refresh();
        document.getElementById('browserWorkPanel').open=false;panel().scrollTop=panel().scrollHeight;
        asking.status='needs_approval';asking.workers[0].status='needs_approval';
        asking.approvals=[{id:'grant',status:'pending',tabId:1,actorId:'actor',description:'Type the search text',expiresAt:Date.now()+60000}];
        await MiaBrowserWork.refresh();
        const first=document.querySelector('.browser-work-card');
        const arrived={open:document.getElementById('browserWorkPanel').open,firstGoal:first.querySelector('strong').textContent,afterHeading:first.querySelector('.browser-work-heading').nextElementSibling.className,inView:inView()};
        panel().scrollTop=panel().scrollHeight;const away=panel().scrollTop;
        asking.workers[0].lastEvent={type:'status.update',at:1};await MiaBrowserWork.refresh();
        const later={scroll:panel().scrollTop,away};
        document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({arrived,later}))+'</pre>';
      }catch(e){document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({error:e.message}))+'</pre>';}})();`;
    const page = path.join(dir,'outcome.html');
    fs.writeFileSync(page,`<!doctype html><style>${css}</style>${nodes}<details id="browserWorkPanel" class="browser-work-panel" open><summary>Browser work</summary><div class="browser-work-content"><input id="browserWorkGoal"><div id="browserWorkList"></div></div></details><script>${source.replace(/<\/script/gi,'<\\/script')}</script><script>${script}</script>`);
    const output = execFileSync(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(dir,'profile'),'--virtual-time-budget=1000','--dump-dom',pathToFileURL(page).href],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
    const match = output.match(/<pre id="observation">([^<]+)<\/pre>/); assert.ok(match);
    const observed = JSON.parse(decodeURIComponent(match[1])); assert.equal(observed.error, undefined);
    assert.deepEqual(observed.arrived,{open:true,firstGoal:'Needs you',afterHeading:'browser-work-approval',inView:true});
    assert.ok(observed.later.away>0); assert.equal(observed.later.scroll,observed.later.away,'a later poll leaves the reading position alone');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
