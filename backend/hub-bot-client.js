'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHubBotJournal}=require('./hub-bot-journal');
const {hubEndpoint}=require('./hub-client');
const {CLERK_INSTANCES}=require('./clerk-config');

// The Hub stores at most 16,000 UTF-8 bytes per message. A longer reply is
// cut at a character boundary rather than lost.
// A definition holds long instructions and up to ten skills.
const RESPONSE_BYTES=12*1024*1024;
const DEFINITION_RESPONSE_BYTES=73*1024*1024;
const REPLY_BYTES=16000, CUT_NOTE='\n\n[Reply shortened to fit the channel.]';
function fitReply(text,limit=REPLY_BYTES) {
  if(typeof text!=='string' || Buffer.byteLength(text)<=limit) return text;
  const room=limit-Buffer.byteLength(CUT_NOTE);
  let cut=Buffer.from(text).subarray(0,room).toString('utf8');
  if(cut.endsWith('\uFFFD')) cut=cut.slice(0,-1);
  return cut.trimEnd()+CUT_NOTE;
}
// A reply ends with one line saying where it ran, such as "Grok · Ran on Tom's
// Mia". The invisible mark lets Mia show it as a label and leave it out of what
// bots read; an app that doesn't know the mark just shows the readable line.
const RUN_LABEL_MARK='\n\n\u2063';
function runLabel(provider,memberName) {
  const first=String(memberName||'').trim().split(/\s+/)[0];
  return [provider,'Ran on '+(first?first+'’s':'a colleague’s')+' Mia'].filter(Boolean).join(' · ');
}
function withRunLabel(text,label) {
  if(typeof text!=='string' || !text.trim()) return fitReply(text);
  const clean=text.replace(/\u2063/g,''),tail=RUN_LABEL_MARK+label;
  return fitReply(clean,REPLY_BYTES-Buffer.byteLength(tail))+tail;
}
function withoutRunLabel(body) {
  const at=typeof body==='string'?body.lastIndexOf(RUN_LABEL_MARK):-1;
  return at<0?body:body.slice(0,at);
}
function failure(status,code) { return Object.assign(new Error(code),{status,code}); }
async function requestHub(origin,token,method,path,body,fetcher=fetch) {
  if(typeof token!=='string' || !/^[A-Za-z0-9_.-]+$/.test(token) || token.length>16384) throw failure(401,'hub_sign_in_required');
  const definitionRoute=/(?:\/versions|\/definition|\/claim)$/.test(path);
  const response=await fetcher(origin+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(definitionRoute?60000:15000)});
  const chunks=[];let length=0;
  const responseLimit = method==='GET' && /\/versions$/.test(path) ? 5*DEFINITION_RESPONSE_BYTES
    : /\/(?:definition|claim)$/.test(path) ? DEFINITION_RESPONSE_BYTES : RESPONSE_BYTES;
  for await(const chunk of response.body) {length+=chunk.length;if(length>responseLimit) throw failure(503,'hub_unavailable');chunks.push(Buffer.from(chunk));}
  const result=JSON.parse(Buffer.concat(chunks));
  if(!response.ok) throw failure(response.status,['not_found','reserved_bot_name','bot_name_conflict','bot_limit','idempotency_conflict','dispatch_claimed','dispatch_completed','dispatch_expired','dispatch_cancelled','invalid_claim','bot_storage_limit'].includes(result.error)?result.error:'hub_request_failed');
  return result;
}
function sharedSkills(value) {
  return (Array.isArray(value)?value:[]).filter(skill=>skill && typeof skill.name==='string' && typeof skill.body==='string' && skill.body.trim())
    .map(skill=>({name:skill.name,description:typeof skill.description==='string'?skill.description:'',body:skill.body,
      ...(Array.isArray(skill.files)?{files:skill.files.filter(file=>file && typeof file.path==='string' && typeof file.body==='string')
        .map(file=>({path:file.path,body:file.body}))}:{})}));
}
function safeSharedSkillPath(value) {
  if(typeof value!=='string' || value.length>512 || !value.isWellFormed()) return false;
  const parts=value.split('/');
  const device=/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  return parts.length<=5 && value.toLowerCase()!=='skill.md' && parts.every(part=>part && !part.startsWith('.')
    && !part.includes('..') && !part.endsWith('.') && !part.endsWith(' ') && !/[\\:\x00-\x1f\x7f]/.test(part) && !device.test(part));
}
function materializeSharedSkills(skills) {
  if(!skills.length) return {skills,cleanup:()=>{}};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mia-shared-skills-'));
  try {
    const prepared=skills.map((skill,index)=>{
      const folder=path.join(root,String(index));
      fs.mkdirSync(folder,{mode:0o700});
      fs.writeFileSync(path.join(folder,'SKILL.md'),skill.body,{mode:0o600,flag:'wx'});
      const names=new Set();
      for(const file of skill.files || []) {
        if(!safeSharedSkillPath(file.path) || file.body.length>200000) throw new Error('invalid_shared_skill_file');
        const key=file.path.normalize('NFC').toLocaleLowerCase('en-US');
        if(names.has(key)) throw new Error('invalid_shared_skill_file');
        names.add(key);
        const target=path.join(folder,file.path);
        fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        fs.writeFileSync(target,file.body,{mode:/\.(py|sh|js|mjs)$/i.test(file.path)?0o700:0o600,flag:'wx'});
      }
      return {...skill,folder};
    });
    return {skills:prepared,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
  } catch(error) {fs.rmSync(root,{recursive:true,force:true});throw error;}
}
// A company run gets Solo's turn time, but always ends before the Hub's claim
// does, and reads the channel's last 100 messages, as Solo reads its chat.
const SHARED_RUN_HISTORY = 100;
const CLAIM_MARGIN_MS = 30000;
function sharedRunTimeoutMs(runTimeoutMs, deadline, now = Date.now()) {
  if (!Number.isFinite(deadline) || deadline <= 0) return runTimeoutMs;
  const endsAt = deadline < 1e12 ? deadline * 1000 : deadline; // the Hub counts seconds
  return Math.max(1000, Math.min(runTimeoutMs, endsAt - now - CLAIM_MARGIN_MS));
}
// Why a run stopped, as a short code in the log and a few words in the reply.
// Neither ever carries a token or message text.
const STOP_LABELS={time_limit:'time limit',sign_in_expired:'sign-in expired',claim_gone:'claim taken',owner_changed:'account changed',
  hub_unreachable:'company server unreachable',hub_refused:'company server refused it',invalid_trigger:'message not found',bot_failed:'the bot hit an error'};
function stoppedReply(code) {
  return 'This bot could not complete the request ('+(STOP_LABELS[code]||STOP_LABELS.bot_failed)+'). Please send a new message to try again.';
}
// The Hub's answer about a dispatch: 403, 404 and 409 mean the claim is gone.
function hubStopReason(error) {
  const status=error && error.status;
  if([403,404,409].includes(status)) return 'claim_gone';
  if(status===401) return 'sign_in_expired';
  if(!status || status===429 || status>=500) return 'hub_unreachable';
  return 'hub_refused';
}
function stopError(code) {return Object.assign(new Error(code),{reason:code});}
function logStop(event,code,jobId) {
  console.warn('[team-bot] '+event+': '+code+(jobId?' (run '+String(jobId).slice(0,8)+')':''));
}
function createHubBotClient({db,dataDirectory,getBot,listBots,bundleSkills=()=>[],isPrivateAgent=()=>false,isOwnerActive,getAccountIdentity,runBot,isHeld=()=>false,isClosing=()=>false,checkIntervalMs=15000,runTimeoutMs=10*60*1000,
  tokenWaitMs=30000,tokenPollMs=1000,retryDelayMs=2000,log=logStop,fetcher=fetch}) {
  const journal=createHubBotJournal(db);
  // Sign-in tokens are the person's, not a channel's, and last about a minute:
  // every poll and every /token refresh replaces the account's one, and each
  // Hub call during a run reads the newest.
  const inFlight=new Map(), runScopes=new Map(), freshTokens=new Map(), selections=new Map();
  const scopeKey=s=>JSON.stringify([s.origin,s.owner,s.subject,s.teamId,s.channelId]);
  const accountKey=s=>JSON.stringify([s.origin,s.owner,s.subject]);
  const accountRunning=s=>[...runScopes.values()].some(other=>accountKey(other)===accountKey(s));
  const pause=(ms,signal)=>new Promise(resolve=>{
    const timer=setTimeout(resolve,ms);
    if(signal) signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});
  });
  // One Hub call with the newest token. A 401 waits for a newer token (the app
  // sends one every ~20 seconds while a run is going) and tries once more; a
  // network or server error tries once more after a short pause. Errors keep
  // their status and get a stop reason.
  async function withFreshToken(s,fallback,call,signal) {
    const current=()=>freshTokens.get(accountKey(s))||fallback;
    const used=current();
    try {return await call(used);}
    catch(error) {
      const reason=hubStopReason(error);
      if(reason!=='sign_in_expired' && reason!=='hub_unreachable') throw Object.assign(error,{reason});
      if(reason==='sign_in_expired') {
        const started=Date.now();
        while(current()===used && Date.now()-started<tokenWaitMs && !(signal && signal.aborted)) await pause(tokenPollMs,signal);
      } else await pause(retryDelayMs,signal);
      try {return await call(current());}
      catch(again) {throw Object.assign(again,{reason:hubStopReason(again)});}
    }
  }
  const runKey=(s,id)=>scopeKey(s)+':'+id;
  const base=s=>`/v1/teams/${s.teamId}/channels/${s.channelId}`;
  // The file on the message being answered. A file that can't be fetched is still named to the bot.
  const triggerFile=async(s,trigger,token)=>{
    const item=trigger.attachment;
    if(!item || !item.id) return {};
    try {
      const {file}=await requestHub(s.origin,token(),'GET',base(s)+'/files/'+item.id,undefined,fetcher);
      return {files:[{id:item.id,filename:item.filename||file.filename||'image',mimeType:item.mime_type||file.mime_type,bytes:Buffer.from(file.contentBase64,'base64')}]};
    } catch {
      return {unreadableFiles:[item.filename||'image']};
    }
  };
  function localIdentityValid(s) {
    const identity=getAccountIdentity(s.owner);
    return isOwnerActive(s.owner) && identity && identity.subject===s.subject
      && identity.issuer===CLERK_INSTANCES.production.issuer && hubEndpoint(dataDirectory)===s.origin;
  }
  async function publish(s,run,token) {
    if(!localIdentityValid(s)) {log('reply discarded','owner_changed',run.job_id);return journal.discard(s,run.job_id);}
    try {
      await withFreshToken(s,token,used=>requestHub(s.origin,used,'POST',base(s)+'/bot-dispatches/'+run.job_id+'/result',
        {claimId:run.claim_id,text:run.reply},fetcher));
      journal.published(s,run.job_id);
    } catch(error) {
      const reason=error.reason||hubStopReason(error);
      if(reason==='claim_gone') {log('reply discarded',reason,run.job_id);journal.discard(s,run.job_id);}
      // Transient/auth failures retain the reply for a fresh authenticated poll.
      else log('reply kept for the next poll',reason,run.job_id);
    }
  }
  async function execute(s,run,initialToken) {
    const token=()=>freshTokens.get(accountKey(s))||initialToken;
    const claimPath=base(s)+'/bot-dispatches/'+run.job_id+'/claim';
    if(!localIdentityValid(s)) {log('run not started','owner_changed',run.job_id);return journal.discard(s,run.job_id);}
    let claim;
    try {
      claim=await withFreshToken(s,initialToken,used=>requestHub(s.origin,used,'POST',claimPath,{claimId:run.claim_id},fetcher));
    } catch(error) {
      const reason=error.reason||hubStopReason(error);
      log('run not started',reason,run.job_id);
      if(reason==='claim_gone') journal.discard(s,run.job_id);
      return;
    }
    if(!Number.isSafeInteger(claim.triggerSequence) || claim.triggerSequence<1 || claim.botId!==run.registration_id
      || claim.id!==run.job_id || claim.executorId!==s.subject || !claim.definition || !Number.isSafeInteger(claim.definition.version) || typeof claim.definition.instructions!=='string' || !localIdentityValid(s)) {
      log('run not started','invalid_claim',run.job_id);
      return journal.discard(s,run.job_id);
    }
    // Commit before any inference call. A process crash here is uncertain work,
    // never permission to repeat a potentially side-effecting tool operation.
    if(!journal.start(s,run.job_id)) return;
    const controller=new AbortController();
    const stopRun=code=>{if(!controller.signal.aborted) controller.abort(stopError(code));};
    const hub=(method,route,body)=>withFreshToken(s,initialToken,used=>requestHub(s.origin,used,method,route,body,fetcher),controller.signal);
    const timeout=setTimeout(()=>stopRun('time_limit'),sharedRunTimeoutMs(runTimeoutMs,Number(claim.deadline)));
    let checking=false;
    let skillFilesCleanup=()=>{};
    // Only the Hub saying the claim is gone, or this computer's account
    // changing, stops a run. A check that can't get through (an expired
    // sign-in, no network) is tried again at the next one.
    const check=setInterval(async()=>{
      if(checking) return;
      checking=true;
      try {
        if(!localIdentityValid(s)) return stopRun('owner_changed');
        await requestHub(s.origin,token(),'POST',claimPath,{claimId:run.claim_id},fetcher);
      } catch(error) {
        const reason=hubStopReason(error);
        if(reason==='claim_gone') stopRun(reason);
        else log('claim check missed',reason,run.job_id);
      }
      finally {checking=false;}
    },checkIntervalMs);
    try {
      const triggerPage=await hub('GET',base(s)+'/messages/after/'+(claim.triggerSequence-1));
      const trigger=(triggerPage.messages||[]).find(row=>row.sequence===claim.triggerSequence);
      const history=[];let after=Math.max(0,claim.triggerSequence-SHARED_RUN_HISTORY);
      for(let page=0;page<6 && after<claim.triggerSequence;page++) {
        const result=await hub('GET',base(s)+'/messages/after/'+after);
        history.push(...(result.messages||[]).filter(row=>row.sequence<=claim.triggerSequence)
          .map(row=>row.author_type==='bot'?{...row,body:withoutRunLabel(row.body)}:row));
        if(!result.next || result.next<=after) break;
        after=result.next;
      }
      if(controller.signal.aborted) throw controller.signal.reason;
      if(!trigger || trigger.author_type!=='user' || trigger.author_id!==claim.requesterId) throw stopError('invalid_trigger');
      // Recheck revocation immediately before invoking the existing runtime.
      await hub('POST',claimPath,{claimId:run.claim_id});
      if(controller.signal.aborted) throw controller.signal.reason;
      if(!localIdentityValid(s)) throw stopError('owner_changed');
      // In the person's own private chat with a company bot, their Bot
      // Instructions apply, as in their Solo bot chats. Read from the Hub, not
      // the page: a bot chat with this person as its only member, and their
      // message. Anything else, or a failed lookup, stays a shared turn.
      const listed=await hub('GET','/v1/teams/'+s.teamId+'/channels').catch(()=>null);
      const place=((listed && listed.channels)||[]).find(channel=>channel && channel.id===s.channelId);
      const privateChat=!!place && place.kind==='bot' && claim.requesterId===s.subject
        && Array.isArray(place.member_ids) && place.member_ids.length===1 && place.member_ids[0]===s.subject;
      const preparedSkills=materializeSharedSkills(sharedSkills(claim.definition.skills));
      skillFilesCleanup=preparedSkills.cleanup;
      const currentBot={id:'shared-'+run.registration_id+'-v'+claim.definition.version, registrationId:run.registration_id, name:claim.botName || 'Shared bot', instructions:claim.definition.instructions, bundledSkills:preparedSkills.skills};
      const attached=await triggerFile(s,trigger,token);
      const reply=await runBot({owner:s.owner,bot:currentBot,trigger,history:history.filter(row=>row.sequence<claim.triggerSequence),
        channel:{teamId:s.teamId,teamName:s.teamName,channelId:s.channelId,privateChat},signal:controller.signal,modelSelection:selections.get(runKey(s,run.job_id))||null,...attached});
      if(controller.signal.aborted) throw controller.signal.reason;
      journal.saveReply(s,run.job_id,withRunLabel(typeof reply==='string'?reply:reply && reply.text,runLabel(reply && reply.provider,s.memberName)));
    } catch(error) {
      // Mia is closing: the journal keeps this as started, and the person decides next time.
      if(isClosing()) {log('run left for later','closing',run.job_id);return;}
      // A stop wins over whatever the bot threw while it was being stopped.
      const reason=controller.signal.aborted ? controller.signal.reason.reason : error && STOP_LABELS[error.reason] ? error.reason : 'bot_failed';
      log('run stopped',reason,run.job_id);
      journal.saveReply(s,run.job_id,stoppedReply(reason));
    } finally {clearTimeout(timeout);clearInterval(check);skillFilesCleanup();}
    await publish(s,journal.getRun(s,run.job_id),token());
  }
  function launch(s,run,token) {
    const key=runKey(s,run.job_id);
    if(inFlight.has(key) || inFlight.size>=2) return;
    runScopes.set(key,s);
    const task=Promise.resolve().then(()=>execute(s,run,token)).catch(error=>log('run failed',error && error.reason || 'unexpected',run.job_id)).finally(()=>{
      inFlight.delete(key);runScopes.delete(key);selections.delete(key);
      if(!accountRunning(s)) freshTokens.delete(accountKey(s));
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
    return {origin,owner,teamId:input.teamId,teamName:String(team.name||''),channelId:input.channelId,subject:team.membership.clerk_user_id,
      memberName:team.membership.display_name||current.displayName||''};
  }
  return {
    journal,
    async idle() {await Promise.all([...inFlight.values()]);},
    async poll(owner,input,token,approvedJobId) {
      if(typeof runBot!=='function') throw failure(503,'bot_runtime_unavailable');
      const scope=await context(owner,input,token),key=scopeKey(scope);
      const roster=await requestHub(scope.origin,token,'GET',base(scope)+'/bots',undefined,fetcher);
      const jobs=await requestHub(scope.origin,token,'GET',base(scope)+'/bot-dispatches',undefined,fetcher);
      freshTokens.set(accountKey(scope),token);
      const allowed=new Set((roster.bots||[]).map(bot=>bot.id));
      for(const run of journal.unfinished(scope)) {
        if(!allowed.has(run.registration_id)) {journal.discard(scope,run.job_id);continue;}
        if(inFlight.has(runKey(scope,run.job_id))) continue;
        if(run.state==='started') {
          if(isHeld(run.job_id)) continue;
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
      if(!accountRunning(scope)) freshTokens.delete(accountKey(scope));
      return {running:[...inFlight.keys()].filter(k=>k.startsWith(key+':')).length, pending};
    },
    // A fresh sign-in token while any of this person's runs is going, whatever
    // room they have open. -> {running} (0 tells the app to stop sending).
    async refresh(owner,token) {
      owner=String(owner||'').trim().toLowerCase();
      if(!owner || !isOwnerActive(owner)) throw failure(403,'account_unavailable');
      const scopes=[...runScopes.values()].filter(s=>s.owner===owner);
      if(!scopes.length) return {running:0};
      const identity=getAccountIdentity(owner);
      if(!identity || identity.issuer!==CLERK_INSTANCES.production.issuer || !identity.subject) throw failure(403,'account_not_linked');
      // The Hub, not the token's own claims, says whose token it is.
      const me=await requestHub(scopes[0].origin,token,'GET','/v1/me',undefined,fetcher);
      if(!(me.teams||[]).some(team=>team && team.membership && team.membership.clerk_user_id===identity.subject)) throw failure(403,'account_mismatch');
      for(const s of scopes) if(s.subject===identity.subject) freshTokens.set(accountKey(s),token);
      return {running:scopes.length};
    },
    async run(owner,input,token) {
      if (!/^[a-f0-9]{32}$/.test(input.jobId||'')) throw failure(400,'invalid_job');
      return this.poll(owner,input,token,input.jobId);
    },
    available(owner) {
      owner=String(owner||'').trim().toLowerCase();
      if(!isOwnerActive(owner)) throw failure(403,'account_unavailable');
      // Each bot lists the company copies made from it, so a company's My Bots
      // can tell which Solo bots it already uses as company bots.
      const copies={};
      for(const row of journal.sharedCopies(owner)) (copies[row.local_bot_id]=copies[row.local_bot_id]||[]).push({teamId:row.team_id,registrationId:row.registration_id});
      return {bots:listBots(owner).map(bot=>({id:String(bot.id),name:bot.name,sharedAs:copies[String(bot.id)]||[]}))};
    },
    // Sharing forks the bot: the team gets its own copy of the instructions
    // and of its skills' text, no longer tied to the Solo bot or the library.
    // Automations and memories stay in Solo.
    async share(owner,input,token) {
      // Personal agents are private to their owner and never leave the machine.
      if(isPrivateAgent(String(input.localBotId||''))) throw failure(403,'agent_not_shareable');
      const scope=await context(owner,input,token);
      const bot=getBot(String(input.localBotId||''),scope.owner);
      if(!bot) throw failure(404,'bot_not_found');
      const binding=journal.bind(scope,bot);
      const result=await requestHub(scope.origin,token,'POST',`/v1/teams/${scope.teamId}/channels/${scope.channelId}/bots`,
        {id:binding.registration_id,name:binding.public_name},fetcher);
      if(!result.bot || result.bot.owner_id!==scope.subject || result.bot.id!==binding.registration_id) throw failure(503,'hub_identity_mismatch');
      // A copy from another company brings the skills its owner reviewed.
      const skills=sharedSkills(Array.isArray(input.skills)?input.skills:bundleSkills(bot));
      // A Hub that has not been updated refuses skills and long instructions.
      const proposed=await requestHub(scope.origin,token,'POST',base(scope)+'/bots/'+binding.registration_id+'/versions',
        {mode:'fork',instructions:bot.instructions || bot.role || bot.output || '',source:'manual',...(skills.length?{skills}:{})},fetcher)
        .catch(error=>{throw error.code!=='bot_storage_limit' && (error.status===400 || error.status===413)?failure(413,'bot_too_large_for_team'):error;});
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
  router.post('/token',handle(req=>client.refresh(req.userEmail,req.get('x-hub-token'))));
  router.post('/run',handle(req=>client.run(req.userEmail,req.body,req.get('x-hub-token'))));
  router.post('/share',handle(req=>client.share(req.userEmail,req.body,req.get('x-hub-token'))));
  return router;
}
module.exports={stoppedReply,hubStopReason,sharedRunTimeoutMs,SHARED_RUN_HISTORY,sharedSkills,materializeSharedSkills,createHubBotClient,createHubBotRouter,requestHub,fitReply,REPLY_BYTES,runLabel,withRunLabel,withoutRunLabel};
