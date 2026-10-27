const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function load(name,env){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0,name);const next=source.indexOf('\n  function ',start+1);const text=source.slice(start,next<0?undefined:next);vm.runInNewContext(text.slice(0,text.lastIndexOf('\n  }')+4),env);return env[name];}
test('saved native session resolves before sign-in UI is exposed',async()=>{
 let resolve,shown=0,finished=0;const loading=[];
 const env={Promise,AUTH_CONFIG:{},desktopClerkAuth:()=>({status:()=>new Promise(r=>resolve=r)}),window:{MiaClerkDesktop:{unwrap:r=>r}},setAppLoading:b=>loading.push(b),showResolvedClerkSignIn:()=>shown++,finishClerkLogin:async()=>{finished++;return true;}};
 Object.assign(env,{el:()=>({classList:{add(){},remove(){}},hidden:false}),setLoginEnabled(){},signalDesktopReady(){},location:{hash:''},nativeClerkViewDispose:null});
 env.window.MiaClerkDesktop.mount=()=>{shown++;env.desktopClerkAuth().status();return()=>{};};
 const pending=load('showClerkSignIn',env)();
 assert.equal(shown,0);resolve({status:'active'});await pending;
 assert.equal(finished,1);assert.equal(shown,0);assert.deepEqual(loading,[true]);
});
test('signed-out native session still shows actual login',async()=>{
 let shown=0;
 const env={Promise,AUTH_CONFIG:{},desktopClerkAuth:()=>({status:async()=>({status:'signed_out'})}),window:{MiaClerkDesktop:{unwrap:r=>r}},setAppLoading:()=>{},showResolvedClerkSignIn:()=>shown++,finishClerkLogin:()=>{throw Error('must not restore');}};
 await load('showClerkSignIn',env)();assert.equal(shown,1);
});
test('provider401 preserves valid Mia session; expired Mia session requires login',async()=>{
 for(const status of [200,401,503]){
  let hidden=0;const paths=[];
  const env={Promise,Object,JSON,String,Error,AbortSignal,authGeneration:0,activeWorkspaceKey:'solo',STYLED_SKIP_AUTH:false,currentUserLocalProfile:false,hideApp:()=>hidden++,fetch:async p=>{paths.push(p);return p==='/api/me'?{status}:{status:401,text:async()=>JSON.stringify({error:'provider_auth_required'})};}};
  await assert.rejects(load('api',env)('/api/provider/connect'),/unauthorized/);
  assert.equal(hidden,status===401?1:0);assert.deepEqual(paths,['/api/provider/connect','/api/me']);
 }
});
test('late rejection from an old session cannot hide a newly restored workspace',async()=>{
 let resolve,hidden=0;
 const env={Promise,Object,JSON,String,Error,AbortSignal,authGeneration:1,activeWorkspaceKey:'solo',STYLED_SKIP_AUTH:false,currentUserLocalProfile:false,hideApp:()=>hidden++,fetch:async(p,opts)=>{
  if(p==='/api/me'){assert.ok(opts.signal);return new Promise(r=>resolve=r);}
  return {status:401,text:async()=>JSON.stringify({error:'provider_auth_required'})};
 }};
 const pending=load('api',env)('/api/provider/connect');
 await new Promise(r=>setImmediate(r));env.authGeneration++;
 resolve({status:401});await assert.rejects(pending,/unauthorized/);assert.equal(hidden,0);
});
test('unavailable session check preserves workspace and surfaces the provider error',async()=>{
 let hidden=0;
 const env={Promise,Object,JSON,String,Error,AbortSignal,authGeneration:0,activeWorkspaceKey:'solo',STYLED_SKIP_AUTH:false,currentUserLocalProfile:false,hideApp:()=>hidden++,fetch:async p=>{
  if(p==='/api/me')throw Error('offline');return {status:401,text:async()=>JSON.stringify({error:'provider_auth_required'})};
 }};
 await assert.rejects(load('api',env)('/api/provider/connect'),/unauthorized/);assert.equal(hidden,0);
});
