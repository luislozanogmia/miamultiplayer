const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
// The sidebar box includes the workspace rail, but --sand-sidebar-width covers
// only the list, so a drag must start from the list width or it jumps.
test('dragging the sidebar edge moves it by the pointer distance, not by the rail width too',()=>{
  const start=app.indexOf("    var MIN_W = 180, MAX_W = 480, KEY = 'styledSidebarW:v3';");
  const end=app.indexOf('  })();',start);
  assert.ok(start>0&&end>start);
  const listeners={},props={},stored={};
  const handle={parentElement:{getBoundingClientRect:()=>({width:376})},addEventListener(type,fn){listeners[type]=fn;}};
  const rail={getBoundingClientRect:()=>({width:76})};
  const doc={documentElement:{style:{setProperty(k,v){props[k]=v;}}},body:{classList:{add(){},remove(){}}},addEventListener(type,fn){listeners['doc:'+type]=fn;},removeEventListener(){}};
  const context={document:doc,localStorage:{getItem:k=>stored[k]||null,setItem(k,v){stored[k]=v;}},
    els:()=>[handle],el:selector=>selector==='#workspaceSwitcherMenu'?rail:null,Math,parseInt,String};
  vm.createContext(context);
  vm.runInContext(app.slice(start,end),context);
  listeners.pointerdown({pointerType:'mouse',button:0,clientX:500,preventDefault(){}});
  listeners['doc:pointermove']({clientX:540});
  assert.equal(props['--sand-sidebar-width'],'340px');
  listeners['doc:pointerup']();
  assert.equal(stored['styledSidebarW:v3'],'340');
});
