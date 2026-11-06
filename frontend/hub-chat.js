/* Authenticated shared-channel transport. No native conversation fallback. */
(function(root){
  'use strict';
  function id(){ return root.crypto.randomUUID().replace(/-/g, ''); }
  // The one set of messages for Hub and shared-bot errors, used by chat,
  // Settings > Teams and the Admin Center alike.
  var SIGN_IN = 'Sign in to your Mia account to use companies.';
  var ERRORS = {
    sign_in_required:SIGN_IN, hub_sign_in_required:SIGN_IN, invalid_session:'Your sign-in has expired. Sign in to Mia again.',
    account_unavailable:SIGN_IN, account_not_linked:'Link this Mia install to your Mia account to use companies.',
    account_changed:'Your Mia account changed. Reopen the company to continue.',
    account_mismatch:'This company belongs to a different Mia account than the one signed in here.',
    hub_not_configured:'The company service is not set up on this install yet.',
    hub_unavailable:'Can’t reach the company service right now. Try again in a moment.',
    service_unavailable:'Can’t reach the company service right now. Try again in a moment.',
    lifecycle_unavailable:'The company service is restarting. Try again in a moment.',
    writes_paused:'The company service is briefly read-only for maintenance. Try again in a moment.',
    hub_identity_mismatch:'The company service answered for a different account. Sign in again.',
    rate_limit:'Too many requests. Wait a moment and try again.',
    body_too_large:'That is too large to send.', invalid_json:'That request could not be read. Try again.', json_required:'That request could not be read. Try again.',
    not_found:'This company, channel or item is no longer available to you.',
    company_email_required:'Request a company with a verified company email.',
    company_pending_or_active:'Your company already has a company or a pending request.',
    team_capacity:'The company service is at its company limit.', team_request_declined:'This company request was declined.',
    team_full:'This company has reached its 25-person limit.', seat_limit:'This company has reached its 25-person limit.',
    invite_limit:'The daily invitation limit has been reached.', already_member:'That person is already a member.',
    invalid_email:'Enter a valid email address.', invalid_name:'Names must be 1 to 120 characters.',
    invalid_role:'Choose Admin or Member.', invalid_member:'That person is not a member of this company.',
    invalid_members:'Choose people who are members of this company.',
    last_admin:'A company must keep at least one admin.',
    owner_protected:'Only the company owner can change their own role or leave.',
    owner_must_transfer:'You own this company. Make another admin the owner first.',
    owner_only:'Only the company owner can hand over ownership.',
    owner_needs_admin:'Make them an admin before making them the owner.',
    channel_name_taken:'A channel with that name already exists.', channel_archived:'This channel is archived.',
    channel_limit:'This company has reached its channel limit.', group_limit:'You have reached the group limit.', dm_limit:'You have reached the direct message limit.',
    not_channel:'That only works in a channel.', not_group:'That only works in a group.',
    cannot_invite_dm:'You can’t add people to a direct message.', cannot_leave_dm:'You can’t leave a direct message.',
    invalid_visibility:'Choose who can see this channel.', invalid_channel:'This channel is no longer available.',
    invalid_thread:'That thread is no longer available.', invalid_message:'Messages must be 1 to 16,000 characters.',
    invalid_sequence:'That message is no longer available.', reaction_limit:'This message already has 20 different reactions.', invalid_emoji:'That emoji can\u2019t be used as a reaction.', message_deleted:'That message was deleted.', invalid_pagination:'Older messages could not be loaded. Try again.',
    idempotency_conflict:'That was already sent with different content. Refresh and try again.',
    file_too_large:'Files must be 8 MB or smaller.', team_storage_full:'This company has used its file storage. Delete older files to add more.',
    unsupported_file_type:'Choose an image, PDF, Word, Excel, PowerPoint, CSV, text, Markdown or JSON file.',
    file_type_mismatch:'This file’s contents don’t match its type.', invalid_file:'That file could not be read.', invalid_attachment:'That attachment is no longer available.',
    storage_review_required:'File uploads are paused for this company while storage is reviewed.',
    bot_not_found:'That bot is no longer available on this computer.', bot_runtime_unavailable:'Bots can’t run on this install right now. Restart Mia.',
    reserved_bot_name:'That bot name is reserved. Rename the bot first.', bot_name_conflict:'This channel already has a bot with that name.',
    bot_limit:'This channel has reached its bot limit.', invalid_bot:'That bot is no longer available.',
    sharing_mode_required:'Choose linked or independent fork.', sharing_mode_immutable:'This bot’s sharing mode can’t be changed.',
    fork_has_no_solo_sync:'An independent fork doesn’t sync from Solo.', invalid_definition:'Bot instructions must be 1 to 100,000 characters, with at most 10 skills of up to 20,000 characters each.',
    bot_too_large_for_team:'This bot is too large for this company’s Hub. Shorten its instructions or skills, or ask an admin to update the Hub.',
    bot_storage_limit:'This company has used all 256 MB of its storage for bot instructions and skills. An admin can free space by approving or rejecting a waiting bot version, which removes older ones.',
    version_already_approved:'That version is already approved.', version_rejected:'That version was rejected.',
    version_superseded:'That version is no longer available. Refresh to see the latest.',
    approval_in_progress:'Another admin is reviewing this bot. Refresh in a moment.',
    dispatch_claimed:'Another participant is already running this.', dispatch_completed:'This run has already finished.',
    dispatch_expired:'This request expired. Send a new message to try again.', invalid_job:'That run is no longer available.'
  };
  function errorMessage(code, status){
    if(ERRORS[code]) return ERRORS[code];
    if(status === 401) return SIGN_IN;
    if(status === 403 || status === 404) return ERRORS.not_found;
    if(status >= 500 || !status) return ERRORS.hub_unavailable;
    return 'The company service could not do that' + (code ? ' (' + code + ')' : '') + '. Try again.';
  }
  function failure(code, status){ var error = new Error(errorMessage(code, status)); error.status = status; error.code = code; return error; }
  // Browser-session traffic is stored in the channel transport. Recognize it
  // without depending on the browser-session UI loading successfully, so a
  // partial or older client never turns control packets into chat messages.
  function isSpaceControl(body){
    return typeof body === 'string' && /^(?:\u2063)?mia-space\/1 \{/.test(body);
  }
  function teamId(key){ var m = /^hub_([a-f0-9]{32})$/.exec(key || ''); return m ? m[1] : null; }
  async function sessionToken(){
    var native = root.miaDesktop && root.miaDesktop.auth;
    var token = native ? root.MiaClerkDesktop.unwrap(await native.getSessionToken())
      : root.Clerk && root.Clerk.session ? await root.Clerk.session.getToken() : null;
    if(!token) throw failure('sign_in_required', 401);
    return token;
  }
  async function send(url, method, headers, body){
    var response;
    try {
      response = await root.fetch(url, {method:method, credentials:'include', headers:headers,
        body:body === undefined ? undefined : JSON.stringify(body)});
    } catch(_networkError) { throw failure('hub_unavailable', 0); }
    var result = await response.json().catch(function(){ return null; });
    if(!response.ok) throw failure(result && typeof result.error === 'string' ? result.error : '', response.status);
    return result;
  }
  async function call(method, path, body){
    var token = await sessionToken();
    return send('/api/hub' + path, method, {authorization:'Bearer ' + token, 'content-type':'application/json'}, body);
  }
  async function localCall(method, path, body){
    var token = await sessionToken();
    return send('/api/hub-bots' + path, method, {'x-hub-token':token, 'content-type':'application/json'}, body);
  }
  // Hub rows map onto Solo's timeline shape so the shared renderer, thread
  // panel and message actions treat both the same way.
  function message(row){
    var deleted=!!row.deleted;
    // A bot reply's last line says where it ran; see RUN_LABEL_MARK in
    // backend/hub-bot-client.js.
    var runAt=row.author_type==='bot' && !deleted && typeof row.body==='string' ? row.body.lastIndexOf('\n\n\u2063') : -1;
    var file=row.attachment && !deleted ? {id:row.attachment.id, filename:row.attachment.filename || 'image',
      mimeType:row.attachment.mime_type, size:row.attachment.size, channelId:row.channel_id || null} : null;
    return {id:'hub-sequence-'+row.sequence, hubMessageId:row.id, hubMessage:true, hubAuthorId:row.author_id || null,
      hubBotRequest:row.author_type==='system' && row.author_id==='system:bot-request'?row.bot_request:null,
      hubWorkflowApproval:row.author_type==='system' && row.author_id==='system:workflow-approval' && row.workflow_approval?row.workflow_approval:null, system:row.author_type==='system',
      // The Hub stores a "<bot> joined" line under that bot's own id.
      hubBotJoined:row.author_type==='system' && row.author_id==='system:bot-joined'?String(row.id):null,
      sender:row.author_type==='bot'?'hub-bot:'+row.author_id:row.author_email, hubAuthor:row.author_type==='bot'||row.author_type==='system'?null:row.author_email,
      nativeAgentName:row.author_type==='bot'?row.author_name:null, body:deleted ? 'Message deleted' : (runAt<0 ? row.body : row.body.slice(0,runAt)), hubRunLabel:runAt<0 ? '' : row.body.slice(runAt+3), ts:row.created_at * 1000,
      threadRoot:row.thread_root_sequence ? 'hub-sequence-'+row.thread_root_sequence : null, deleted:deleted, pending:false,
      hubFile:file, attachments:[], nativeEvent:{sequence:row.sequence}, reactions:deleted ? null : reactionMap(row.reactions)};
  }
  // Upserts authoritative rows, replacing the sender's optimistic copy by its
  // client-generated id, and keeps unsent copies after the confirmed history.
  function merge(messages, rows){
    var list=(messages || []).filter(function(item){ return !isSpaceControl(item && item.body); });
    (rows || []).forEach(function(row){
      if(!row || !Number.isSafeInteger(row.sequence) || isSpaceControl(row.body)) return;
      var next=message(row), index=-1;
      for(var i=0;i<list.length;i++){
        if(list[i].id===next.id || (list[i].hubLocal && list[i].hubMessageId===next.hubMessageId)){ index=i; break; }
      }
      if(index>=0) list[index]=next; else list.push(next);
    });
    var confirmed=list.filter(function(m){return !m.hubLocal;}).sort(function(a,b){return a.nativeEvent.sequence-b.nativeEvent.sequence;});
    return confirmed.concat(list.filter(function(m){return m.hubLocal;}));
  }
  function validateText(text, allowEmpty){
    if(!allowEmpty && !String(text || '').trim()) throw new Error('Write a message first.');
    if(new TextEncoder().encode(String(text || '')).length > 16000) throw new Error('Shared messages must be 16,000 bytes or fewer.');
    return String(text || '');
  }
  // One live connection per team: the Hub holds each request until something
  // changes, so a quiet team costs one request about every 20 seconds.
  // The Hub lists a message's reactions as [{emoji, user_ids}]; the app keeps
  // them as {emoji: [who]}, the same shape as Solo's, so one renderer serves both.
  function reactionMap(list){
    var map={};
    (Array.isArray(list)?list:[]).forEach(function(item){
      if(item && typeof item.emoji==='string' && Array.isArray(item.user_ids) && item.user_ids.length) map[item.emoji]=item.user_ids.map(String);
    });
    return Object.keys(map).length ? map : null;
  }
  function feed(options){
    var cursor=0, synced=false, stopped=false, failures=0, timer=null;
    function schedule(delay){ if(!stopped) timer=root.setTimeout(next, delay); }
    function next(){
      timer=null;
      if(stopped) return;
      options.call('GET','/v1/teams/'+options.teamId+'/events/after/'+cursor).then(function(result){
        if(stopped) return;
        failures=0;
        if(options.onStatus) options.onStatus('live');
        // Cursor 0 returns no history, so a team's first events need a reload too.
        var first=!synced || (cursor===0 && result.next>0);
        synced=true;
        if(Number.isSafeInteger(result.next)) cursor=result.next;
        if(result.reset || first) options.onReset(!!result.reset);
        if(result.events && result.events.length) options.onEvents(result.events);
        if(options.onTyping) options.onTyping(result.typing || []);
        // A Hub that answered without holding the request is polled gently.
        // So is a team with no events yet: cursor 0 never waits.
        schedule(cursor===0 || (result.wait && !first) ? 3000 : 0);
      }).catch(function(error){
        if(stopped) return;
        failures++;
        if(options.onStatus) options.onStatus('offline', error, failures);
        schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(failures, 5))));
      });
    }
    schedule(0);
    return {stop:function(){ stopped=true; if(timer) root.clearTimeout(timer); }, cursor:function(){ return cursor; }};
  }
  var files={};
  // Images arrive as authenticated JSON; each becomes a local object URL once.
  function fileUrl(teamId, file, onReady){
    if(!file || !/^[a-f0-9]{32}$/.test(file.id || '') || !/^[a-f0-9]{32}$/.test(file.channelId || '')) return null;
    var cached=files[file.id];
    if(cached && cached.url) return cached.url;
    if(cached) { cached.waiters.push(onReady); return null; }
    cached=files[file.id]={url:null, waiters:[onReady]};
    call('GET','/v1/teams/'+teamId+'/channels/'+file.channelId+'/files/'+file.id).then(function(result){
      var binary=root.atob(result.file.contentBase64), bytes=new Uint8Array(binary.length);
      for(var i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
      cached.url=root.URL.createObjectURL(new root.Blob([bytes], {type:result.file.mime_type}));
    }).catch(function(){ delete files[file.id]; }).then(function(){
      var waiters=cached.waiters; cached.waiters=[];
      waiters.forEach(function(callback){ if(typeof callback==='function') callback(); });
    });
    return null;
  }
  // A team's bots, grouped by the channel they were shared to:
  // [{channel, bots}]. One team-wide read where the Hub has it; an older
  // Hub answers 404 and the bots are read channel by channel instead.
  function teamBots(teamId){
    var base='/v1/teams/'+teamId;
    return call('GET',base+'/bots').then(function(result){
      var byChannel={}, list=[];
      (result.bots||[]).forEach(function(bot){
        var entry=byChannel[bot.channel_id];
        if(!entry){
          entry=byChannel[bot.channel_id]={channel:{id:bot.channel_id,name:bot.channel_name,kind:bot.channel_kind,visibility:bot.channel_visibility},bots:[]};
          list.push(entry);
        }
        entry.bots.push(bot);
      });
      return list;
    },function(error){
      if(!error || error.status!==404) throw error;
      return call('GET',base+'/channels').then(function(result){
        return Promise.all((result.channels||[]).map(function(channel){
          return call('GET',base+'/channels/'+channel.id+'/bots').then(function(bots){return {channel:channel,bots:bots.bots||[]};},
            function(){return {channel:channel,bots:[]};});
        }));
      });
    });
  }
  var api = {id:id, teamId:teamId, call:call, localCall:localCall, message:message, merge:merge, isSpaceControl:isSpaceControl, validateText:validateText, feed:feed, fileUrl:fileUrl, teamBots:teamBots, reactionMap:reactionMap};
  root.MiaHubChat = api;
  if(typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
