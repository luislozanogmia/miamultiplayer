/* Remote link, the computer's side. While Mia is open here, a phone the
   person paired can use AI mode on this computer from anywhere: the phone's
   requests arrive through the Hub, sealed, and are answered by this Mia. Only
   what AI mode itself calls is answered; nothing else on this computer is
   reachable from the phone. Nothing runs until a phone is paired. */
(function(root, factory){
  var core = typeof module === 'object' && module.exports ? require('./remote-link-core.js') : root.MiaRemoteLink;
  var api = factory(root, core);
  if(typeof module === 'object' && module.exports) module.exports = api; else root.MiaRemoteHostFactory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root, Link){
  'use strict';
  var ID = '[A-Za-z0-9_.:%-]{1,120}';
  // [method, path, whether the chat in the path must be one this phone opened]
  var ALLOWED = [
    ['POST', /^\/api\/conversations\/ai-mode$/],
    ['POST', new RegExp('^/api/conversations/(' + ID + ')/events$'), true],
    ['GET', new RegExp('^/api/conversations/(' + ID + ')/events\\?latest=true&limit=100$'), true],
    ['GET', new RegExp('^/api/conversations/(' + ID + ')/dispatches/active$'), true],
    ['POST', new RegExp('^/api/conversations/(' + ID + ')/dispatches/' + ID + '/stop$'), true],
    ['POST', /^\/api\/ai-mode\/(?:seed|speech)$/],
    ['GET', /^\/api\/ai-mode\/voices$/],
    ['GET', new RegExp('^/api/ai-mode/handoffs\\?conversation=(' + ID + ')$'), true],
    ['GET', /^\/api\/ai-mode\/images\?q=[^&#]{1,600}$/],
    ['GET', /^\/api\/ai-mode\/image\?u=[^&#]{1,3000}$/],
    ['GET', /^\/api\/ai-mode\/page\?since=[0-9]{1,16}$/],
    ['POST', new RegExp('^/api/ask-before-do/' + ID + '$')]
  ];
  var SOCKET_PATH = '/api/conversations/ws', MAX_SOCKETS = 8, MAX_ANSWER_BYTES = 6 * 1024 * 1024;
  var SIGN_IN_RETRY_MS = 60000, UNAVAILABLE_RETRY_MS = 5 * 60000;

  function randomHex(bytes){
    var out = '', values = root.crypto.getRandomValues(new Uint8Array(bytes));
    for(var i = 0; i < values.length; i++) out += (values[i] < 16 ? '0' : '') + values[i].toString(16);
    return out;
  }
  function json(status, value){ return {status:status, type:'application/json', bytes:Link.utf8(JSON.stringify(value))}; }
  function rule(device, method, path, chats){
    if(typeof path !== 'string' || path.length > 4000 || path.indexOf('..') >= 0) return false;
    for(var i = 0; i < ALLOWED.length; i++){
      var match = ALLOWED[i][0] === method && ALLOWED[i][1].exec(path);
      if(match){
        if(!ALLOWED[i][2]) return true;
        try { return !!(chats[device] && chats[device][decodeURIComponent(match[1])]); }
        catch(_badPath) { return false; }
      }
    }
    return false;
  }

  // deps: hub(method, path, body) calls the Hub as the signed-in person;
  // local({method, path, type, body}) asks this Mia and gives {status, type, bytes};
  // socket() opens this Mia's live chat line; store.load()/save(state) keep the
  // pairing on this computer; changed() says the list of phones may have changed.
  function createHost(deps){
    var state = null, running = false, halted = false, status = 'off', retry = null;
    var pending = [], links = {}, senders = {}, sockets = {}, chats = {}, staleAt = {};
    var now = deps.now || Date.now;

    async function ready(){
      if(state) return state;
      var kept = await deps.store.load();
      state = kept && /^[a-f0-9]{32}$/.test(kept.host || '') && kept.devices && typeof kept.devices === 'object' ? kept : null;
      if(!state){ state = {host:randomHex(16), devices:{}}; await deps.store.save(state); }
      return state;
    }
    function base(){ return '/v1/remote/hosts/' + state.host; }
    function wanted(){
      pending = pending.filter(function(p){ return p.expiresAt > now(); });
      return !!state && (Object.keys(state.devices).length > 0 || pending.length > 0);
    }
    function alive(){ return running && !halted && wanted(); }
    function set(next){ if(status !== next){ status = next; deps.changed(); } }

    function senderFor(device){
      return senders[device] || (senders[device] = Link.sender(
        function(item){ return Link.sealItem(links[device], item); },
        function(frames){ return deps.hub('POST', base() + '/send', {device:device, frames:frames}); },
        function(){ return !halted && !!links[device]; },
        function(){ quiet(device); }));
    }
    function push(device, item){ if(links[device]) senderFor(device).push(item); }
    // The phone went away: stop feeding it and let its open lines go.
    function quiet(device){
      var open = sockets[device] || {};
      sockets[device] = {};
      Object.keys(open).forEach(function(id){ try { open[id].onclose = null; open[id].close(); } catch(_closed) {} });
      if(senders[device]) senders[device].clear();
    }
    function drop(device){
      quiet(device);
      delete links[device]; delete senders[device]; delete sockets[device]; delete chats[device];
      if(state.devices[device]){ delete state.devices[device]; return true; }
      return false;
    }
    async function linkFor(device){
      if(links[device]) return links[device];
      var kept = state.devices[device];
      if(!kept) return null;
      return links[device] = Link.channel(await Link.importKey(kept.secret), device, 'computer', now, kept.seen || 0);
    }

    async function answer(device, head, payload){
      var result;
      try {
        if(!rule(device, head.method, head.path, chats)) result = json(404, {error:'not_found'});
        else {
          result = await deps.local({method:head.method, path:head.path, type:head.type || '', body:payload.length ? payload : null});
          if(result.bytes.length > MAX_ANSWER_BYTES) result = json(502, {error:'answer_too_large'});
          else if(head.path === '/api/conversations/ai-mode' && result.status < 300){
            try {
              var id = JSON.parse(Link.text(result.bytes)).conversation.id;
              if(typeof id === 'string') (chats[device] = chats[device] || {})[id] = true;
            } catch(_noChat) {}
          }
          else if(head.path.startsWith('/api/ai-mode/handoffs?conversation=') && result.status < 300){
            try {
              var bots = JSON.parse(Link.text(result.bytes)).bots;
              if(Array.isArray(bots)) bots.slice(0, 20).forEach(function(bot){
                if(bot && typeof bot.conversationId === 'string' && bot.conversationId.length <= 120)
                  (chats[device] = chats[device] || {})[bot.conversationId] = true;
              });
            } catch(_noBots) {}
          }
        }
      } catch(_failed) { result = json(502, {error:'computer_unavailable'}); }
      var parts = Link.chunks(result.bytes);
      parts.forEach(function(part, i){
        push(device, {head:{t:'res', id:head.id, status:result.status, type:result.type, more:i < parts.length - 1}, payload:part});
      });
    }
    function line(device, head, payload){
      var open = sockets[device] = sockets[device] || {}, id = String(head.id);
      if(head.op === 'open'){
        if(open[id] || head.path !== SOCKET_PATH || Object.keys(open).length >= MAX_SOCKETS){
          push(device, {head:{t:'ws', id:id, op:'close'}}); return;
        }
        var socket;
        try { socket = deps.socket(); } catch(_noSocket) { push(device, {head:{t:'ws', id:id, op:'close'}}); return; }
        open[id] = socket;
        socket.onopen = function(){ push(device, {head:{t:'ws', id:id, op:'open'}}); };
        socket.onmessage = function(message){
          if(typeof message.data === 'string') push(device, {head:{t:'ws', id:id, op:'msg'}, lines:[message.data], size:message.data.length});
        };
        socket.onclose = function(){ if(open[id] === socket){ delete open[id]; push(device, {head:{t:'ws', id:id, op:'close'}}); } };
        return;
      }
      var live = open[id];
      if(!live) return;
      if(head.op === 'close'){ delete open[id]; try { live.onclose = null; live.close(); } catch(_closed) {} return; }
      if(head.op !== 'send') return;
      // The phone only ever asks to follow a chat; nothing else is passed on.
      try {
        var said = JSON.parse(Link.text(payload));
        if(said && said.type === 'subscribe' && typeof said.conversationId === 'string' &&
           chats[device] && chats[device][said.conversationId]) live.send(JSON.stringify({type:'subscribe',
          conversationId:said.conversationId, afterSequence:Number.isSafeInteger(said.afterSequence) && said.afterSequence > 0 ? said.afterSequence : 0}));
      } catch(_notJson) {}
    }
    function handle(device, opened){
      var head = opened.head;
      if(head.t === 'hello') push(device, {head:{t:'hello'}});
      else if(head.t === 'req') answer(device, head, opened.payload);
      else if(head.t === 'ws') line(device, head, opened.payload);
    }

    // A frame from a phone this computer does not know yet is the first one
    // after pairing: the pairing whose key opens it is the one that phone used.
    async function adopt(device, data){
      for(var i = 0; i < pending.length; i++){
        var link = Link.channel(pending[i].key, device, 'computer', now), opened = await link.open(data);
        if(!opened || opened.stale) continue;
        state.devices[device] = {secret:pending[i].secret, seen:opened.head.n};
        try { await deps.store.save(state); }
        catch(error) { delete state.devices[device]; throw error; }
        pending.splice(i, 1);
        links[device] = link;
        deps.changed();
        return opened;
      }
      return null;
    }
    async function take(reply){
      var live = {}, changed = false;
      (Array.isArray(reply.devices) ? reply.devices : []).forEach(function(d){ live[d.id] = d.online === true; });
      Object.keys(state.devices).forEach(function(id){ if(!(id in live) && drop(id)) changed = true; });
      Object.keys(links).forEach(function(id){ if(live[id] === false && sockets[id] && Object.keys(sockets[id]).length) quiet(id); });
      if(changed){ await deps.store.save(state); deps.changed(); }
      var frames = Array.isArray(reply.frames) ? reply.frames : [];
      for(var i = 0; i < frames.length; i++){
        var device = frames[i].device, link = await linkFor(device), before = link ? link.lastSeen() : 0;
        var opened = link ? await link.open(frames[i].data) : await adopt(device, frames[i].data);
        if(!opened) continue;
        if(opened.stale){
          // Tell the phone at most now and then, so it can say its clock is off.
          if(!(now() - (staleAt[device] || 0) < 10000)){ staleAt[device] = now(); push(device, {head:{t:'stale'}}); }
          continue;
        }
        // The Hub repeats an unconfirmed frame after a computer restart. Keep
        // the authenticated sequence before executing a request, so it cannot
        // execute twice if this app closes before acknowledging the frame.
        var kept = state.devices[device];
        if(kept && kept.seen !== opened.head.n){
          kept.seen = opened.head.n;
          try { await deps.store.save(state); }
          catch(error){ kept.seen = before; link.restoreSeen(before); throw error; }
        }
        handle(device, opened);
      }
    }
    function ended(error){
      var signIn = error && error.status === 401;
      set(signIn ? 'signin' : 'unavailable');
      if(!halted) retry = root.setTimeout(function(){ retry = null; start().catch(function(){}); }, signIn ? SIGN_IN_RETRY_MS : UNAVAILABLE_RETRY_MS);
    }
    async function start(){
      await ready();
      if(running || halted || retry || !wanted()) return;
      running = true; set('on');
      Link.read(function(body){ return deps.hub('POST', base() + '/poll', body); }, take, alive, ended).then(function(){
        running = false;
        if(status === 'on') set('off');
        if(!halted && !retry && wanted()) start().catch(function(){});
      });
    }

    return {
      start:start,
      stop:function(){ halted = true; if(retry) root.clearTimeout(retry); Object.keys(links).forEach(quiet); },
      status:function(){ return status; },
      show:Link.showCode,
      // The code to type on the phone, good for a few minutes and for one phone.
      pair:async function(){
        await ready();
        var code = Link.newCode(), made = await Link.derive(code);
        var reply = await deps.hub('POST', base() + '/pairings', {claim:made.claim});
        pending.push({secret:made.secret, key:await Link.importKey(made.secret), expiresAt:reply.expiresAt * 1000});
        if(retry){ root.clearTimeout(retry); retry = null; }
        await start();
        return {code:code, expiresAt:reply.expiresAt * 1000};
      },
      phones:async function(){
        await ready();
        return (await deps.hub('GET', base() + '/devices')).devices || [];
      },
      remove:async function(device){
        await ready();
        try { await deps.hub('DELETE', base() + '/devices/' + device); }
        catch(error) { if(!error || error.status !== 404) throw error; }
        if(drop(device)) await deps.store.save(state);
        deps.changed();
      }
    };
  }

  // In the app: this Mia's own calls, and the person's own Hub sign-in.
  function install(){
    function space(){ try { return root.miaAiModeHost.workspace() || 'solo'; } catch(_none) { return 'solo'; } }
    async function kept(method, body){
      var response = await root.fetch('/api/remote-link/state', {method:method, credentials:'include',
        headers:{'Accept':'application/json', 'Content-Type':'application/json'}, body:body ? JSON.stringify(body) : undefined});
      if(!response.ok) throw new Error('remote link state');
      return response.json();
    }
    var host = createHost({
      hub:function(method, path, body){ return root.MiaHubChat.call(method, path, body); },
      local:async function(request){
        var headers = {'Accept':'application/json', 'X-MiaOS-Workspace':space()};
        if(request.body) headers['Content-Type'] = request.type || 'application/json';
        var response = await root.fetch(request.path, {method:request.method, credentials:'include', headers:headers, body:request.body || undefined});
        return {status:response.status, type:response.headers.get('content-type') || '', bytes:new Uint8Array(await response.arrayBuffer())};
      },
      socket:function(){
        return new root.WebSocket((root.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + root.location.host + SOCKET_PATH + '?workspace=' + encodeURIComponent(space()));
      },
      store:{load:function(){ return kept('GET'); }, save:function(state){ return kept('PUT', state); }},
      changed:function(){ root.dispatchEvent(new root.CustomEvent('mia-remote-link')); }
    });
    root.MiaRemoteHost = host;
    // Signed out of this Mia for now: look again in a while.
    (function boot(){ host.start().catch(function(){ root.setTimeout(boot, SIGN_IN_RETRY_MS); }); })();
  }
  if(root.document && root.MiaHubChat) install();

  return {createHost:createHost, allowedRequest:rule};
});
