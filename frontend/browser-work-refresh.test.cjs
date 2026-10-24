'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

test('changed work refresh preserves reading position and only the same valid action focus', t => {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
  if (!chrome) return t.skip('Chromium is required for actual focus and scroll checks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-work-refresh-'));
  try {
    const source = fs.readFileSync(path.join(__dirname, 'browser-work.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'browser-work.css'), 'utf8');
    const ids = [...new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]))];
    const nodes = ids.filter(id => !['browserWorkList', 'browserWorkPanel', 'browserWorkGoal'].includes(id)).map(id => `<div id="${id}"></div>`).join('');
    const script = `
      setInterval=()=>1;
      const state={tabs:[{id:1}],activeId:1,groups:[{id:'g',name:'Group',tabIds:[1]}],selectedGroupId:'g'};
      const grant={id:'grant-one',status:'pending',tabId:1,actorId:'actor',expiresAt:Date.now()+60000};
      const work={id:'work',groupId:'g',goal:'Read fixture',status:'needs_approval',workers:[{id:'worker',actorId:'actor',tabId:1,status:'working'}],approvals:[grant],results:{worker:{text:'Long result line\\n'.repeat(200),verified:true}}};
      const other={id:'other-work',groupId:'g',goal:'Other task',status:'working',workers:[{id:'worker',actorId:'other-actor',tabId:1,status:'working'}],results:{}};
      const actions=[];
      const find=(text,card=0)=>Array.from(document.querySelectorAll('.browser-work-card')[card].querySelectorAll('button')).find(b=>b.textContent===text);
      (async()=>{try{
        MiaBrowserWork.mount({browser:{onState:()=>{},command:async()=>state},transport:{list:async()=>[work,other],approval:async(...args)=>actions.push(args)},getBots:async()=>[],getModels:async()=>[]});
        await Promise.resolve();await MiaBrowserWork.refresh();
        const panel=document.querySelector('.browser-work-content');
        let result=document.querySelector('.browser-work-result');result.open=true;
        panel.scrollTop=700;find('Reject').focus({preventScroll:true});
        const before={scroll:panel.scrollTop,height:panel.scrollHeight};const original=find('Reject');
        await MiaBrowserWork.refresh();const unchanged=original===find('Reject')&&document.activeElement===original;
        work.workers[0].status='waiting_for_user';await MiaBrowserWork.refresh();
        const changed={scroll:panel.scrollTop,height:panel.scrollHeight,open:document.querySelector('.browser-work-result').open,focus:document.activeElement===find('Reject')};
        document.querySelector('.browser-work-result summary').focus({preventScroll:true});work.workers[0].status='working';await MiaBrowserWork.refresh();
        const summaryFocused=document.activeElement===document.querySelector('.browser-work-result summary');
        find('Reject').focus({preventScroll:true});
        // Removing one grant must never focus another grant with the same label.
        work.approvals=[{...grant,id:'grant-two'}];await MiaBrowserWork.refresh();
        const replacementFocused=document.activeElement===find('Reject');
        find('Approve once').focus({preventScroll:true});work.approvals[0].expiresAt=Date.now()-1;await MiaBrowserWork.refresh();
        const expired={disabled:find('Approve once').disabled,focused:document.activeElement===find('Approve once')};
        // The shell can retain activeElement while a native page has focus.
        work.approvals[0].expiresAt=Date.now()+60000;await MiaBrowserWork.refresh();find('Reject').focus({preventScroll:true});const hasFocus=document.hasFocus;document.hasFocus=()=>false;
        work.workers[0].status='queued';await MiaBrowserWork.refresh();
        const inactiveShellFocused=document.activeElement===find('Reject');document.hasFocus=hasFocus;
        const goal=document.getElementById('browserWorkGoal');goal.value='Human input';goal.focus({preventScroll:true});goal.setSelectionRange(3,3);
        work.workers[0].status='working';await MiaBrowserWork.refresh();
        const human={focused:document.activeElement===goal,value:goal.value,start:goal.selectionStart,end:goal.selectionEnd};
        find('Stop this task',1).focus({preventScroll:true});other.status='done';await MiaBrowserWork.refresh();
        const missingFocused=document.activeElement!==goal&&document.activeElement.tagName==='BUTTON';
        document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({before,unchanged,changed,summaryFocused,inactiveShellFocused,replacementFocused,expired,human,missingFocused,actions}))+'</pre>';
      }catch(e){document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({error:e.message}))+'</pre>';}})();`;
    const page = path.join(dir, 'refresh.html');
    fs.writeFileSync(page, `<!doctype html><style>${css}</style>${nodes}<div id="browserWorkPanel"><div class="browser-work-content"><input id="browserWorkGoal"><div id="browserWorkList"></div></div></div><script>${source.replace(/<\/script/gi, '<\\/script')}</script><script>${script}</script>`);
    const output = execFileSync(chrome, ['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(dir,'profile'),'--virtual-time-budget=1000','--dump-dom',pathToFileURL(page).href], {encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
    const match = output.match(/<pre id="observation">([^<]+)<\/pre>/); assert.ok(match);
    const observed = JSON.parse(decodeURIComponent(match[1])); assert.equal(observed.error, undefined);
    assert.equal(observed.before.scroll,700);
    assert.equal(observed.unchanged,true,'unchanged polls keep the same focused DOM node');
    assert.equal(observed.changed.open,true,'changed status must not collapse a result');
    assert.equal(observed.changed.scroll,observed.before.scroll,'refresh must preserve reading position');
    assert.equal(observed.changed.focus,true,'same grant and action retain focus');
    assert.equal(observed.summaryFocused,true);
    assert.equal(observed.inactiveShellFocused,false,'an unfocused shell cannot regain native-page focus');
    assert.equal(observed.replacementFocused,false,'a new grant cannot inherit old grant focus');
    assert.deepEqual(observed.expired,{disabled:true,focused:false});
    assert.deepEqual(observed.human,{focused:true,value:'Human input',start:3,end:3});
    assert.equal(observed.missingFocused,false,'a removed task action cannot redirect focus');
    assert.deepEqual(observed.actions,[],'restoring focus never executes an approval');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
