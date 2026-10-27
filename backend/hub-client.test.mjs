import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {hubEndpoint,createHubClient}=require('./hub-client.js');

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
