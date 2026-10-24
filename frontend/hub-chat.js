/* Authenticated shared-channel transport. No native conversation fallback. */
(function(root){
  'use strict';
  function id(){ return root.crypto.randomUUID().replace(/-/g, ''); }
  var ERRORS = {file_too_large:'Images must be 8 MB or smaller.', team_storage_full:'This team has used its image storage. Delete older images to add more.',
    unsupported_file_type:'Choose a PNG, JPEG, GIF, or WebP image.', file_type_mismatch:'This file is not a valid image.',
    invalid_thread:'That thread is no longer available.', hub_unavailable:'The shared team service is unreachable. Retrying…'};
  function teamId(key){ var m = /^hub_([a-f0-9]{32})$/.exec(key || ''); return m ? m[1] : null; }
  async function call(method, path, body){
    var native = root.miaDesktop && root.miaDesktop.auth;
    var token = native ? root.MiaClerkDesktop.unwrap(await native.getSessionToken())
      : root.Clerk && root.Clerk.session ? await root.Clerk.session.getToken() : null;
    if(!token) throw new Error('Sign in to use shared teams.');
    var response = await root.fetch('/api/hub' + path, {method:method, credentials:'include',
      headers:{authorization:'Bearer ' + token, 'content-type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body)});
    var result = await response.json();
    if(!response.ok){
      var code = result && typeof result.error === 'string' ? result.error : '';
      var error = new Error(ERRORS[code] || (response.status === 404 || response.status === 403 ? 'This team or channel is no longer available to you.' : 'Hub request failed. Please retry.'));
      error.status=response.status; error.code=code; throw error;
    }
    return result;
  }
  async function localCall(method, path, body){
    var native=root.miaDesktop && root.miaDesktop.auth;
    var token=native ? root.MiaClerkDesktop.unwrap(await native.getSessionToken())
      : root.Clerk && root.Clerk.session ? await root.Clerk.session.getToken() : null;
    if(!token) throw new Error('Sign in to share bots.');
    var response=await root.fetch('/api/hub-bots'+path,{method:method,credentials:'include',
      headers:{'x-hub-token':token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    var result=await response.json();
    if(!response.ok) throw new Error('Bot request failed. Check your account and try again.');
    return result;
  }
  // Hub rows map onto Solo's timeline shape so the shared renderer, thread
  // panel and message actions treat both the same way.
  function message(row){
    var deleted=!!row.deleted;
    var file=row.attachment && !deleted ? {id:row.attachment.id, filename:row.attachment.filename || 'image',
      mimeType:row.attachment.mime_type, size:row.attachment.size, channelId:row.channel_id || null} : null;
    return {id:'hub-sequence-'+row.sequence, hubMessageId:row.id, hubMessage:true, hubAuthorId:row.author_id || null,
      hubBotRequest:row.author_type==='system' && row.author_id==='system:bot-request'?row.bot_request:null, system:row.author_type==='system',
      sender:row.author_type==='bot'?'hub-bot:'+row.author_id:row.author_email, hubAuthor:row.author_type==='bot'||row.author_type==='system'?null:row.author_email,
      nativeAgentName:row.author_type==='bot'?row.author_name:null, body:deleted ? 'Message deleted' : row.body, ts:row.created_at * 1000,
      threadRoot:row.thread_root_sequence ? 'hub-sequence-'+row.thread_root_sequence : null, deleted:deleted, pending:false,
      hubFile:file, attachments:[], nativeEvent:{sequence:row.sequence}};
  }
  // Upserts authoritative rows, replacing the sender's optimistic copy by its
  // client-generated id, and keeps unsent copies after the confirmed history.
  function merge(messages, rows){
    var list=(messages || []).slice();
    (rows || []).forEach(function(row){
      if(!row || !Number.isSafeInteger(row.sequence)) return;
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
  function feed(options){
    var cursor=0, stopped=false, failures=0, timer=null;
    function schedule(delay){ if(!stopped) timer=root.setTimeout(next, delay); }
    function next(){
      timer=null;
      if(stopped) return;
      options.call('GET','/v1/teams/'+options.teamId+'/events/after/'+cursor).then(function(result){
        if(stopped) return;
        failures=0;
        if(options.onStatus) options.onStatus('live');
        var first=cursor===0;
        if(Number.isSafeInteger(result.next)) cursor=result.next;
        if(result.reset || first) options.onReset(!!result.reset);
        if(result.events && result.events.length) options.onEvents(result.events);
        if(options.onTyping) options.onTyping(result.typing || []);
        // A Hub that answered without holding the request is polled gently.
        schedule(result.wait && !first ? 3000 : 0);
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
  var api = {id:id, teamId:teamId, call:call, localCall:localCall, message:message, merge:merge, validateText:validateText, feed:feed, fileUrl:fileUrl};
  root.MiaHubChat = api;
  if(typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
