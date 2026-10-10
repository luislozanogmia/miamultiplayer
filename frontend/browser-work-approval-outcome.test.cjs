'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {projection} = require('./browser-work.js');

test('only marked predispatch approval failures produce bounded static notices', () => {
  const marked={id:'safe',status:'revoked',failurePhase:'approval',tabId:2,actorId:'actor',denialCode:'STALE_SNAPSHOT',decidedAt:5};
  const work={id:'w',groupId:'g',approvals:[marked],operations:[]};
  assert.deepEqual(projection(work,'g').approvalFailures,[{id:'safe',tabId:2,category:'Page target is stale.'}]);
  for(const status of ['pending','consumed','accepted','expired','rejected']){
    assert.deepEqual(projection({...work,approvals:[{...marked,status}]},'g').approvalFailures,[],status);
  }
  assert.deepEqual(projection({...work,approvals:[{...marked,failurePhase:undefined}]},'g').approvalFailures,[],'generic Stop/revoke is not approval failure proof');
  for(const status of ['dispatching','done','uncertain','failed']){
    assert.deepEqual(projection({...work,operations:[{approvalId:'safe',status}]},'g').approvalFailures,[],status);
  }
  for(const denialCode of ['PRIVATE_URL_AND_RAW_ERROR','__proto__',undefined]){
    assert.deepEqual(projection({...work,approvals:[{...marked,denialCode,message:'PRIVATE'}]},'g').approvalFailures,[{id:'safe',tabId:2,category:''}]);
  }
  const many=Array.from({length:8},(_,i)=>({...marked,id:String(i),decidedAt:i}));
  assert.deepEqual(projection({...work,approvals:many},'g').approvalFailures.map(a=>a.id),['7','6','5']);
  assert.equal(many[0].id,'0','projection must not reorder durable records');
});

test('failed approval refreshes authoritative state and keeps its error through successful polls', t => {
  const chrome = ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
  if (!chrome) return t.skip('Chromium required for production DOM interaction');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mia-approval-outcome-'));
  try {
    const source = fs.readFileSync(path.join(__dirname,'browser-work.js'),'utf8');
    const css = fs.readFileSync(path.join(__dirname,'browser-work.css'),'utf8');
    const ids = [...new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(m=>m[1]))];
    const nodes = ids.filter(id=>!['browserWorkList','browserWorkPanel','browserWorkGoal'].includes(id)).map(id=>`<div id="${id}"></div>`).join('');
    const script = `
      setInterval=()=>1;
      const state={tabs:[{id:1}],activeId:1,groups:[{id:'g',name:'Group',tabIds:[1]}],selectedGroupId:'g'};
      let grant={id:'grant',status:'pending',tabId:1,actorId:'actor',expiresAt:Date.now()+60000};
      let work={id:'work',groupId:'g',goal:'Read',status:'needs_approval',workers:[{id:'worker',actorId:'actor',tabId:1,status:'needs_approval'}],approvals:[grant],results:{worker:{text:'Long result line\\n'.repeat(200),verified:true}}};
      let lists=0,decisions=0;const alert=()=>document.getElementById('browserWorkError');
      const find=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);
      const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
      (async()=>{try{
        MiaBrowserWork.mount({browser:{onState:()=>{},command:async()=>state},getBots:async()=>[],getModels:async()=>[],transport:{
          list:async()=>{lists++;return JSON.parse(JSON.stringify([work]));},
          approval:async()=>{decisions++;grant.status='revoked';grant.failurePhase='approval';grant.denialCode='STALE_SNAPSHOT';work.workers[0].status='working';throw new Error('Approval target changed.');}
        }});
        await settle();await MiaBrowserWork.refresh();
        const goal=document.getElementById('browserWorkGoal');goal.value='Human draft';goal.focus();goal.setSelectionRange(4,4);
        document.querySelector('.browser-work-result').open=true;
        const viewport=document.querySelector('.browser-work-content');viewport.scrollTop=700;const scroll=viewport.scrollTop;
        const before=lists;find('Approve once').click();await settle();
        const notice=document.querySelector('.browser-work-approval-failure');
        const failure={refreshed:lists>before,error:alert().textContent,hidden:alert().hidden,actionable:!!find('Approve once'),open:document.querySelector('.browser-work-result').open,scroll:viewport.scrollTop,focus:document.activeElement===goal,caret:goal.selectionStart,notice:notice&&notice.textContent,noticeControls:notice&&notice.querySelectorAll('button').length};
        await MiaBrowserWork.refresh();await MiaBrowserWork.refresh();
        const polled={error:alert().textContent,hidden:alert().hidden};
        // A later successful decision clears the previous mutation error.
        grant={...grant,id:'fresh',status:'pending'};work.approvals=[grant];await MiaBrowserWork.refresh();
        // The transport is replaced by remounting, without changing the actual page focus.
        MiaBrowserWork.mount({browser:{onState:()=>{},command:async()=>state},getBots:async()=>[],getModels:async()=>[],transport:{list:async()=>JSON.parse(JSON.stringify([work])),approval:async()=>{decisions++;grant.status='rejected';}}});
        await settle();find('Reject').click();await settle();
        document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({failure,polled,scroll,decisions,cleared:alert().hidden}))+'</pre>';
      }catch(e){document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({error:e.message}))+'</pre>';}})();`;
    const page=path.join(dir,'approval.html');
    fs.writeFileSync(page,`<!doctype html><style>${css}</style>${nodes}<div id="browserWorkPanel"><div class="browser-work-content"><input id="browserWorkGoal"><div id="browserWorkList"></div></div></div><script>${source.replace(/<\/script/gi,'<\\/script')}</script><script>${script}</script>`);
    const output=execFileSync(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(dir,'profile'),'--virtual-time-budget=1000','--dump-dom',pathToFileURL(page).href],{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
    const match=output.match(/<pre id="observation">([^<]+)<\/pre>/);assert.ok(match);
    const observed=JSON.parse(decodeURIComponent(match[1]));assert.equal(observed.error,undefined);
    assert.equal(observed.failure.refreshed,true,'failure must fetch the durable revoked record immediately');
    assert.equal(observed.failure.actionable,false,'a durable revoked grant cannot remain actionable');
    assert.equal(observed.failure.error,'Approval target changed.');assert.equal(observed.failure.hidden,false);
    assert.match(observed.failure.notice,/Approval failed/);assert.match(observed.failure.notice,/Page target is stale/);assert.equal(observed.failure.noticeControls,0);
    assert.deepEqual(observed.polled,{error:'Approval target changed.',hidden:false});
    assert.equal(observed.failure.open,true);assert.equal(observed.failure.scroll,observed.scroll);
    assert.equal(observed.failure.focus,true);assert.equal(observed.failure.caret,4);
    assert.equal(observed.decisions,2);assert.equal(observed.cleared,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
