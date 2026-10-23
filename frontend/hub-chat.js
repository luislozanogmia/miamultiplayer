/* Authenticated shared-channel transport. No native conversation fallback. */
(function(root){
  'use strict';
  function id(){ return root.crypto.randomUUID().replace(/-/g, ''); }
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
    if(!response.ok){ var error = new Error(response.status === 404 || response.status === 403 ? 'This team or channel is no longer available to you.' : 'Hub request failed. Please retry.'); error.status=response.status; throw error; }
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
  function message(row){
    return {id:'hub-sequence-'+row.sequence, hubMessageId:row.id, hubMessage:true, hubBotRequest:row.author_type==='system' && row.author_id==='system:bot-request'?row.bot_request:null, system:row.author_type==='system', sender:row.author_type==='bot'?'hub-bot:'+row.author_id:row.author_email, hubAuthor:row.author_type==='bot'||row.author_type==='system'?null:row.author_email, nativeAgentName:row.author_type==='bot'?row.author_name:null, body:row.body, ts:row.created_at * 1000,
      threadRoot:null, pending:false, attachments:[], nativeEvent:{sequence:row.sequence}};
  }
  function validateText(text){
    if(!String(text || '').trim()) throw new Error('Write a message first.');
    if(new TextEncoder().encode(text).length > 4000) throw new Error('Shared messages must be 4,000 bytes or fewer.');
    return text;
  }
  var api = {id:id, teamId:teamId, call:call, localCall:localCall, message:message, validateText:validateText};
  root.MiaHubChat = api;
  if(typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
