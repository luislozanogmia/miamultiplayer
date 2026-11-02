import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {hubEndpoint,createHubClient,hubRouteLimits}=require('./hub-client.js');

test('fresh installations discover public production Hub without embedded credentials',()=>{
 const previous=process.env.MIA_HUB_URL;delete process.env.MIA_HUB_URL;
 try{
  assert.equal(hubEndpoint(), 'https://hub.miamultiplayer.com');
  assert.equal(hubEndpoint(mkdtempSync(join(tmpdir(),'mia-hub-client-'))), 'https://hub.miamultiplayer.com');
 }finally{if(previous===undefined)delete process.env.MIA_HUB_URL;else process.env.MIA_HUB_URL=previous;}
});
test('explicit development overrides remain bounded; credential-bearing or malformed endpoints fail closed',()=>{
 const previous=process.env.MIA_HUB_URL;
 try{
  process.env.MIA_HUB_URL='http://127.0.0.1:9876';assert.equal(hubEndpoint(),'http://127.0.0.1:9876');
  for(const url of ['https://person:password@example.test','http://example.test','https://example.test/private','https://example.test/?token=value']){
   process.env.MIA_HUB_URL=url;assert.throws(()=>hubEndpoint());
  }
  delete process.env.MIA_HUB_URL;const directory=mkdtempSync(join(tmpdir(),'mia-hub-config-'));
  writeFileSync(join(directory,'hub-connection.json'),'{');assert.throws(()=>hubEndpoint(directory),/Invalid Hub configuration/);
 }finally{if(previous===undefined)delete process.env.MIA_HUB_URL;else process.env.MIA_HUB_URL=previous;}
});
test('public endpoint does not authorize unsigned calls',async()=>{
 let forwarded=false;const proxy=createHubClient({fetcher:async()=>{forwarded=true;}});
 const response={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
 await proxy({url:'/v1/me',method:'GET',headers:{}},response);
 assert.equal(response.code,401);assert.equal(forwarded,false);
});
test('channel pin and rename methods reach the Hub; other methods stay blocked',async()=>{
 const previous=process.env.MIA_HUB_URL;process.env.MIA_HUB_URL='http://127.0.0.1:9876';
 const sent=[];const proxy=createHubClient({fetcher:async(url,options)=>{sent.push(options.method);
  return {status:200,body:[Buffer.from('{"ok":true}')]};}});
 const route='/v1/teams/'+'a'.repeat(32)+'/channels/'+'b'.repeat(32);
 try{
  for(const [method,path] of [['PUT',route+'/pin'],['PATCH',route],['OPTIONS',route],['HEAD',route]]){
   const response={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
   await proxy({url:path,method,headers:{authorization:'Bearer token'},body:{}},response);
   assert.equal(response.code,['PUT','PATCH'].includes(method)?200:404,method);
  }
  assert.deepEqual(sent,['PUT','PATCH']);
 }finally{if(previous===undefined)delete process.env.MIA_HUB_URL;else process.env.MIA_HUB_URL=previous;}
});

test('only image routes carry large bodies and only the team feed waits longer', () => {
  const { hubRouteLimits } = require('./hub-client');
  const team = 'a'.repeat(32), channel = 'b'.repeat(32), file = 'c'.repeat(32);
  assert.equal(hubRouteLimits('POST', `/v1/teams/${team}/channels/${channel}/files`).request, 12 * 1024 * 1024);
  assert.equal(hubRouteLimits('GET', `/v1/teams/${team}/channels/${channel}/files/${file}`).response, 12 * 1024 * 1024);
  assert.equal(hubRouteLimits('POST', `/v1/teams/${team}/channels/${channel}/messages`).request, 40000);
  assert.equal(hubRouteLimits('POST', `/v1/teams/${team}/channels`).request, 8192);
  assert.equal(hubRouteLimits('GET', `/v1/teams/${team}/channels/${channel}/messages/before/0`).response, 131072);
  assert.equal(hubRouteLimits('GET', `/v1/teams/${team}/events/after/12`).timeout, 30000);
  assert.equal(hubRouteLimits('GET', `/v1/teams/${team}/events/after/01`).timeout, 15000);
});

test('only the team audit log forwards a query string, with numeric paging only',async()=>{
 const previous=process.env.MIA_HUB_URL;process.env.MIA_HUB_URL='http://127.0.0.1:9876';
 const sent=[];const proxy=createHubClient({fetcher:async(url)=>{sent.push(url);return {status:200,body:[Buffer.from('{"events":[]}')]};}});
 const team='/v1/teams/'+'a'.repeat(32);
 try{
  const cases=[['GET',team+'/audit?limit=100',200],['GET',team+'/audit?before=42&limit=50',200],['GET',team+'/audit',200],
   ['GET',team+'/audit?limit=0',404],['GET',team+'/audit?token=x',404],['GET',team+'/audit?limit=5&limit=6&before=1',404],
   ['GET',team+'/members?limit=5',404],['POST',team+'/audit?limit=5',404]];
  for(const [method,path,code] of cases){
   const response={status(value){this.code=value;return this;},json(data){this.data=data;return this;}};
   await proxy({url:path,method,headers:{authorization:'Bearer token'},body:{}},response);
   assert.equal(response.code,code,method+' '+path);
  }
  assert.deepEqual(sent,['http://127.0.0.1:9876'+team+'/audit?limit=100','http://127.0.0.1:9876'+team+'/audit?before=42&limit=50','http://127.0.0.1:9876'+team+'/audit']);
 }finally{if(previous===undefined)delete process.env.MIA_HUB_URL;else process.env.MIA_HUB_URL=previous;}
});

test('team file routes are allowlisted exactly; every other file path or method is refused',async()=>{
 const previous=process.env.MIA_HUB_URL;process.env.MIA_HUB_URL='http://127.0.0.1:9876';
 const sent=[];const proxy=createHubClient({fetcher:async(url,options)=>{sent.push(options.method+' '+url.replace('http://127.0.0.1:9876',''));return {status:200,body:[Buffer.from('{"ok":true}')]};}});
 const t='/v1/teams/'+'a'.repeat(32),f='c'.repeat(32),s='d'.repeat(32);
 const allowed=[['GET',t+'/files/usage'],['POST',t+'/files/uploads'],['POST',t+'/files/'+f+'/parts'],['POST',t+'/files/'+f+'/complete'],
  ['GET',t+'/files/'+f+'/status'],['GET',t+'/files/'+f+'/download'],['DELETE',t+'/files/'+f],
  ['GET',t+'/file-spaces/channel/'+s+'/files'],['GET',t+'/file-spaces/group/'+s+'/files'],['GET',t+'/file-spaces/dm/'+s+'/files/before/1760000000/'+f],
  ['POST',t+'/file-spaces'],['GET',t+'/file-spaces/'+s+'/members'],['PUT',t+'/file-spaces/'+s+'/members/user_abc'],['DELETE',t+'/file-spaces/'+s+'/members/user_abc']];
 const refused=[['GET',t+'/files'],['GET',t+'/files/uploads'],['PUT',t+'/files/uploads'],['POST',t+'/files/usage'],['GET',t+'/files/'+f],
  ['PATCH',t+'/files/'+f],['GET',t+'/files/'+f+'/parts'],['DELETE',t+'/files/'+f+'/complete'],['POST',t+'/files/'+f+'/download'],
  ['GET',t+'/files/'+f.toUpperCase()+'/status'],['GET',t+'/files/short/status'],['GET',t+'/files/'+f+'/status/extra'],['GET',t+'/files/'+f+'/status?x=1'],
  ['GET',t+'/file-spaces/other/'+s+'/files'],['GET',t+'/file-spaces/channel/'+s+'/files/before/0/'+f],['GET',t+'/file-spaces/channel/'+s+'/files/before/12/'+'z'.repeat(32)],
  ['GET',t+'/file-spaces/channel/'+s+'/files/before/12'],['PUT',t+'/file-spaces/'+s+'/members/a%2Fb'],['PUT',t+'/file-spaces/'+s+'/members/a.b'],
  ['GET',t+'/file-spaces'],['POST',t+'/file-spaces/channel/'+s+'/files']];
 try{
  for(const [method,path] of [...allowed,...refused]){
   const response={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
   await proxy({url:path,method,headers:{authorization:'Bearer token'},body:{}},response);
   assert.equal(response.code,allowed.some(([m,p])=>m===method&&p===path)?200:404,method+' '+path);
  }
  assert.equal(sent.length,allowed.length);
  const channelFiles=t+'/channels/'+s+'/files';
  const old={status(code){this.code=code;return this;},json(){return this;}};
  await proxy({url:channelFiles,method:'POST',headers:{authorization:'Bearer token'},body:{}},old);
  assert.equal(old.code,200,'the existing channel attachment route is untouched');
 }finally{if(previous===undefined)delete process.env.MIA_HUB_URL;else process.env.MIA_HUB_URL=previous;}
});

test('team file routes keep tight bounds: only completing an upload gets a larger body and longer wait',()=>{
 const { hubRouteLimits, hubFileRoute } = require('./hub-client');
 const t='/v1/teams/'+'a'.repeat(32),f='c'.repeat(32),s='d'.repeat(32);
 assert.equal(hubRouteLimits('POST',t+'/files/'+f+'/complete').request,32768);
 assert.equal(hubRouteLimits('POST',t+'/files/'+f+'/complete').timeout,30000);
 for(const [method,path] of [['POST',t+'/files/uploads'],['POST',t+'/files/'+f+'/parts'],['GET',t+'/files/usage'],['GET',t+'/files/'+f+'/download'],
   ['GET',t+'/file-spaces/channel/'+s+'/files'],['DELETE',t+'/files/'+f]]){
  const limits=hubRouteLimits(method,path);
  assert.equal(limits.request,8192,path);assert.equal(limits.response,131072,path);assert.equal(limits.timeout,15000,path);
 }
 // 63 parts is the most a 500,000,000-byte file needs; its completion body must fit.
 const parts=Array.from({length:63},(_,i)=>({number:i+1,etag:'"'+'e'.repeat(32)+'-1"',sha256:'f'.repeat(64)}));
 assert.ok(Buffer.byteLength(JSON.stringify({parts}))<32768);
 assert.equal(hubFileRoute('GET',t+'/channels/'+s+'/messages'),null);
});

const WF_TEAM='a'.repeat(32), WF_ID='b'.repeat(32), WF_BASE='/v1/teams/'+WF_TEAM;
function wfProxy(reply={}){
 const seen=[];
 const proxy=createHubClient({fetcher:async(url,options)=>{seen.push({url,options});return new Response(typeof reply==='string'?reply:JSON.stringify(reply));}});
 const send=async(method,url,body)=>{
  const response={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await proxy({method,url,body,headers:{authorization:'Bearer fixture.token'}},response);
  return response;
 };
 return {seen,send};
}
test('every workflow route takes the Hub\'s 2 MiB response limit, and only definition writes a larger body',()=>{
 for(const [method,route] of [['GET','/workflows'],['GET','/workflows/'+WF_ID],['GET','/workflow-runs'],['GET','/workflow-runs?state=recent'],['GET','/workflow-runs/'+WF_ID],['GET','/workflow-steps'],['GET','/workflow-approvals?state=pending'],['POST','/workflow-runs/'+WF_ID+'/steps/1/claim'],['POST','/workflows/'+WF_ID+'/runs']])
  assert.equal(hubRouteLimits(method,WF_BASE+route).response,2097152,route);
 assert.equal(hubRouteLimits('GET',WF_BASE+'/channels').response,131072);
 assert.equal(hubRouteLimits('POST',WF_BASE+'/channels').response,131072);
 assert.equal(hubRouteLimits('POST',WF_BASE+'/workflows').request,16384);
 assert.equal(hubRouteLimits('POST',WF_BASE+'/workflows/'+WF_ID+'/versions').request,16384);
 for(const [method,route] of [['POST','/workflows/'+WF_ID+'/runs'],['POST','/workflows/'+WF_ID+'/versions/1/approve'],['PATCH','/workflows/'+WF_ID],['POST','/workflow-runs/'+WF_ID+'/steps/1/report'],['POST','/channels']])
  assert.equal(hubRouteLimits(method,WF_BASE+route).request,8192,route);
 assert.equal(hubRouteLimits('GET',WF_BASE+'/workflows').request,8192);
});
test('a 16 KB definition reaches the Hub, a larger one and an oversized run body do not',async()=>{
 const {seen,send}=wfProxy({saved:true});
 const within=await send('POST',WF_BASE+'/workflows',{definition:'x'.repeat(16000)});
 assert.equal(within.code,200);assert.equal(seen.length,1);
 const over=await send('POST',WF_BASE+'/workflows/'+WF_ID+'/versions',{definition:'x'.repeat(16400)});
 assert.equal(over.code,413);assert.equal(seen.length,1);
 const run=await send('POST',WF_BASE+'/workflows/'+WF_ID+'/runs',{id:WF_ID,summary:'x'.repeat(9000)});
 assert.equal(run.code,413);assert.equal(seen.length,1);
});
test('a workflow list response over 128 KB passes up to 512 KB and stops beyond it',async()=>{
 const body=size=>JSON.stringify({workflows:[{name:'x'.repeat(size)}]});
 assert.equal((await wfProxy(body(300*1024)).send('GET',WF_BASE+'/workflows')).code,200);
 assert.equal((await wfProxy(body(530*1024)).send('GET',WF_BASE+'/workflows')).code,503);
 assert.equal((await wfProxy(body(300*1024)).send('GET',WF_BASE+'/workflows/'+WF_ID)).code,503);
});
test('only the exact workflow query strings are forwarded',async()=>{
 for(const query of ['/workflow-runs?state=active','/workflow-runs?state=recent','/workflow-runs?state=all','/workflow-runs?workflow='+WF_ID,'/workflow-runs?state=all&workflow='+WF_ID,
  '/workflow-approvals?state=pending','/workflow-approvals?state=decided','/workflow-approvals?state=all']){
  const {seen,send}=wfProxy({runs:[]});
  assert.equal((await send('GET',WF_BASE+query)).code,200,query);
  assert.equal(seen[0].url.endsWith(query),true);
 }
 for(const [method,query] of [['POST','/workflow-runs?state=active'],['GET','/workflow-runs?state=open'],['GET','/workflow-runs?state=active&x=1'],['GET','/workflow-runs?workflow=abc'],
  ['GET','/workflow-runs?state=active&workflow='+WF_ID+'&state=all'],['GET','/workflow-approvals?state=open'],['GET','/workflow-approvals?workflow='+WF_ID],
  ['GET','/workflows?state=active'],['GET','/workflow-steps?state=queued'],['GET','/channels?state=active'],['GET','/workflow-runs?state=active#x']]){
  const {seen,send}=wfProxy({});
  assert.equal((await send(method,WF_BASE+query)).code,404,query);
  assert.equal(seen.length,0,query);
 }
});
test('the plain workflow routes stay forwarded as ordinary team routes',async()=>{
 for(const [method,route] of [['GET','/workflows'],['GET','/workflow-steps'],['GET','/workflow-runs/'+WF_ID],['POST','/workflow-runs/'+WF_ID+'/steps/2/claim'],['POST','/workflow-approvals/'+WF_ID+'/approve'],['PATCH','/members/user_1'],['DELETE','/workflows/'+WF_ID]]){
  const {seen,send}=wfProxy({});
  assert.equal((await send(method,WF_BASE+route,{})).code,200,route);
  assert.equal(seen.length,1,route);
 }
});
