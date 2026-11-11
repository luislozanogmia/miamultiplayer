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
  const marketBot=/\/market\/bots(?:\/[a-f0-9]{32})?$/.test(path);
  const definitionRoute=marketBot || /(?:\/versions|\/definition|\/claim)$/.test(path);
  const response=await fetcher(origin+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(definitionRoute?60000:15000)});
  const chunks=[];let length=0;
  const responseLimit = method==='GET' && /\/versions$/.test(path) ? 5*DEFINITION_RESPONSE_BYTES
    : marketBot || /\/(?:definition|claim)$/.test(path) ? DEFINITION_RESPONSE_BYTES : RESPONSE_BYTES;
  for await(const chunk of response.body) {length+=chunk.length;if(length>responseLimit) throw failure(503,'hub_unavailable');chunks.push(Buffer.from(chunk));}
  const result=JSON.parse(Buffer.concat(chunks));
  if(!response.ok) throw failure(response.status,['not_found','reserved_bot_name','bot_name_conflict','bot_limit','idempotency_conflict','dispatch_claimed','dispatch_completed','dispatch_expired','dispatch_cancelled','invalid_claim','bot_storage_limit','bot_name_taken','bot_access_denied','reply_exists'].includes(result.error)?result.error:'hub_request_failed');
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
const STOP_LABELS={time_limit:'time limit',stopped:'stopped',sign_in_expired:'sign-in expired',claim_gone:'claim taken',owner_changed:'account changed',
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
const INTERRUPTED_REPLY='This bot was interrupted before its reply was saved. Send a new message to try again.';
const WORKING_REPLY='Working on it…', STOPPED_REPLY='Stopped.';
// The Hub lets a marketplace reply change for ten minutes, so a run ends before that.
const MARKET_RUN_MS=9*60*1000;
// Who may use a shared bot: everyone in the channel it joins, or chosen teams.
function shareAccess(value) {
  const teams=value && value.kind==='teams' && Array.isArray(value.team_ids) ? value.team_ids.filter(id=>/^[a-f0-9]{32}$/.test(id||'')) : [];
  return teams.length?{kind:'teams',team_ids:teams}:{kind:'channel'};
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
  const inFlight=new Map(), runScopes=new Map(), freshTokens=new Map(), selections=new Map(), marketStops=new Map();
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
  // The message a bot is answering and the channel's messages up to it.
  async function asked(hub,s,triggerSequence) {
    const triggerPage=await hub('GET',base(s)+'/messages/after/'+(triggerSequence-1));
    const trigger=(triggerPage.messages||[]).find(row=>row.sequence===triggerSequence);
    const history=[];let after=Math.max(0,triggerSequence-SHARED_RUN_HISTORY);
    for(let page=0;page<6 && after<triggerSequence;page++) {
      const result=await hub('GET',base(s)+'/messages/after/'+after);
      history.push(...(result.messages||[]).filter(row=>row.sequence<=triggerSequence)
        .map(row=>row.author_type==='bot'?{...row,body:withoutRunLabel(row.body)}:row));
      if(!result.next || result.next<=after) break;
      after=result.next;
    }
    return {trigger,history};
  }
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
      const {trigger,history}=await asked(hub,s,claim.triggerSequence);
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
  // A marketplace bot runs on the Mia of whoever asked, with the company's
  // latest version of it: nobody approves a version. The reply is posted as
  // "working" first, so the channel sees it started and the Hub refuses a
  // second run for the same message, then changed to the answer.
  async function answer(s,run,initialToken) {
    const token=()=>freshTokens.get(accountKey(s))||initialToken;
    const replies=base(s)+'/market-bots/'+run.botId+'/replies';
    const controller=new AbortController();
    const stopRun=code=>{if(!controller.signal.aborted) controller.abort(stopError(code));};
    const hub=(method,route,body)=>withFreshToken(s,initialToken,used=>requestHub(s.origin,used,method,route,body,fetcher),controller.signal);
    const timeout=setTimeout(()=>stopRun('time_limit'),Math.min(runTimeoutMs,MARKET_RUN_MS));
    marketStops.set(run.replyId,()=>stopRun('stopped'));
    let posted=false,text,status='done',skillFilesCleanup=()=>{};
    try {
      if(!localIdentityValid(s)) throw stopError('owner_changed');
      const {bot,definition}=await hub('GET','/v1/teams/'+s.teamId+'/market/bots/'+run.botId);
      if(!bot || !definition || !Number.isSafeInteger(definition.version) || typeof definition.instructions!=='string') throw stopError('hub_refused');
      const {trigger,history}=await asked(hub,s,run.triggerSequence);
      if(!trigger || trigger.author_type!=='user' || trigger.author_id!==s.subject) throw stopError('invalid_trigger');
      journal.marketRun(s,run.replyId,run.botId);
      await hub('POST',replies,{id:run.replyId,trigger_sequence:run.triggerSequence,body:WORKING_REPLY,status:'working'});
      posted=true;
      if(controller.signal.aborted) throw controller.signal.reason;
      const preparedSkills=materializeSharedSkills(sharedSkills(definition.skills));
      skillFilesCleanup=preparedSkills.cleanup;
      const currentBot={id:'shared-'+run.botId+'-v'+definition.version, registrationId:run.botId, name:definition.name || bot.name || 'Shared bot', instructions:definition.instructions, bundledSkills:preparedSkills.skills};
      const attached=await triggerFile(s,trigger,token);
      const reply=await runBot({owner:s.owner,bot:currentBot,trigger,history:history.filter(row=>row.sequence<run.triggerSequence),
        channel:{teamId:s.teamId,teamName:s.teamName,channelId:s.channelId,privateChat:false},signal:controller.signal,modelSelection:run.selection||null,...attached});
      if(controller.signal.aborted) throw controller.signal.reason;
      text=withRunLabel(typeof reply==='string'?reply:reply && reply.text,runLabel(reply && reply.provider,s.memberName));
      if(typeof text!=='string' || !text.trim()) throw stopError('bot_failed');
    } catch(error) {
      // Mia is closing: the journal keeps the reply, and the next poll closes it.
      if(isClosing()) {log('run left for later','closing',run.replyId);return;}
      const reason=controller.signal.aborted ? controller.signal.reason.reason : error && error.reason || 'bot_failed';
      log('run stopped',reason,run.replyId);
      if(!posted) return;
      text=reason==='stopped'?STOPPED_REPLY:stoppedReply(reason);status='failed';
    } finally {clearTimeout(timeout);marketStops.delete(run.replyId);skillFilesCleanup();}
    await closeReply(s,run.replyId,run.botId,text,status,token());
  }
  // The Hub lets a reply change for ten minutes; after that it stays as it is.
  async function closeReply(s,replyId,botId,text,status,token) {
    try {
      await withFreshToken(s,token,used=>requestHub(s.origin,used,'PATCH',base(s)+'/market-bots/'+botId+'/replies/'+replyId,{body:text,status},fetcher));
    } catch(error) {log('reply not updated',error.reason||hubStopReason(error),replyId);}
    journal.discard(s,replyId);
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
  // The id this bot has in the company's marketplace: a bot downloaded from
  // that company keeps the company's id, and one shared before keeps its own.
  function marketId(s,bot) {
    const source=bot.marketSource;
    if(source && source.teamId===s.teamId && /^[a-f0-9]{32}$/.test(source.botId||'')) return source.botId;
    const row=journal.copies(s.owner,s.teamId,String(bot.id))[0];
    return row?row.registration_id:null;
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
        if(run.claim_id==='market') {
          // Mia closed in the middle of this reply; it can't be picked up again.
          if(!inFlight.has(runKey(scope,run.job_id))) await closeReply(scope,run.job_id,run.registration_id,INTERRUPTED_REPLY,'failed',token);
          continue;
        }
        if(!allowed.has(run.registration_id)) {journal.discard(scope,run.job_id);continue;}
        if(inFlight.has(runKey(scope,run.job_id))) continue;
        if(run.state==='started') {
          if(isHeld(run.job_id)) continue;
          journal.saveReply(scope,run.job_id,INTERRUPTED_REPLY);
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
    // Adding a bot to a channel puts it in the company's marketplace, where it
    // is live at once: nobody approves it. The company gets its own copy of
    // the instructions and of its skills' text; automations and memories stay
    // in Solo. A bot the company already has is only placed in the channel.
    async share(owner,input,token) {
      // Personal agents are private to their owner and never leave the machine.
      if(isPrivateAgent(String(input.localBotId||''))) throw failure(403,'agent_not_shareable');
      const scope=await context(owner,input,token);
      const bot=getBot(String(input.localBotId||''),scope.owner);
      if(!bot) throw failure(404,'bot_not_found');
      const known=marketId(scope,bot);
      if(known) {
        const placed=await requestHub(scope.origin,token,'PUT',base(scope)+'/market-bots/'+known,{},fetcher)
          .catch(error=>{if(error.status===404) return null;throw error;});
        if(placed) {journal.bind(scope,bot,known);return {bot:placed.bot||{id:known,name:bot.name},placed:true};}
      }
      const binding=journal.bind(scope,bot,known);
      // A copy from another company brings the skills its owner reviewed.
      const skills=sharedSkills(Array.isArray(input.skills)?input.skills:bundleSkills(bot));
      const result=await requestHub(scope.origin,token,'POST','/v1/teams/'+scope.teamId+'/market/bots',
        {id:binding.registration_id,name:bot.name,avatar_color:bot.avatarColor||'',instructions:bot.instructions || bot.role || bot.output || '',
          skills,tags:[],channel_id:scope.channelId,access:shareAccess(input.access)},fetcher)
        .catch(error=>{throw error.code!=='bot_storage_limit' && error.code!=='bot_name_taken' && (error.status===400 || error.status===413)?failure(413,'bot_too_large_for_team'):error;});
      if(!result.bot || result.bot.id!==binding.registration_id) throw failure(503,'hub_identity_mismatch');
      return {bot:result.bot};
    },
    // An edit made inside a company reaches that company's copy of the bot at
    // once, for everyone, unless the copy already says the same. Only an owner
    // of the company bot can change it. An edit made in Solo never calls this,
    // so the company copy stays as shared.
    async update(owner,input,token) {
      owner=String(owner||'').trim().toLowerCase();
      if(!owner || !isOwnerActive(owner)) throw failure(403,'account_unavailable');
      const teamId=String(input&&input.teamId||''),bot=getBot(String(input&&input.localBotId||''),owner);
      if(!bot) throw failure(404,'bot_not_found');
      const row=journal.copies(owner,teamId,String(bot.id))[0];
      const botId=marketId({owner,teamId},bot);
      if(!botId) return {updated:[]};
      // No channel is involved here; this only checks the person is in the company.
      const scope=await context(owner,{teamId,channelId:row?row.channel_id:botId},token);
      if(row && (row.origin!==scope.origin || row.subject!==scope.subject)) return {updated:[]};
      const path='/v1/teams/'+teamId+'/market/bots/'+botId;
      const current=await requestHub(scope.origin,token,'GET',path,undefined,fetcher).catch(error=>{if(error.status===404) return null;throw error;});
      if(!current || !current.bot || !current.bot.can_publish || !current.definition) return {updated:[]};
      const instructions=bot.instructions || bot.role || bot.output || '',skills=sharedSkills(bundleSkills(bot));
      const was=current.definition;
      if(was.name===bot.name && was.instructions===instructions && JSON.stringify(sharedSkills(was.skills))===JSON.stringify(skills)) return {updated:[]};
      const published=await requestHub(scope.origin,token,'POST',path+'/versions',
        {name:bot.name,avatar_color:bot.avatarColor||was.avatar_color||'',instructions,skills,tags:Array.isArray(was.tags)?was.tags:[]},fetcher);
      return {updated:[{botId,version:published.version}]};
    },
    // The person asked a marketplace bot in a channel: their own Mia answers.
    // -> {replyId}, the id the reply has in the channel.
    async ask(owner,input,token) {
      if(typeof runBot!=='function') throw failure(503,'bot_runtime_unavailable');
      if(!/^[a-f0-9]{32}$/.test(input&&input.botId||'') || !/^[a-f0-9]{32}$/.test(input.replyId||'')
        || !Number.isSafeInteger(input.triggerSequence) || input.triggerSequence<1) throw failure(400,'invalid_bot');
      const scope=await context(owner,input,token),key=runKey(scope,input.replyId);
      if(inFlight.has(key)) return {replyId:input.replyId};
      if(inFlight.size>=2) throw failure(429,'bots_busy');
      freshTokens.set(accountKey(scope),token);
      const selection=input.modelSelection && typeof input.modelSelection==='object' ? {provider:String(input.modelSelection.provider||''),model:String(input.modelSelection.model||''),
        reasoningEffort:input.modelSelection.reasoningEffort,speed:input.modelSelection.speed,fast:input.modelSelection.fast===true} : null;
      const run={replyId:input.replyId,botId:input.botId,triggerSequence:input.triggerSequence,selection};
      runScopes.set(key,scope);
      inFlight.set(key,Promise.resolve().then(()=>answer(scope,run,token)).catch(error=>log('run failed',error && error.reason || 'unexpected',run.replyId)).finally(()=>{
        inFlight.delete(key);runScopes.delete(key);
        if(!accountRunning(scope)) freshTokens.delete(accountKey(scope));
      }));
      return {replyId:input.replyId};
    },
    // Stop on a marketplace bot's reply that this computer is working on.
    stop(owner,input) {
      owner=String(owner||'').trim().toLowerCase();
      const key=[...runScopes.entries()].find(([key,s])=>s.owner===owner && key.endsWith(':'+String(input&&input.replyId||'')));
      const stopRun=key && marketStops.get(input.replyId);
      if(stopRun) stopRun();
      return {stopped:!!stopRun};
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
  router.post('/ask',handle(req=>client.ask(req.userEmail,req.body,req.get('x-hub-token'))));
  router.post('/stop',handle(req=>client.stop(req.userEmail,req.body)));
  router.post('/update',handle(req=>client.update(req.userEmail,req.body,req.get('x-hub-token'))));
  return router;
}
module.exports={stoppedReply,hubStopReason,sharedRunTimeoutMs,SHARED_RUN_HISTORY,sharedSkills,materializeSharedSkills,createHubBotClient,createHubBotRouter,requestHub,fitReply,REPLY_BYTES,runLabel,withRunLabel,withoutRunLabel};
