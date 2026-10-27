const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const paint=fs.readFileSync(path.join(__dirname,'..','assets','workspace-rail-paint.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function node(tag){
  return {tag,attrs:{},children:[],textContent:'',className:'',
    classList:{set:new Set(),toggle(name,on){on?this.set.add(name):this.set.delete(name);}},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return k in this.attrs?this.attrs[k]:null;},
    appendChild(child){this.children.push(child);return child;}};
}
function run(storage){
  const add=node('button'); add.setAttribute('data-workspace-key',null); delete add.attrs['data-workspace-key'];
  const solo=node('button'); solo.setAttribute('data-workspace-key','solo');
  const mt=node('button'); mt.setAttribute('data-workspace-key','multiplayer_test');
  const rail=node('nav'); rail.children=[solo,mt,add];
  rail.insertBefore=(child,before)=>{rail.children.splice(rail.children.indexOf(before),0,child);};
  rail.querySelectorAll=()=>rail.children.filter(child=>child.getAttribute('data-workspace-key'));
  const title=node('span'); title.textContent='Multiplayer Test';
  const ids={workspaceSwitcherMenu:rail,workspaceRailAdd:add,miaCompanyName:title};
  vm.runInNewContext(paint,{document:{getElementById:id=>ids[id]||null,createElement:node},localStorage:{getItem:k=>k in storage?storage[k]:null},JSON,Array,String});
  return {rail,title};
}
// A switch reloads the page; the first frame must already show the right
// rail and name, or the tiles visibly redraw.
test('the rail and title are painted from the saved teams before app.js runs',()=>{
  const id='0123456789abcdef0123456789abcdef';
  const {rail,title}=run({miaHubTeams:JSON.stringify([{teamId:id,name:'Mia AWS live test'},{teamId:'bad',name:'x'}]),miaosActiveWorkspace:'hub_'+id});
  assert.deepEqual(rail.children.map(c=>c.getAttribute('data-workspace-key')),['solo','multiplayer_test','hub_'+id,null],'teams go above +, invalid entries are skipped');
  const tile=rail.children[2];
  assert.equal(tile.className,'workspace-rail-tile');
  assert.equal(tile.children[0].textContent,'MA');
  assert.equal(tile.children[1].textContent,'Mia AWS live test');
  assert.ok(tile.classList.set.has('active'));
  assert.ok(!rail.children[0].classList.set.has('active'));
  assert.equal(title.textContent,'Mia AWS live test');
  assert.equal(run({}).title.textContent,'Solo','no saved workspace means Solo');
  assert.equal(run({miaosActiveWorkspace:'hub_'+'f'.repeat(32)}).title.textContent,'Shared team','as app.js names a team not yet in the list');
});
test('the painted tiles match the ones app.js renders',()=>{
  const teams=app.slice(app.indexOf('  function renderHubTeamOptions('),app.indexOf('  renderHubTeamOptions(cachedHubTeams());'));
  assert.match(teams,/button\.className='workspace-rail-tile';/);
  assert.match(teams,/'<span class="workspace-rail-mark" aria-hidden="true">'\+esc\(workspaceCode\(team\.name\)\)\+'<\/span><strong class="workspace-rail-name">'\+esc\(team\.name\)\+'<\/strong>'/);
  const start=app.indexOf('  function workspaceCode(');
  const appCode=vm.runInNewContext('('+app.slice(start+2,app.indexOf('\n  }\n',start)+4)+')',{String});
  const paintCode=vm.runInNewContext('('+paint.slice(paint.indexOf('function code('),paint.indexOf('\n    }\n',paint.indexOf('function code('))+6)+')',{String});
  for(const label of ['Mia AWS live test','# ventas','Ñandú','','Multiplayer Test'])assert.equal(paintCode(label),appCode(label),label);
  assert.ok(html.indexOf('assets/workspace-rail-paint.js')>html.indexOf('id="miaCompanyName"'),'runs after the rail and title exist');
  assert.ok(html.indexOf('assets/workspace-rail-paint.js')<html.indexOf('id="chatThread"'),'and before the rest of the page paints');
});
test('the selected tile has one frame, not a border plus a separate ring',()=>{
  const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
  const rule=css.match(/\.workspace-rail-tile\.active \.workspace-rail-mark\{([^}]*)\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[1],/box-shadow:(?!inset)[^;]*0 0 0 \d/,'an outer spread ring draws a second frame around the border');
});
test('the macOS window buttons sit centered over the workspace rail',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','..','macos','src','main.cjs'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
  const x=Number(main.match(/trafficLightPosition: \{ x: (\d+)/)[1]);
  const rail=Number(css.match(/--workspace-rail-width:(\d+)px/)[1]);
  // Three 14pt buttons, 20pt apart, span 54pt.
  assert.equal(x+54/2,rail/2);
});
