const fs = require('node:fs');
const p = require('node:path');
const r = process.env.MIA_NSIS_FIXTURE;
if (!r || !r.includes('mia-nsis-review-')) throw new Error('Invalid fixture root');
if (process.argv[2] === 'create') {
  fs.mkdirSync(r, {recursive:true});
  fs.writeFileSync(p.join(r, 'a-before.txt'), 'before');
  const d = p.join(r, 'deep', ...Array(8).fill('segment-abcdefghijklmnopqrst'));
  fs.mkdirSync(d, {recursive:true});
  fs.writeFileSync(p.join(d, 'payload.txt'), 'deep payload');
  fs.writeFileSync(p.join(r, 'z-locked.txt'), 'locked');
  console.log(JSON.stringify({case:r,deepLength:p.join(d,'payload.txt').length}));
} else {
  const files=[];
  function walk(d) { if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else files.push({relative:p.relative(r,f),content:fs.readFileSync(f,'utf8')});} }
  walk(r);
  console.log(JSON.stringify({exists:fs.existsSync(r),files}));
  const rollback=r.endsWith('rollback');
  if(rollback ? files.length!==3 || !files.some(f=>f.content==='deep payload') || !files.some(f=>f.content==='before') || !files.some(f=>f.content==='locked') : fs.existsSync(r))process.exit(2);
}
