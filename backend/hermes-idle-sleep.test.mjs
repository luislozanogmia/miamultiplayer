import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {createHermesIdleSleep,cronOutlook,backgroundCommandAlive}=require('./hermes-idle-sleep');
const {HermesRuntimeController}=require('./hermes-runtime-controller');

const MIN=60*1000;
function fakeClient(log) {
  return {child:{},shutdownRequested:false,nextRequestId:1,pending:new Map(),turns:new Map(),operations:new Set(),unsolicitedTurns:new Map(),
    async connect(){log.push('start');},
    async stopOwnedGateway(){this.shutdownRequested=true;log.push('stop');return true;},
    async waitForListenerExit(){return true;}};
}
function fixture({cron={nextDueAt:Infinity,running:false,lastRunAt:0},background=false}={}) {
  const log=[];let time=1_000_000_000_000;
  const runtime=new HermesRuntimeController(()=>fakeClient(log));
  const state={cron,background};
  const sleep=createHermesIdleSleep({runtime,home:'/nowhere',idleMs:10*MIN,now:()=>time,
    outlook:()=>state.cron,backgroundAlive:()=>state.background});
  return {log,runtime,sleep,state,pass:async ms=>{time+=ms;await sleep.tick();},now:()=>time};
}

test('Hermes stops after ten quiet minutes and the next request starts a new one',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  await f.pass(9*MIN);
  assert.deepEqual(f.log,['start'],'still up before the wait is over');
  await f.pass(2*MIN);
  assert.deepEqual(f.log,['start','stop']);
  assert.equal(f.sleep.asleep,true);
  assert.equal(f.runtime.current,null);
  const next=await f.runtime.get();await next.connect();
  assert.deepEqual(f.log,['start','stop','start'],'the caller got a fresh runtime');
  await f.sleep.tick();
  assert.equal(f.sleep.asleep,false);
});

test('a request or a turn in flight keeps Hermes up, and counts as use afterwards',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  const client=f.runtime.current;
  client.turns.set('s1',{});
  await f.pass(30*MIN);
  assert.deepEqual(f.log,['start'],'a turn is running');
  client.turns.clear();
  await f.pass(9*MIN);
  assert.deepEqual(f.log,['start'],'the wait starts when the turn ends');
  client.nextRequestId++;
  await f.pass(9*MIN);
  assert.deepEqual(f.log,['start'],'a request in between starts the wait again');
  await f.pass(11*MIN);
  assert.deepEqual(f.log,['start','stop']);
});

test('a request that arrives while the stop waits its turn keeps Hermes up',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  const client=f.runtime.current;
  // Something else holds the controller's queue; a request lands meanwhile.
  let release;f.runtime.enqueue(()=>new Promise(resolve=>{release=resolve;}));
  const ticking=f.pass(11*MIN);
  await new Promise(resolve=>setImmediate(resolve));
  client.operations.add('turn');release();await ticking;
  assert.deepEqual(f.log,['start']);
  assert.equal(f.runtime.current,client);
});

test('an automation due soon, one that is running, or a live background command keeps Hermes up',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  f.state.cron={nextDueAt:f.now()+12*MIN,running:false,lastRunAt:0};
  await f.pass(11*MIN);
  assert.deepEqual(f.log,['start'],'due in a minute');
  f.state.cron={nextDueAt:Infinity,running:true,lastRunAt:0};
  await f.pass(11*MIN);
  assert.deepEqual(f.log,['start'],'running now');
  f.state.cron={nextDueAt:Infinity,running:false,lastRunAt:f.now()};
  await f.pass(5*MIN);
  assert.deepEqual(f.log,['start'],'just finished');
  f.state.cron={nextDueAt:Infinity,running:false,lastRunAt:0};f.state.background=true;
  await f.pass(11*MIN);
  assert.deepEqual(f.log,['start'],'a background command is alive');
  f.state.background=false;
  await f.pass(MIN);
  assert.deepEqual(f.log,['start','stop']);
});

test('a sleeping Hermes starts again shortly before an automation is due',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  f.state.cron={nextDueAt:f.now()+60*MIN,running:false,lastRunAt:0};
  await f.pass(11*MIN);
  assert.deepEqual(f.log,['start','stop']);
  await f.pass(40*MIN);
  assert.deepEqual(f.log,['start','stop'],'49 minutes early is too early');
  await f.pass(7*MIN);
  assert.deepEqual(f.log,['start','stop','start'],'up two minutes before it is due');
  await f.pass(MIN);
  assert.deepEqual(f.log,['start','stop','start'],'and it stays up until the job has run');
});

test('a runtime Mia did not start, or one stopped for another reason, is left alone',async()=>{
  const f=fixture();
  await f.runtime.start();await f.sleep.tick();
  f.runtime.current.child=null;
  await f.pass(30*MIN);
  assert.deepEqual(f.log,['start'],'an external runtime is never stopped');
  f.runtime.current.child={};
  await f.runtime.stop();
  f.state.cron={nextDueAt:f.now()+MIN,running:false,lastRunAt:0};
  await f.pass(MIN);
  assert.deepEqual(f.log,['start','stop'],'only a runtime this put to sleep is woken');
});

test('the schedule and background commands are read from the root home and every profile',()=>{
  const home=mkdtempSync(join(tmpdir(),'mia-hermes-idle-'));
  mkdirSync(join(home,'cron'));mkdirSync(join(home,'profiles','worker','cron'),{recursive:true});
  writeFileSync(join(home,'cron','jobs.json'),JSON.stringify({jobs:[
    {id:'a',enabled:true,state:'scheduled',next_run_at:'2026-11-10T14:00:00-06:00',last_run_at:'2026-11-09T14:00:00-06:00'},
    {id:'b',enabled:false,next_run_at:'2026-11-10T09:00:00-06:00'},
    {id:'c',enabled:true,state:'paused',next_run_at:'2026-11-10T08:00:00-06:00'}]}));
  writeFileSync(join(home,'profiles','worker','cron','jobs.json'),JSON.stringify({jobs:[
    {id:'d',enabled:true,state:'scheduled',next_run_at:'2026-11-10T12:00:00-06:00',fire_claim:{at:'2026-11-10T11:58:00-06:00'}}]}));
  const outlook=cronOutlook(home,Date.parse('2026-11-10T11:59:00-06:00'));
  assert.equal(outlook.nextDueAt,Date.parse('2026-11-10T12:00:00-06:00'),'the earliest enabled job, whichever profile');
  assert.equal(outlook.running,true);
  assert.equal(outlook.lastRunAt,Date.parse('2026-11-09T14:00:00-06:00'));
  assert.equal(cronOutlook(home,Date.parse('2026-11-11T11:59:00-06:00')).running,false,'a claim left by a run that died is not a run');
  assert.deepEqual(cronOutlook(join(home,'missing')),{nextDueAt:Infinity,running:false,lastRunAt:0});

  assert.equal(backgroundCommandAlive(home,()=>true),false,'nothing recorded');
  writeFileSync(join(home,'profiles','worker','processes.json'),JSON.stringify([{pid:4242,session_key:'s'}]));
  assert.equal(backgroundCommandAlive(home,pid=>pid===4242),true);
  assert.equal(backgroundCommandAlive(home,()=>false),false,'the command has ended');
});
