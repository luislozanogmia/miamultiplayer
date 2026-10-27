'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('workspace reload lifecycle logging survives a disconnected launcher console',()=>{
 const source=fs.readFileSync(path.join(__dirname,'main.cjs'),'utf8');
 const end=source.indexOf('  // Opt-in diagnostics');
 const start=source.lastIndexOf('  window.webContents.on("did-finish-load",',end);
 assert.ok(start>0 && end>start);
 const callbacks={},logs=[];
 const brokenPipe=()=>{throw Object.assign(new Error('broken pipe'),{code:'EPIPE'});};
 const window={webContents:{on:(name,fn)=>callbacks[name]=fn,getURL:()=> 'http://localhost:4871/reset?code=fixture-code'}};
 vm.runInNewContext(source.slice(start,end),{window,console:{log:brokenPipe,error:brokenPipe},desktopLog:message=>logs.push(message)});
 assert.doesNotThrow(()=>callbacks['did-finish-load']());
 assert.doesNotThrow(()=>callbacks['did-fail-load']({},-3,'fixture-description','http://localhost:4871/reset?code=fixture-code'));
 assert.equal(logs.length,2);
 assert.equal(logs[0],'main window loaded');
 assert.equal(logs[1],'main window load failed -3');
 assert.doesNotMatch(logs.join(' '),/fixture-code|fixture-description|reset/);
});
