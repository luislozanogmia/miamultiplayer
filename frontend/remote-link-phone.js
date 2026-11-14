/* Remote link, the phone's side. The phone pairs once with the code shown on
   the person's computer, then asks that computer for everything through the
   Hub. Requests and answers are sealed with a key only the phone and the
   computer hold. `install` makes a page's own calls to Mia travel this way, so
   AI mode runs here unchanged. */
(function(root, factory){
  var core = typeof module === 'object' && module.exports ? require('./remote-link-core.js') : root.MiaRemoteLink;
  var api = factory(root, core);
  if(typeof module === 'object' && module.exports) module.exports = api; else root.MiaRemotePhone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root, Link){
  'use strict';
  var ANSWER_MS = 60000, MAX_REQUEST_BYTES = Link.CHUNK_BYTES, AWAY_MS = 40000;

  function failure(status, code){ var error = new Error(code || 'remote link'); error.status = status; error.code = code || ''; return error; }

  // deps: hubUrl; fetch; store.load()/save({device, token, key})/clear() keep
  // the pairing on this phone; changed() says the state to show has changed.
  function createPhone(deps){
    var kept = null, link = null, out = null, running = false, session = 0;
    var linked = false, computer = false, clock = false, lastRead = 0, nextId = 0;
    var waiting = {}, sockets = {};
    var now = deps.now || Date.now;

    async function hub(method, path, body, signed){
      var headers = {'Content-Type':'application/json'};
      if(signed) headers.Authorization = 'Remote ' + kept.device + '.' + kept.token;
      var response;
      try { response = await deps.fetch(deps.hubUrl + path, {method:method, headers:headers, body:JSON.stringify(body || {})}); }
      catch(_offline) { throw failure(0, 'hub_unavailable'); }
      var result = await response.json().catch(function(){ return null; });
      if(!response.ok) throw failure(response.status, result && typeof result.error === 'string' ? result.error : '');
      return result || {};
    }
    function alive(mine){ return running && mine === session; }
    function closeAll(){
      var open = sockets; sockets = {};
      Object.keys(open).forEach(function(id){ open[id].ended(); });
    }
    function failAll(){
      var asked = waiting; waiting = {};
      Object.keys(asked).forEach(function(id){ root.clearTimeout(asked[id].timer); asked[id].reject(failure(0, 'computer_unavailable')); });
    }
    function forget(){
      running = false; session++; kept = null; link = null; out = null; linked = false; computer = false;
      closeAll(); failAll();
      return Promise.resolve(deps.store.clear()).then(deps.changed, deps.changed);
    }

    function take(reply){
      // After a long gap (the phone slept) the computer has let the open lines go.
      if(lastRead && now() - lastRead > AWAY_MS) closeAll();
      lastRead = now();
      var on = reply.host === true;
      if(on !== computer){ computer = on; if(!on) closeAll(); deps.changed(); }
      var frames = Array.isArray(reply.frames) ? reply.frames : [], chain = Promise.resolve();
      frames.forEach(function(frame){
        chain = chain.then(function(){ return link.open(frame.data); }).then(function(opened){
          if(!opened || opened.stale) return;
          var head = opened.head;
          if(head.t === 'hello'){ if(!linked || clock){ linked = true; clock = false; deps.changed(); } }
          else if(head.t === 'stale'){ if(!clock){ clock = true; deps.changed(); } }
          else if(head.t === 'res'){
            var asked = waiting[head.id];
            if(!asked) return;
            asked.parts.push(opened.payload);
            if(head.more) return;
            delete waiting[head.id]; root.clearTimeout(asked.timer);
            asked.resolve({status:head.status, type:head.type || '', bytes:Link.join(asked.parts)});
          } else if(head.t === 'ws'){
            var socket = sockets[head.id];
            if(!socket) return;
            if(head.op === 'open') socket.opened();
            else if(head.op === 'close'){ delete sockets[head.id]; socket.ended(); }
            else if(head.op === 'msg'){ try { JSON.parse(Link.text(opened.payload)).forEach(socket.heard); } catch(_bad) {} }
          }
        });
      });
      return chain;
    }
    async function start(){
      if(running) return true;
      kept = kept || await deps.store.load();
      if(!kept || !kept.device || !kept.token || !kept.key){ kept = null; return false; }
      running = true;
      var mine = ++session, mineAlive = function(){ return alive(mine); };
      link = Link.channel(kept.key, kept.device, 'phone', now);
      out = Link.sender(function(item){ return Link.sealItem(link, item); },
        function(frames){ return hub('POST', '/v1/remote/device/send', {frames:frames}, true); }, mineAlive,
        function(error){ if(error && error.status === 401) forget(); else failAll(); });
      lastRead = 0;
      Link.read(function(body){ return hub('POST', '/v1/remote/device/poll', body, true); }, take, mineAlive,
        // The computer removed this phone, or it was away for a month.
        function(error){ if(error && error.status === 401) forget(); else { running = false; deps.changed(); } });
      // The computer learns which pairing this phone used from its first frame.
      out.push({head:{t:'hello'}});
      deps.changed();
      return true;
    }

    function socket(path){
      var id = 's' + (++nextId), state = 0;
      var api = {readyState:0, onopen:null, onmessage:null, onclose:null, onerror:null,
        send:function(data){ if(state === 1 && out) out.push({head:{t:'ws', id:id, op:'send'}, payload:Link.utf8(String(data))}); },
        close:function(){
          if(state >= 2) return;
          if(sockets[id] === hooks){ delete sockets[id]; if(out) out.push({head:{t:'ws', id:id, op:'close'}}); }
          hooks.ended();
        }};
      var hooks = {
        opened:function(){ if(state === 0){ state = api.readyState = 1; if(api.onopen) api.onopen({type:'open'}); } },
        heard:function(data){ if(state === 1 && api.onmessage) api.onmessage({type:'message', data:data}); },
        ended:function(){ if(state < 2){ state = api.readyState = 3; if(api.onclose) api.onclose({type:'close'}); } }
      };
      if(!running || !out){ root.setTimeout(hooks.ended, 0); return api; }
      sockets[id] = hooks;
      out.push({head:{t:'ws', id:id, op:'open', path:path}});
      return api;
    }

    return {
      start:start,
      // {paired, linked: the computer has answered, computer: it is reachable now, clock: this phone's time is off}
      state:function(){ return {paired:!!kept, linked:linked, computer:computer, clock:clock}; },
      pair:async function(typed, name){
        var code = Link.readCode(typed);
        if(!code) throw failure(400, 'invalid_code');
        var made = await Link.derive(code);
        var reply = await hub('POST', '/v1/remote/claim', {claim:made.claim, name:name});
        kept = {device:reply.device, token:reply.token, key:await Link.importKey(made.secret)};
        await deps.store.save(kept);
        linked = false; clock = false;
        return start();
      },
      unpair:async function(){
        if(kept){ try { await hub('DELETE', '/v1/remote/device', {}, true); } catch(_gone) {} }
        await forget();
      },
      // Asks the computer; answers {status, type, bytes}.
      request:function(request){
        return new Promise(function(resolve, reject){
          var body = request.body || null;
          if(!running || !out) return reject(failure(0, 'not_paired'));
          if(body && body.length > MAX_REQUEST_BYTES) return reject(failure(413, 'body_too_large'));
          var id = 'r' + (++nextId);
          waiting[id] = {parts:[], resolve:resolve, reject:reject, timer:root.setTimeout(function(){
            delete waiting[id]; reject(failure(0, 'computer_unavailable'));
          }, ANSWER_MS)};
          out.push({head:{t:'req', id:id, method:request.method, path:request.path, type:request.type || ''}, payload:body});
        });
      },
      socket:socket
    };
  }

  // The pairing kept in the phone's own storage. The key is stored in a form
  // the page itself cannot read back out.
  function phoneStore(){
    function open(){
      return new Promise(function(resolve, reject){
        var request = root.indexedDB.open('mia-remote-link', 1);
        request.onupgradeneeded = function(){ request.result.createObjectStore('kept'); };
        request.onsuccess = function(){ resolve(request.result); };
        request.onerror = function(){ reject(request.error); };
      });
    }
    function run(mode, work){
      return open().then(function(db){
        return new Promise(function(resolve, reject){
          var tx = db.transaction('kept', mode), request = work(tx.objectStore('kept'));
          tx.oncomplete = function(){ db.close(); resolve(request.result); };
          tx.onerror = tx.onabort = function(){ db.close(); reject(tx.error); };
        });
      });
    }
    return {
      load:function(){ return run('readonly', function(s){ return s.get('pairing'); }).then(function(v){ return v || null; }, function(){ return null; }); },
      save:function(value){ return run('readwrite', function(s){ return s.put(value, 'pairing'); }); },
      clear:function(){ return run('readwrite', function(s){ return s.delete('pairing'); }); }
    };
  }

  // Makes this page's own calls to Mia ("/api/...") go to the computer.
  function install(phone){
    var realFetch = root.fetch.bind(root), RealSocket = root.WebSocket;
    function local(url){ return typeof url === 'string' && url.indexOf('/api/') === 0; }
    root.fetch = function(input, init){
      var url = typeof input === 'string' ? input : input && input.url;
      if(!local(url)) return realFetch(input, init);
      init = init || {};
      var headers = init.headers || {}, body = init.body;
      return phone.request({method:(init.method || 'GET').toUpperCase(), path:url,
        type:headers['Content-Type'] || headers['content-type'] || '', body:typeof body === 'string' ? Link.utf8(body) : null}).then(function(answer){
        var empty = answer.status === 204 || answer.status === 205 || answer.status === 304;
        return new root.Response(empty ? null : answer.bytes, {status:answer.status >= 200 && answer.status <= 599 ? answer.status : 502,
          headers:answer.type ? {'Content-Type':answer.type} : {}});
      });
    };
    root.WebSocket = function(url, protocols){
      var path = String(url).replace(/^wss?:\/\/[^/]+/, '');
      if(path.indexOf('/api/conversations/ws') === 0) return phone.socket('/api/conversations/ws');
      return protocols === undefined ? new RealSocket(url) : new RealSocket(url, protocols);
    };

    // Pictures Mia's computer serves are fetched the same way and shown from memory.
    var pictures = {}, src = Object.getOwnPropertyDescriptor(root.HTMLImageElement.prototype, 'src');
    function picture(path){
      return pictures[path] || (pictures[path] = phone.request({method:'GET', path:path}).then(function(answer){
        if(answer.status !== 200) throw failure(answer.status, 'no_picture');
        return root.URL.createObjectURL(new root.Blob([answer.bytes], {type:answer.type || 'image/jpeg'}));
      }));
    }
    function show(image, path){
      image.dataset.remote = path;
      picture(path).then(function(url){ if(image.dataset.remote === path) src.set.call(image, url); },
        function(){ delete pictures[path]; if(image.dataset.remote === path) image.dispatchEvent(new root.Event('error')); });
    }
    Object.defineProperty(root.HTMLImageElement.prototype, 'src', {configurable:true, enumerable:src.enumerable,
      get:function(){ return src.get.call(this); },
      set:function(value){ if(local(value)) show(this, value); else { delete this.dataset.remote; src.set.call(this, value); } }});
    function sweep(node){
      if(node.nodeType !== 1) return;
      var images = node.tagName === 'IMG' ? [node] : Array.prototype.slice.call(node.querySelectorAll('img'));
      images.forEach(function(image){
        var path = image.getAttribute('src');
        if(local(path)){ image.removeAttribute('src'); show(image, path); }
      });
    }
    return {
      // Call with the part of the page AI mode draws into.
      watch:function(target){
        new root.MutationObserver(function(changes){
          changes.forEach(function(change){ Array.prototype.forEach.call(change.addedNodes, sweep); });
        }).observe(target, {childList:true, subtree:true});
        Array.prototype.forEach.call(target.children || [], sweep);
      }
    };
  }

  return {createPhone:createPhone, phoneStore:phoneStore, install:install};
});
