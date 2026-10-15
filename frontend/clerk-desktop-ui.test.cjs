const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount, unwrap } = require('./clerk-desktop-ui.js');
function harness(authOverrides = {}) {
  const elements = new Map();
  function element(){ return { hidden:false, disabled:false, value:'', textContent:'', handlers:{}, addEventListener(name,fn){this.handlers[name]=fn;}, focus(){this.focused=true;},select(){this.selected=true;} }; }
  const form = element();
  form.querySelector = selector => { if(!elements.has(selector)) elements.set(selector,element()); return elements.get(selector); };
  const copied=[];const clipboard={writeText:async value=>{copied.push(value);}};
  const container = { ownerDocument:{createElement:()=>form,defaultView:{navigator:{clipboard}}}, replaceChildren(value){this.child=value;} };
  let listener, signedIn=0, cancelled=0;
  const auth = {status:async()=>({ok:true,result:{status:'signed_out'}}),onState:fn=>{listener=fn;return()=>{listener=null;};},cancel:async()=>{cancelled++;return {ok:true,result:{status:'signed_out'}};},...authOverrides};
  const dispose = mount(container,auth,()=>{signedIn++;});
  return {form,elements,dispose,auth,copied,clipboard,notify:state=>listener(state),get signedIn(){return signedIn;},get cancelled(){return cancelled;}};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
test('Google waits for native completion and cancellation returns to sign-in', async()=>{
  const h=harness({startGoogle:async()=>({ok:true,result:{status:'waiting',expiresAt:Date.now()+60000}})});
  await settle(); h.elements.get('.native-clerk-google').handlers.click(); await settle();
  assert.equal(h.elements.get('.native-clerk-google').disabled,true);
  assert.equal(h.elements.get('.native-clerk-cancel').hidden,false);
  assert.match(h.elements.get('.native-clerk-status').textContent,/browser/);
  assert.equal(h.signedIn,0);
  h.elements.get('.native-clerk-cancel').handlers.click();await settle();
  assert.equal(h.cancelled,1); assert.equal(h.elements.get('.native-clerk-google').disabled,false);
  h.notify({status:'active'});assert.equal(h.signedIn,1);h.dispose();
});
test('email code submits through native API and failure remains readable',async()=>{
  const calls=[];
  const h=harness({startEmail:async email=>{calls.push(email);return {ok:true,result:{status:'needs_verification'}};},verifyEmail:async code=>{calls.push(code);return {ok:false,error:'The code was not accepted.'};}});
  await settle();h.elements.get('#nativeClerkEmail').value='a@b.example';
  h.form.handlers.submit({preventDefault(){}});await settle();
  assert.equal(h.elements.get('.native-clerk-code').hidden,false);
  h.elements.get('#nativeClerkCode').value='123456';h.form.handlers.submit({preventDefault(){}});await settle();
  assert.deepEqual(calls,['a@b.example','123456']);
  assert.equal(h.elements.get('.native-clerk-status').textContent,'The code was not accepted.');
  assert.equal(h.signedIn,0);h.dispose();
});
test('native auth is wired before Clerk browser assets, and restarts refresh the session',()=>{
  const source=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
  const signIn=source.slice(source.indexOf('function showClerkSignIn()'),source.indexOf('function setAppLoading'));
  assert.ok(signIn.indexOf('window.MiaClerkDesktop.mount')<signIn.indexOf('ensureClerkLoaded()'));
  assert.match(source,/if\(AUTH_CONFIG && desktopClerkAuth\(\)\) return showClerkSignIn\(\)/);
  assert.match(source,/nativeAuth\.getSessionToken\(\)\.then\(window.MiaClerkDesktop.unwrap\)/);
  assert.match(fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),/src="clerk-desktop-ui.js"/);
  assert.throws(()=>unwrap({ok:false,error:'Safe message'}),/Safe message/);
});

test('Linux manual link supports copying, Google retry and email without a waiting lock',async()=>{
  let attempts=0,emails=0;
  const url='https://accounts.google.com/o/oauth2/auth';
  const h=harness({startGoogle:async()=>{attempts++;return {ok:true,result:{status:'waiting',authorizationUrl:url,expiresAt:Date.now()+60000}};},startEmail:async()=>{emails++;return {ok:true,result:{status:'needs_verification'}};}});
  await settle(); h.elements.get('.native-clerk-google').handlers.click(); await settle();
  assert.equal(h.elements.get('.native-clerk-browser-link').hidden,false);
  assert.equal(h.elements.get('.native-clerk-google').disabled,false);
  assert.equal(h.elements.get('.native-clerk-submit').disabled,false);
  assert.equal(h.elements.get('#nativeClerkEmail').disabled,false);
  await h.elements.get('.native-clerk-copy').handlers.click();
  assert.deepEqual(h.copied,[url]);
  h.elements.get('.native-clerk-google').handlers.click();await settle();assert.equal(attempts,2);
  h.elements.get('#nativeClerkEmail').value='a@b.example';h.form.handlers.submit({preventDefault(){}});await settle();
  assert.equal(emails,1);assert.equal(h.elements.get('#nativeClerkLink').value,'');h.dispose();
});

test('opener error keeps fallback visible and a failed new attempt clears the obsolete link',async()=>{
  let attempt=0;
  const h=harness({startGoogle:async()=>++attempt===1?{ok:true,result:{status:'error',error:'Your browser could not be opened. Use email instead.',authorizationUrl:'https://accounts.google.com/o/oauth2/auth',expiresAt:Date.now()+60000}}:{ok:false,error:'Network unavailable.'}});
  await settle();h.elements.get('.native-clerk-google').handlers.click();await settle();
  assert.match(h.elements.get('.native-clerk-status').textContent,/email/);
  assert.equal(h.elements.get('.native-clerk-cancel').hidden,false);
  assert.equal(h.elements.get('.native-clerk-browser-link').hidden,false);
  h.elements.get('.native-clerk-google').handlers.click();await settle();
  assert.equal(h.elements.get('#nativeClerkLink').value,'');
  assert.equal(h.elements.get('.native-clerk-browser-link').hidden,true);h.dispose();
});

test('clipboard failure leaves a selectable URL and cancellation erases it',async()=>{
  const h=harness();await settle();
  h.notify({status:'waiting',authorizationUrl:'https://accounts.google.com/o/oauth2/auth',expiresAt:Date.now()+60000});
  h.clipboard.writeText=async()=>{throw new Error('Clipboard permission denied');};
  await h.elements.get('.native-clerk-copy').handlers.click();
  assert.equal(h.elements.get('#nativeClerkLink').selected,true);
  assert.match(h.elements.get('.native-clerk-status').textContent,/Select and copy/);
  h.notify({status:'expired'});
  assert.equal(h.elements.get('#nativeClerkLink').value,'');
  assert.equal(h.elements.get('.native-clerk-browser-link').hidden,true);h.dispose();
});
