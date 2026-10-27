"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL, isAuthSender, registerAuthProtocol, createDesktopAuth } = require("./clerk-desktop-ipc.cjs");
function fixture() {
  const frame = { url: "http://localhost:4871/" };
  const notifications = [];
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame, send: (...args) => notifications.push(args) } };
  const event = { sender: window.webContents, senderFrame: frame };
  return { window, event, frame, notifications };
}
test("native auth IPC accepts only main app frame and exact backend origin", () => {
  const { window, event, frame } = fixture();
  assert.equal(isAuthSender(event, window, "http://localhost:4871"), true);
  assert.equal(isAuthSender({ ...event, sender: {} }, window, "http://localhost:4871"), false);
  assert.equal(isAuthSender({ ...event, senderFrame: { ...frame } }, window, "http://localhost:4871"), false);
  for (const url of ["http://localhost:48710/", "https://evil.example/", "file:///offline.html", "garbage"]) {
    frame.url = url;
    assert.equal(isAuthSender(event, window, "http://localhost:4871"), false);
  }
});
test("packaged protocol registration is cross-platform and doesn't claim web schemes", () => {
  const calls = [];
  const app = { isPackaged: true, setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; } };
  for (const platform of ["darwin", "win32", "linux"]) assert.equal(registerAuthProtocol(app, platform), true);
  assert.deepEqual(calls, Array.from({length:3}, () => ["miamultiplayer"]));
  app.isPackaged = false;
  assert.equal(registerAuthProtocol(app, "darwin"), false);
  assert.equal(registerAuthProtocol(app, "linux"), false);
  assert.equal(registerAuthProtocol(app, "win32", "C:/Electron.exe", ["electron", "/project/main.cjs"]), true);
  assert.deepEqual(calls[3], ["miamultiplayer", "C:/Electron.exe", ["/project/main.cjs"]]);
});
test("actual registered IPC routes narrow actions, refuses web pages and redacts errors", async () => {
  const { window, event } = fixture(); let handler, calls = [];
  const client = {
    status: async () => ({status:"active",sessionId:"sess"}),
    getSessionToken: async () => "short-lived-jwt",
    cancel: async () => calls.push("cancel"),
    signOut: async () => ({status:"signed_out"}),
    startEmail: async email => { calls.push(email); return {status:"needs_verification"}; },
    verifyEmail: async () => { throw new Error("SECRET-TOKEN must not cross IPC"); },
  };
  createDesktopAuth({ipcMain:{ handle(channel, fn){ assert.equal(channel,CHANNEL); handler=fn; } }, getWindow:()=>window, getBackendUrl:()=>"http://localhost:4871", getClient:()=>client, openExternal:()=>{}, canOpenGoogle:()=>false});
  assert.equal((await handler({...event,sender:{}},"token")).ok,false);
  assert.equal((await handler(event,"fetch","https://evil.example")).ok,false);
  assert.equal((await handler(event,"google")).ok,false);
  assert.deepEqual(await handler(event,"token"),{ok:true,result:"short-lived-jwt"});
  assert.equal((await handler(event,"email","a@b.example")).result.status,"needs_verification");
  assert.deepEqual(calls,["cancel","a@b.example"]);
  assert.equal((await handler(event,"email",{})).ok,false);
  assert.equal((await handler(event,"verify","invalid")).ok,false);
  const error=await handler(event,"verify","123456");
  assert.equal(error.ok,false); assert.doesNotMatch(error.error,/SECRET/);
});

test("Linux fallback URL is recoverable only through the authorized local frame", async () => {
  const {window,event,notifications}=fixture();let handler,cancels=0;
  const client={startGoogle:async()=>({url:"https://accounts.google.com/o/oauth2/auth"}),cancel:async()=>{cancels++;},status:async()=>({status:"signed_out"}),startEmail:async()=>({status:"needs_verification"})};
  createDesktopAuth({ipcMain:{handle(_channel,fn){handler=fn;}},getWindow:()=>window,getBackendUrl:()=>"http://localhost:4871",getClient:()=>client,browserFallback:true,openExternal:async()=>{throw new Error("PRIVATE-OPENER-ERROR");}});
  const response=await handler(event,"google");
  assert.equal(response.ok,true);assert.equal(response.result.status,"error");
  assert.equal((await handler(event,"status")).result.authorizationUrl,response.result.authorizationUrl);
  assert.deepEqual(await handler({...event,senderFrame:{url:"https://evil.example/"}},"status"),{ok:false,error:"Not authorized."});
  assert.doesNotMatch(JSON.stringify(notifications),/PRIVATE-OPENER-ERROR/);
  assert.equal((await handler(event,"google")).result.status,"error");assert.equal(cancels,1);
  await handler(event,"email","a@b.example");
  assert.equal((await handler(event,"status")).result.status,"signed_out");
});

function concurrentFixture(){
 const f=fixture();let handler,release,statusCalls=0,tokenCalls=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const client={status:async()=>{if(++statusCalls===1)await pending;return {status:'active'};},getSessionToken:async()=>{tokenCalls++;return 'synthetic-token';}};
 createDesktopAuth({ipcMain:{handle(_channel,fn){handler=fn;}},getWindow:()=>f.window,getBackendUrl:()=>"http://localhost:4871",getClient:()=>client,openExternal:()=>{}});
 return {...f,handler,release,tokenCalls:()=>tokenCalls};
}
test('overlapping restoration, token and status reads wait instead of failing busy',async()=>{
 const f=concurrentFixture();const status=f.handler(f.event,'status');const token=f.handler(f.event,'token');const another=f.handler(f.event,'status');
 assert.equal(f.tokenCalls(),0);f.release();
 const results=await Promise.all([status,token,another]);assert.ok(results.every(r=>r.ok));assert.equal(results[1].result,'synthetic-token');assert.equal(f.tokenCalls(),1);
});
test('queued and in-flight reads recheck renderer authorization before exposing results',async()=>{
 const f=concurrentFixture();const status=f.handler(f.event,'status');const token=f.handler(f.event,'token');
 f.frame.url='https://untrusted.example';f.release();
 for(const r of await Promise.all([status,token]))assert.deepEqual(r,{ok:false,error:'Not authorized.'});
 assert.equal(f.tokenCalls(),0);
});
test('read waiting is bounded and interactive actions are never queued or replayed',async()=>{
 const f=concurrentFixture();const active=f.handler(f.event,'status');const queued=Array.from({length:8},()=>f.handler(f.event,'token'));
 assert.equal((await f.handler(f.event,'token')).ok,false);assert.equal((await f.handler(f.event,'signOut')).ok,false);
 f.release();await active;assert.ok((await Promise.all(queued)).every(r=>r.ok));assert.equal(f.tokenCalls(),8);
});

test('auth failure returns its safe response even when launcher diagnostics have a broken pipe',async()=>{
 const {window,event}=fixture();let handler;
 const previous=console.warn;
 console.warn=()=>{throw Object.assign(new Error('broken pipe'),{code:'EPIPE'});};
 try {
  createDesktopAuth({ipcMain:{handle(_channel,fn){handler=fn;}},getWindow:()=>window,getBackendUrl:()=> 'http://localhost:4871',getClient:()=>({status:async()=>{throw new Error('PRIVATE-AUTH-DETAIL');}}),openExternal:()=>{}});
  const result=await handler(event,'status');
  assert.equal(result.ok,false);
  assert.doesNotMatch(result.error,/PRIVATE|broken pipe/);
 } finally {console.warn=previous;}
});
