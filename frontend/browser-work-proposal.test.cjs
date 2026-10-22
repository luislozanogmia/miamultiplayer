'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposalBot } = require('./browser-work.js');

test('a suggested bot resolves by id or one exact name and is never guessed', () => {
  const bots = [{ id: 'bot_1', name: 'Scout' }, { id: 'bot_2', name: 'Analyst' }, { id: 'bot_3', name: 'analyst' }];
  assert.equal(proposalBot(bots, 'bot_2').id, 'bot_2');
  assert.equal(proposalBot(bots, ' scout ').id, 'bot_1');
  assert.equal(proposalBot(bots, 'Analyst'), null, 'two bots share this name');
  assert.equal(proposalBot(bots, 'Scou'), null);
  assert.equal(proposalBot(bots, ''), null);
  assert.equal(proposalBot(null, 'Scout'), null);
});

test('a suggestion or form message survives successful polls; a poll clears only its own failure', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {execFileSync} = require('node:child_process'), {pathToFileURL} = require('node:url');
  const chrome = ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
  if (!chrome) return t.skip('Chromium required for production DOM interaction');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mia-proposal-message-'));
  try {
    const source = fs.readFileSync(path.join(__dirname,'browser-work.js'),'utf8');
    const ids = [...new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(m=>m[1]))];
    const nodes = ids.filter(id=>!['browserWorkList','browserWorkPanel','browserWorkGoal','browserWorkCreate'].includes(id)).map(id=>`<div id="${id}"></div>`).join('');
    const script = `
      setInterval=()=>1;
      const state={tabs:[{id:1,title:'One'},{id:2,title:'Two'}],activeId:1,groups:[{id:'g',name:'Group',tabIds:[1,2]}],selectedGroupId:'g',
        workProposal:{id:'p',groupId:'g',goal:'Compare',assignments:[{tabId:1,bot:'Scout'},{tabId:2,bot:'Ghostwriter'}]}};
      let fail=false;const alert=()=>document.getElementById('browserWorkError');
      const find=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);
      const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
      (async()=>{try{
        MiaBrowserWork.mount({browser:{onState:()=>{},command:async()=>state},getBots:async()=>[{id:'bot_1',name:'Scout',model:'m',provider:'p'}],
          getModels:async()=>[{id:'p',label:'P',models:['m']}],transport:{list:async()=>{if(fail)throw new Error('Offline.');return [];},plan:async()=>{}}});
        await settle();find('Review suggestion').click();await settle();
        const rows=Array.from(document.querySelectorAll('.browser-work-candidate')).map(r=>r.getAttribute('data-tab-id')+':'+r.querySelector('select').value);
        const applied=alert().textContent;
        await MiaBrowserWork.refresh();await MiaBrowserWork.refresh();
        const polled={text:alert().textContent,hidden:alert().hidden};
        document.getElementById('browserWorkCreate').dispatchEvent(new Event('submit',{cancelable:true}));await settle();
        const form=alert().textContent;await MiaBrowserWork.refresh();const formPolled=alert().textContent;
        fail=true;await MiaBrowserWork.refresh();const offline=alert().textContent;
        fail=false;await MiaBrowserWork.refresh();const recovered=alert().hidden;
        find('Review suggestion').click();await settle();const again=alert().textContent;find('Dismiss').click();await settle();
        document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({rows,applied,polled,form,formPolled,offline,recovered,again,dismissed:alert().hidden,goal:document.getElementById('browserWorkGoal').value}))+'</pre>';
      }catch(e){document.body.innerHTML='<pre id="observation">'+encodeURIComponent(JSON.stringify({error:e.message}))+'</pre>';}})();`;
    const page = path.join(dir,'proposal.html');
    fs.writeFileSync(page,`<!doctype html>${nodes}<div id="browserWorkPanel"><div class="browser-work-content"><form id="browserWorkCreate"><input id="browserWorkGoal"></form><div id="browserWorkList"></div></div></div><script>${source.replace(/<\/script/gi,'<\\/script')}</script><script>${script}</script>`);
    const output = execFileSync(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(dir,'profile'),'--virtual-time-budget=1000','--dump-dom',pathToFileURL(page).href],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
    const match = output.match(/<pre id="observation">([^<]+)<\/pre>/); assert.ok(match);
    const observed = JSON.parse(decodeURIComponent(match[1])); assert.equal(observed.error, undefined);
    assert.deepEqual(observed.rows, ['1:bot_1','2:'], 'the known bot is selected; the unknown one is left for the person');
    assert.equal(observed.goal, 'Compare');
    assert.match(observed.applied, /Ghostwriter, which is not available/);
    assert.deepEqual(observed.polled, {text: observed.applied, hidden: false}, 'successful polls keep the suggestion message');
    assert.match(observed.form, /Choose a connected model for your personal Mia agent/);
    assert.equal(observed.formPolled, observed.form, 'successful polls keep the form message');
    assert.equal(observed.offline, 'Offline.');
    assert.equal(observed.recovered, true, 'a recovered poll clears its own failure');
    assert.match(observed.again, /Ghostwriter/);
    assert.equal(observed.dismissed, true, 'dismissing the suggestion clears its message');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
