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
