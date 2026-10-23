const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../hub-bot-manager.js'),'utf8');
function moduleFor(call,document={}){const window={MiaHubChat:{call}};vm.runInNewContext(source,{window,document});return window.MiaHubBots;}
const request={id:'b'.repeat(32),version:1,status:'pending',canDecide:true,name:'Geek <Bot>',requester_email:'member@example.test'};
test('pending request offers admin Accept Reject Review with escaped names, members get no controls',()=>{
 const api=moduleFor();const html=api.admissionHtml(request,'Luis');
 assert.match(html,/Luis wants to bring Geek &lt;Bot&gt;/);for(const action of ['accept','reject','review'])assert.match(html,new RegExp('data-hub-admission-action="'+action+'"'));
 for(const props of [{canDecide:false},{status:'accepted'},{status:'rejected'}])assert.doesNotMatch(api.admissionHtml({...request,...props}),/data-hub-admission-action/);
});
test('accept and reject submit exact displayed version and refresh only after success',async()=>{
 for(const [action,route] of [['accept','approve'],['reject','reject']]){const calls=[];let refreshes=0;
  const api=moduleFor(async(...args)=>calls.push(args));await api.decide({teamId:'t',channelId:'c',refresh:async()=>refreshes++},request.id,3,action);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'POST');assert.equal(calls[0][1],'/v1/teams/t/channels/c/bots/'+request.id+'/versions/3/'+route);assert.equal(refreshes,1);
 }
});
test('failed decision reports inline error and leaves retry available',async()=>{
 const feedback={textContent:''},button={disabled:false,closest:()=>({querySelector:()=>feedback})};
 const api=moduleFor(async()=>{throw Error('Not allowed');});await api.decide({teamId:'t',channelId:'c',refresh:()=>assert.fail()},request.id,1,'accept',button);
 assert.equal(feedback.textContent,'Not allowed');assert.equal(button.disabled,false);
});
test('review reads exact proposal and mode without publishing anything',async()=>{
 class Node{constructor(tag){this.tag=tag;this.children=[];this.style={};}append(n){this.children.push(n);}showModal(){this.open=true;}}
 const doc={body:new Node('body'),createElement:tag=>new Node(tag)};const calls=[];
 const api=moduleFor(async(method,url)=>{calls.push([method,url]);return url.endsWith('/versions')?{versions:[{version:1,instructions:'Exact instructions'}]}:{bot:{name:'Geek'},mode:'linked'};},doc);
 await api.decide({teamId:'t',channelId:'c'},request.id,1,'review');assert.equal(calls.length,2);assert.ok(calls.every(c=>c[0]==='GET'));
 const dialog=doc.body.children[0];assert.equal(dialog.open,true);assert.ok(dialog.children.some(c=>c.textContent==='Exact instructions'));assert.ok(dialog.children.some(c=>c.textContent==='Version 1 · linked'));
});
