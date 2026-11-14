/* Remote link: what a phone and its computer share.
   The two pair with a code the person reads off the computer. From the code
   each side works out the same two values: one it shows the Hub to prove the
   pairing, and a key that never leaves the two of them. Everything they send
   each other is sealed with that key, so the Hub only passes text it cannot
   read. This file is the same on both ends. */
(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api; else root.MiaRemoteLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root){
  'use strict';
  var subtle = root.crypto.subtle;
  // No I, L, O, 0 or 1: nothing that reads as something else on a small screen.
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', CODE_LENGTH = 16;
  var LABEL = 'mia-remote-link/1', ROUNDS = 600000;
  // A frame older or newer than this is not acted on: a direction that waited
  // for hours must not run when the computer comes back.
  var FRESH_MS = 10 * 60 * 1000;
  var CHUNK_BYTES = 256 * 1024, SEND_FRAMES = 16, SEND_CHARS = 900000, PACE_MS = 250;

  function utf8(text){ return new TextEncoder().encode(text); }
  function text(bytes){ return new TextDecoder().decode(bytes); }
  function hex(bytes){ var out = ''; for(var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return out; }
  function encode(bytes){
    var s = '';
    for(var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return root.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(value){
    var s = root.atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(s.length);
    for(var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function join(parts){
    var size = 0, at = 0;
    parts.forEach(function(p){ size += p.length; });
    var out = new Uint8Array(size);
    parts.forEach(function(p){ out.set(p, at); at += p.length; });
    return out;
  }

  function newCode(){
    var out = '';
    while(out.length < CODE_LENGTH){
      var bytes = root.crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2));
      // 248 is the largest multiple of 31 in a byte, so every letter is as likely as the next.
      for(var i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) if(bytes[i] < 248) out += ALPHABET[bytes[i] % 31];
    }
    return out;
  }
  function showCode(code){ return String(code).replace(/(.{4})(?=.)/g, '$1-'); }
  // What the person typed, however they spaced it. Empty when it is not a code.
  function readCode(typed){
    var code = String(typed == null ? '' : typed).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if(code.length !== CODE_LENGTH) return '';
    for(var i = 0; i < code.length; i++) if(ALPHABET.indexOf(code[i]) < 0) return '';
    return code;
  }
  // claim: what the Hub is shown. secret: the key's bytes, kept by the two ends only.
  async function derive(code){
    var base = await subtle.importKey('raw', utf8(code), 'PBKDF2', false, ['deriveBits']);
    var bits = new Uint8Array(await subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:utf8(LABEL), iterations:ROUNDS}, base, 512));
    return {claim:hex(bits.subarray(0, 32)), secret:encode(bits.subarray(32))};
  }
  function importKey(secret){ return subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['encrypt', 'decrypt']); }

  // One side's end of the sealed conversation with one phone. `side` is
  // 'phone' or 'computer'; each frame says which side wrote it and for which
  // phone, so a frame cannot be played back to its own sender or to another.
  function channel(key, device, side, now){
    now = now || Date.now;
    var mine = utf8(LABEL + ' ' + side + ' ' + device);
    var theirs = utf8(LABEL + ' ' + (side === 'phone' ? 'computer' : 'phone') + ' ' + device);
    var sent = 0, seen = 0;
    return {
      seal: async function(head, payload){
        sent = Math.max(now(), sent + 1);
        var top = utf8(JSON.stringify(Object.assign({}, head, {n:sent}))), size = new Uint8Array(4);
        new DataView(size.buffer).setUint32(0, top.length);
        var nonce = root.crypto.getRandomValues(new Uint8Array(12));
        var sealed = await subtle.encrypt({name:'AES-GCM', iv:nonce, additionalData:mine}, key, join([size, top, payload || new Uint8Array(0)]));
        return encode(join([nonce, new Uint8Array(sealed)]));
      },
      // null: not ours. {stale:true}: ours, but too old, too new, or seen before.
      open: async function(frame){
        var plain, head;
        try {
          var bytes = decode(frame);
          plain = new Uint8Array(await subtle.decrypt({name:'AES-GCM', iv:bytes.subarray(0, 12), additionalData:theirs}, key, bytes.subarray(12)));
          var size = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
          head = JSON.parse(text(plain.subarray(4, 4 + size)));
          plain = plain.subarray(4 + size);
        } catch(_notOurs) { return null; }
        if(!head || typeof head.n !== 'number' || head.n <= seen || Math.abs(head.n - now()) > FRESH_MS) return {stale:true};
        seen = head.n;
        return {head:head, payload:plain};
      }
    };
  }

  function chunks(bytes){
    var out = [];
    for(var i = 0; i < bytes.length; i += CHUNK_BYTES) out.push(bytes.subarray(i, i + CHUNK_BYTES));
    return out.length ? out : [new Uint8Array(0)];
  }
  function wait(ms){ return new Promise(function(resolve){ root.setTimeout(resolve, ms); }); }

  // Reads frames from the Hub for as long as `alive()` says so. `ask(body)`
  // makes the Hub call; `take(reply)` gets each answer. A read is confirmed by
  // naming its last frame on the next one, so nothing is lost when a call fails.
  // `ended(error)` hears about an answer that will not get better by waiting.
  async function read(ask, take, alive, ended){
    var epoch = '', after = 0, pause = 1000;
    while(alive()){
      var began = Date.now();
      try {
        var reply = await ask(epoch ? {epoch:epoch, after:after} : {});
        if(!alive()) return;
        if(reply.epoch !== epoch){ epoch = reply.epoch; after = 0; }
        var frames = Array.isArray(reply.frames) ? reply.frames : [];
        if(frames.length) after = frames[frames.length - 1].seq;
        pause = 1000;
        await take(reply);
      } catch(error) {
        if(!alive()) return;
        if(error && error.code === 'invalid_remote_position'){ epoch = ''; after = 0; continue; }
        if(error && (error.status === 401 || error.status === 403 || error.status === 404)){ ended(error); return; }
        await wait(pause); pause = Math.min(pause * 2, 15000);
        continue;
      }
      var spent = Date.now() - began;
      if(spent < PACE_MS) await wait(PACE_MS - spent);
    }
  }

  // Sends what is queued, a few frames at a time and in order. `seal(item)`
  // turns one queued item into a frame; `post(frames)` makes the Hub call.
  // `dropped()` hears when the other side has not taken its frames for so long
  // that the queue is given up.
  function sender(seal, post, alive, dropped){
    var queue = [], busy = false;
    async function run(){
      if(busy) return;
      busy = true;
      try {
        while(queue.length && alive()){
          var began = Date.now(), frames = [], size = 0, taken = 0;
          while(taken < queue.length && frames.length < SEND_FRAMES){
            // Closed to more text from here on, so none is added while it is sealed.
            queue[taken].closed = true;
            var frame = queue[taken].frame || (queue[taken].frame = await seal(queue[taken]));
            if(frames.length && size + frame.length > SEND_CHARS) break;
            frames.push(frame); size += frame.length; taken++;
          }
          var tries = 0;
          for(;;){
            try { await post(frames); break; }
            catch(error) {
              if(!alive()) return;
              var gone = error && (error.status === 401 || error.status === 403 || error.status === 404);
              if(gone || ++tries > 30){ queue.length = 0; if(dropped) dropped(error); return; }
              await wait(error && error.status === 429 ? 1000 : Math.min(500 * tries, 5000));
            }
          }
          queue.splice(0, taken);
          var spent = Date.now() - began;
          if(queue.length && spent < PACE_MS) await wait(PACE_MS - spent);
        }
      } finally { busy = false; }
    }
    return {
      // Text for the same open line, queued back to back, travels as one frame.
      push: function(item){
        var last = queue[queue.length - 1];
        if(item.lines && last && !last.closed && last.lines && last.head.id === item.head.id && last.size + item.size < CHUNK_BYTES){
          last.lines = last.lines.concat(item.lines); last.size += item.size;
        } else queue.push(item);
        run();
      },
      clear: function(){ queue.length = 0; }
    };
  }
  // A queued item is {head, payload} or, for an open line's text, {head, lines, size}.
  function sealItem(link, item){
    return link.seal(item.head, item.lines ? utf8(JSON.stringify(item.lines)) : item.payload);
  }

  return {newCode:newCode, showCode:showCode, readCode:readCode, derive:derive, importKey:importKey, channel:channel,
    chunks:chunks, join:join, utf8:utf8, text:text, read:read, sender:sender, sealItem:sealItem, wait:wait,
    CHUNK_BYTES:CHUNK_BYTES, FRESH_MS:FRESH_MS};
});
