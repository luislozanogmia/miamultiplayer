const test=require('node:test');
const assert=require('node:assert/strict');
const logo=require('./team-logo.js');
test('logo rendering accepts only bounded PNG data, never URLs or SVG',()=>{
 for(const value of [null,'https://example.test/logo.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,'+'a'.repeat(44000)])assert.equal(logo.valid(value),false);
 assert.equal(logo.valid('data:image/png;base64,aGVsbG8='),true);
});
test('upload rejects unsupported and oversized originals before decoding',async()=>{
 for(const file of [{type:'text/plain',size:1},{type:'image/png',size:9*1024*1024}])await assert.rejects(logo.prepare(file),/PNG or JPEG/);
});
test('proxy grants only the logo PUT its bounded upload size',()=>{
 const {hubRouteLimits}=require('../backend/hub-client.js');
 assert.equal(hubRouteLimits('PUT','/v1/teams/'+'a'.repeat(32)+'/team/logo').request,45000);
 assert.equal(hubRouteLimits('PUT','/v1/teams/'+'a'.repeat(32)+'/team').request,8192);
});
