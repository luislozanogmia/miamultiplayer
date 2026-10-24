'use strict';
const {createHubBotJournal}=require('./hub-bot-journal');
const {hubEndpoint}=require('./hub-client');
const {CLERK_INSTANCES}=require('./clerk-config');

function failure(status,code) { return Object.assign(new Error(code),{status,code}); }
async function requestHub(origin,token,method,path,body,fetcher=fetch) {
  if(typeof token!=='string' || !/^[A-Za-z0-9_.-]+$/.test(token) || token.length>16384) throw failure(401,'hub_sign_in_required');
  const response=await fetcher(origin+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const chunks=[];let length=0;
  for await(const chunk of response.body) {length+=chunk.length;if(length>131072) throw failure(503,'hub_unavailable');chunks.push(Buffer.from(chunk));}
  const result=JSON.parse(Buffer.concat(chunks));
  if(!response.ok) throw failure(response.status,['not_found','reserved_bot_name','bot_name_conflict','bot_limit','idempotency_conflict','dispatch_claimed','dispatch_completed','dispatch_expired','invalid_claim'].includes(result.error)?result.error:'hub_request_failed');
  return result;
}
function createHubBotClient({db,dataDirectory,getBot,listBots,isOwnerActive,getAccountIdentity,runBot,checkIntervalMs=15000,fetcher=fetch}) {
  const journal=createHubBotJournal(db);
  const inFlight=new Map(), freshTokens=new Map(), selections=new Map();
  const scopeKey=s=>JSON.stringify([s.origin,s.owner,s.subject,s.teamId,s.channelId]);
  const runKey=(s,id)=>scopeKey(s)+':'+id;
  const base=s=>`/v1/teams/${s.teamId}/channels/${s.channelId}`;
  function localIdentityValid(s) {
    const identity=getAccountIdentity(s.owner);
    return isOwnerActive(s.owner) && identity && identity.subject===s.subject
      && identity.issuer===CLERK_INSTANCES.production.issuer && hubEndpoint(dataDirectory)===s.origin;
  }
  async function publish(s,run,token) {
    if(!localIdentityValid(s)) return journal.discard(s,run.job_id);
    try {
      await requestHub(s.origin,token,'POST',base(s)+'/bot-dispatches/'+run.job_id+'/result',
        {claimId:run.claim_id,text:run.reply},fetcher);
      journal.published(s,run.job_id);
    } catch(error) {
      if([403,404,409].includes(error.status)) journal.discard(s,run.job_id);
      // Transient/auth failures retain the reply for a fresh authenticated poll.
    }
  }
  async function execute(s,run,initialToken) {
    const token=()=>freshTokens.get(scopeKey(s))||initialToken;
    if(!localIdentityValid(s)) return journal.discard(s,run.job_id);
    let claim;
    try {
      claim=await requestHub(s.origin,token(),'POST',base(s)+'/bot-dispatches/'+run.job_id+'/claim',{claimId:run.claim_id},fetcher);
    } catch(error) {
      if([403,404,409].includes(error.status)) journal.discard(s,run.job_id);
      return;
    }
    if(!Number.isSafeInteger(claim.triggerSequence) || claim.triggerSequence<1 || claim.botId!==run.registration_id
      || claim.id!==run.job_id || claim.executorId!==s.subject || !claim.definition || !Number.isSafeInteger(claim.definition.version) || typeof claim.definition.instructions!=='string' || !localIdentityValid(s)) return journal.discard(s,run.job_id);
    // Commit before any inference call. A process crash here is uncertain work,
    // never permission to repeat a potentially side-effecting tool operation.
    if(!journal.start(s,run.job_id)) return;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),120000);
    let checking=false;
    const check=setInterval(async()=>{
      if(checking) return;
      checking=true;
      try {
        if(!localIdentityValid(s)) throw new Error('owner_changed');
        await requestHub(s.origin,token(),'POST',base(s)+'/bot-dispatches/'+run.job_id+'/claim',{claimId:run.claim_id},fetcher);
      } catch {controller.abort();}
      finally {checking=false;}
    },checkIntervalMs);
    try {
      const triggerPage=await requestHub(s.origin,token(),'GET',base(s)+'/messages/after/'+(claim.triggerSequence-1),undefined,fetcher);
      const trigger=(triggerPage.messages||[]).find(row=>row.sequence===claim.triggerSequence);
      const history=[];let after=Math.max(0,claim.triggerSequence-40);
      for(let page=0;page<3 && after<claim.triggerSequence;page++) {
        const result=await requestHub(s.origin,token(),'GET',base(s)+'/messages/after/'+after,undefined,fetcher);
        history.push(...(result.messages||[]).filter(row=>row.sequence<=claim.triggerSequence));
        if(!result.next || result.next<=after) break;
        after=result.next;
      }
      if(!trigger || trigger.author_type!=='user' || trigger.author_id!==claim.requesterId || controller.signal.aborted) throw new Error('invalid_trigger');
      // Recheck revocation immediately before invoking the existing runtime.
      await requestHub(s.origin,token(),'POST',base(s)+'/bot-dispatches/'+run.job_id+'/claim',{claimId:run.claim_id},fetcher);
      if(!localIdentityValid(s) || controller.signal.aborted) throw new Error('owner_changed');
      const currentBot={id:'shared-'+run.registration_id+'-v'+claim.definition.version, name:claim.botName || 'Shared bot', instructions:claim.definition.instructions};
      const reply=await runBot({owner:s.owner,bot:currentBot,trigger,history:history.filter(row=>row.sequence<claim.triggerSequence),signal:controller.signal,modelSelection:selections.get(runKey(s,run.job_id))||null});
      if(controller.signal.aborted) throw new Error('cancelled');
      const text=typeof reply==='string'?reply:reply && reply.text;
      journal.saveReply(s,run.job_id,text);
    } catch {
      journal.saveReply(s,run.job_id,'This bot could not complete the request. Please send a new message to try again.');
    } finally {clearTimeout(timeout);clearInterval(check);}
    await publish(s,journal.getRun(s,run.job_id),token());
  }
  function launch(s,run,token) {
    const key=runKey(s,run.job_id);
    if(inFlight.has(key) || inFlight.size>=2) return;
    const task=Promise.resolve().then(()=>execute(s,run,token)).catch(()=>{}).finally(()=>{
      inFlight.delete(key);selections.delete(key);
      if(![...inFlight.keys()].some(key=>key.startsWith(scopeKey(s)+':'))) freshTokens.delete(scopeKey(s));
    });
    inFlight.set(key,task);
  }
  async function context(owner,input,token) {
    owner=String(owner||'').trim().toLowerCase();
    if(!owner || !isOwnerActive(owner)) throw failure(403,'account_unavailable');
    const identity=getAccountIdentity(owner);
    if(!identity || identity.issuer!==CLERK_INSTANCES.production.issuer || !identity.subject || !identity.email) throw failure(403,'account_not_linked');
    if(!input || !/^[a-f0-9]{32}$/.test(input.teamId||'') || !/^[a-f0-9]{32}$/.test(input.channelId||'')) throw failure(400,'invalid_channel');
    const origin=hubEndpoint(dataDirectory);
    if(!origin) throw failure(503,'hub_not_configured');
    const me=await requestHub(origin,token,'GET','/v1/me',undefined,fetcher);
    const current=getAccountIdentity(owner);
    if(!isOwnerActive(owner) || !current || current.subject!==identity.subject || current.issuer!==identity.issuer || current.email!==identity.email) throw failure(403,'account_changed');
    const team=(me.teams||[]).find(team=>team.teamId===input.teamId && team.membership);
    if(!team || typeof team.membership.clerk_user_id!=='string' || team.membership.clerk_user_id!==identity.subject || String(team.membership.email||'').trim().toLowerCase()!==String(identity.email).trim().toLowerCase()) throw failure(403,'account_mismatch');
    return {origin,owner,teamId:input.teamId,channelId:input.channelId,subject:team.membership.clerk_user_id};
  }
  return {
    journal,
    async idle() {await Promise.all([...inFlight.values()]);},
    async poll(owner,input,token,approvedJobId) {
      if(typeof runBot!=='function') throw failure(503,'bot_runtime_unavailable');
      const scope=await context(owner,input,token),key=scopeKey(scope);
      const roster=await requestHub(scope.origin,token,'GET',base(scope)+'/bots',undefined,fetcher);
      const jobs=await requestHub(scope.origin,token,'GET',base(scope)+'/bot-dispatches',undefined,fetcher);
      freshTokens.set(key,token);
      const allowed=new Set((roster.bots||[]).map(bot=>bot.id));
      for(const run of journal.unfinished(scope)) {
        if(!allowed.has(run.registration_id)) {journal.discard(scope,run.job_id);continue;}
        if(inFlight.has(runKey(scope,run.job_id))) continue;
        if(run.state==='started') {
          journal.saveReply(scope,run.job_id,'This bot was interrupted before its reply was saved. Send a new message to try again.');
          await publish(scope,journal.getRun(scope,run.job_id),token);
        } else if(run.state==='reply_ready') await publish(scope,run,token);
        else launch(scope,run,token);
      }
      const pending=(jobs.dispatches||[]).filter(job=>job.executor_id===scope.subject);
      for(const job of pending) {
        // Asking the bot authorizes use of the requester's own local account.
        // A handoff from someone else still needs this participant's acceptance.
        const ownRequest=job.requester_id===scope.subject;
        if(!/^[a-f0-9]{32}$/.test(job.id||'') || !allowed.has(job.bot_id) || (!ownRequest && job.id!==approvedJobId)) continue;
        const run=journal.prepare(scope,job);
        if(run.state!=='prepared') continue;
        const selection=input.modelSelection;
        if(ownRequest && selection && typeof selection==='object' && !inFlight.has(runKey(scope,job.id)))
          selections.set(runKey(scope,job.id),{provider:String(selection.provider||''),model:String(selection.model||''),
            reasoningEffort:selection.reasoningEffort,speed:selection.speed,fast:selection.fast===true});
        launch(scope,run,token);
      }
      if(![...inFlight.keys()].some(k=>k.startsWith(key+':'))) freshTokens.delete(key);
      return {running:[...inFlight.keys()].filter(k=>k.startsWith(key+':')).length, pending};
    },
    async run(owner,input,token) {
      if (!/^[a-f0-9]{32}$/.test(input.jobId||'')) throw failure(400,'invalid_job');
      return this.poll(owner,input,token,input.jobId);
    },
    available(owner) {
      owner=String(owner||'').trim().toLowerCase();
      if(!isOwnerActive(owner)) throw failure(403,'account_unavailable');
      return {bots:listBots(owner).map(bot=>({id:String(bot.id),name:bot.name}))};
    },
    async sync(owner,input,token) {
      const scope=await context(owner,input,token);
      const binding=journal.bindings(scope).find(b=>b.registration_id===input.botId);
      const bot=binding && getBot(binding.local_bot_id,scope.owner);
      if (!bot) throw failure(404,'bot_not_found');
      return requestHub(scope.origin,token,'POST',base(scope)+'/bots/'+binding.registration_id+'/versions',
        {instructions:bot.instructions || bot.role || bot.output || '',source:'solo'},fetcher);
    },
    async share(owner,input,token) {
      if (!['linked','fork'].includes(input.mode)) throw failure(400,'sharing_mode_required');
      const scope=await context(owner,input,token);
      const bot=getBot(String(input.localBotId||''),scope.owner);
      if(!bot) throw failure(404,'bot_not_found');
      const binding=journal.bind(scope,bot);
      const result=await requestHub(scope.origin,token,'POST',`/v1/teams/${scope.teamId}/channels/${scope.channelId}/bots`,
        {id:binding.registration_id,name:binding.public_name},fetcher);
      if(!result.bot || result.bot.owner_id!==scope.subject || result.bot.id!==binding.registration_id) throw failure(503,'hub_identity_mismatch');
      const proposed=await requestHub(scope.origin,token,'POST',base(scope)+'/bots/'+binding.registration_id+'/versions',
        {mode:input.mode,instructions:bot.instructions || bot.role || bot.output || '',source:'manual'},fetcher);
      return {bot:result.bot,proposal:proposed.proposal};
    },
  };
}
function createHubBotRouter(options) {
  const router=require('express').Router(),client=createHubBotClient(options);
  const handle=action=>async(req,res)=>{
    try {res.json(await action(req));}
    catch(error) {res.status(error.status||503).json({error:error.code||'hub_bot_unavailable'});}
  };
  router.get('/available',handle(req=>client.available(req.userEmail)));
  router.post('/poll',handle(req=>client.poll(req.userEmail,req.body,req.get('x-hub-token'))));
  router.post('/run',handle(req=>client.run(req.userEmail,req.body,req.get('x-hub-token'))));
  router.post('/sync',handle(req=>client.sync(req.userEmail,req.body,req.get('x-hub-token'))));
  router.post('/share',handle(req=>client.share(req.userEmail,req.body,req.get('x-hub-token'))));
  return router;
}
module.exports={createHubBotClient,createHubBotRouter,requestHub};
