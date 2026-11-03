/* Direct connections between the computers in a shared session, for the live
   minimap. Pixels and pointers never pass through the Hub: hidden channel
   messages only carry the offer and answer that introduce two computers. */
(function(root){
  'use strict';
  var ICE_SERVERS = [{urls: 'stun:stun.l.google.com:19302'}];
  var GATHER_MS = 2500, RETRY_MS = 20000, MAX_BUFFERED = 512 * 1024, MAX_MESSAGE = 256 * 1024;

  function sessionId(){
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), function(b){ return b.toString(16).padStart(2, '0'); }).join('');
  }
  // Sends the whole description at once, so each side needs one message rather than a stream of them.
  function gathered(pc, ms){
    return new Promise(function(resolve){
      if(pc.iceGatheringState === 'complete') return resolve();
      var timer = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', function(){
        if(pc.iceGatheringState === 'complete'){ clearTimeout(timer); resolve(); }
      });
    });
  }

  // options: selfId, signal(toId, {sid, kind, sdp}), onMessage(fromId, object), and for tests RTC, gatherMs, now.
  function createMesh(options){
    var RTC = options.RTC || root.RTCPeerConnection, peers = {}, closed = false;
    var now = options.now || Date.now, gatherMs = options.gatherMs === undefined ? GATHER_MS : options.gatherMs;
    function drop(id){
      var peer = peers[id];
      if(!peer) return;
      delete peers[id];
      try { peer.pc.close(); } catch(_error) {}
    }
    function isOpen(peer){ return !!(peer.channel && peer.channel.readyState === 'open'); }
    function wire(id, peer, channel){
      peer.channel = channel;
      channel.onmessage = function(event){
        if(peers[id] !== peer || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE) return;
        var message;
        try { message = JSON.parse(event.data); } catch(_error) { return; }
        options.onMessage(id, message);
      };
    }
    function open(id, sid){
      drop(id);
      var pc = new RTC({iceServers: ICE_SERVERS}), peer = peers[id] = {pc: pc, sid: sid, at: now(), channel: null};
      pc.onconnectionstatechange = function(){
        if(peers[id] === peer && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) drop(id);
      };
      return peer;
    }
    // The lower id always calls, so two computers never call each other at once.
    function call(id){
      var peer = open(id, sessionId());
      // A lost frame is replaced a second later, so nothing is resent.
      wire(id, peer, peer.pc.createDataChannel('mia-space-live', {ordered: false, maxRetransmits: 0}));
      return peer.pc.createOffer().then(function(offer){ return peer.pc.setLocalDescription(offer); })
        .then(function(){ return gathered(peer.pc, gatherMs); }).then(function(){
          if(peers[id] === peer && !closed) options.signal(id, {sid: peer.sid, kind: 'offer', sdp: peer.pc.localDescription.sdp});
        }).catch(function(){ if(peers[id] === peer) drop(id); });
    }
    function answer(id, message){
      var peer = open(id, message.sid);
      peer.pc.ondatachannel = function(event){ wire(id, peer, event.channel); };
      return peer.pc.setRemoteDescription({type: 'offer', sdp: message.sdp})
        .then(function(){ return peer.pc.createAnswer(); })
        .then(function(reply){ return peer.pc.setLocalDescription(reply); })
        .then(function(){ return gathered(peer.pc, gatherMs); }).then(function(){
          if(peers[id] === peer && !closed) options.signal(id, {sid: peer.sid, kind: 'answer', sdp: peer.pc.localDescription.sdp});
        }).catch(function(){ if(peers[id] === peer) drop(id); });
    }
    return {
      // Connects to everyone in `ids` and drops anyone who has gone.
      sync: function(ids){
        if(closed) return;
        Object.keys(peers).forEach(function(id){ if(ids.indexOf(id) < 0) drop(id); });
        ids.forEach(function(id){
          if(id === options.selfId || options.selfId > id) return;
          var peer = peers[id];
          if(!peer || (!isOpen(peer) && now() - peer.at >= RETRY_MS)) call(id);
        });
      },
      signal: function(fromId, message){
        if(closed || typeof message.sdp !== 'string' || typeof message.sid !== 'string' || message.sdp.length > 15000) return;
        if(message.kind === 'offer'){
          if(options.selfId < fromId) return;
          // A session's offers can replay from history; only a new one replaces a live connection.
          var current = peers[fromId];
          if(current && current.sid === message.sid) return;
          if(current && isOpen(current) && now() - Number(message.at || 0) > RETRY_MS) return;
          return answer(fromId, message);
        }
        if(message.kind === 'answer'){
          var peer = peers[fromId];
          if(!peer || peer.sid !== message.sid || peer.pc.signalingState !== 'have-local-offer') return;
          return peer.pc.setRemoteDescription({type: 'answer', sdp: message.sdp}).catch(function(){ drop(fromId); });
        }
      },
      send: function(message){
        var text = JSON.stringify(message);
        if(text.length > MAX_MESSAGE) return;
        Object.keys(peers).forEach(function(id){
          var peer = peers[id];
          // A slow connection skips frames rather than falling behind.
          if(!isOpen(peer) || peer.channel.bufferedAmount > MAX_BUFFERED) return;
          try { peer.channel.send(text); } catch(_error) {}
        });
      },
      openCount: function(){ return Object.keys(peers).filter(function(id){ return isOpen(peers[id]); }).length; },
      close: function(){ closed = true; Object.keys(peers).forEach(drop); }
    };
  }
  var api = {createMesh: createMesh};
  root.MiaSpaceLive = api;
  if(typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
