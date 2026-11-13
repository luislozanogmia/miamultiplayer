/* What people say in a shared session, written down with their names. Each
   computer listens only to its own microphone, and only after its person turns
   it on, so a line always belongs to the person whose Mia wrote it. The sound
   is turned into text on that computer and never leaves it. From the words,
   one person's Mia proposes things to do next. */
(function(root){
  'use strict';
  var PAUSE_S = 0.7, MAX_S = 15, MIN_VOICED_S = 0.3, LEAD_S = 0.3;
  var QUIET_FLOOR = 0.012, LOUDER_BY = 3, MAX_WAITING = 6, MAX_LINES = 500, MAX_TEXT = 2000, TAKEN_SHOWN_MS = 60000;

  // Cuts a stream of microphone samples into spoken pieces: a piece starts
  // when the sound rises above the room's own noise and ends at a pause.
  // options: sampleRate, onPiece(Float32Array samples).
  function createSegmenter(options){
    var rate = options.sampleRate, noise = 0.004;
    var lead = [], leadLength = 0, piece = null, length = 0, voiced = 0, quiet = 0;
    function level(frame){
      var sum = 0;
      for(var i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return Math.sqrt(sum / (frame.length || 1));
    }
    function flush(){
      var frames = piece, total = length, spoken = voiced;
      piece = null; length = 0; voiced = 0; quiet = 0; lead = []; leadLength = 0;
      if(!frames || spoken < MIN_VOICED_S * rate) return;
      var samples = new Float32Array(total), at = 0;
      frames.forEach(function(frame){ samples.set(frame, at); at += frame.length; });
      options.onPiece(samples);
    }
    return {
      push: function(frame){
        // The audio node reuses its buffer, so every frame is copied.
        frame = new Float32Array(frame);
        var rms = level(frame), loud = rms > Math.max(QUIET_FLOOR, noise * LOUDER_BY);
        if(!piece){
          if(!loud){
            noise = noise * 0.95 + rms * 0.05;
            lead.push(frame); leadLength += frame.length;
            while(lead.length > 1 && leadLength - lead[0].length >= LEAD_S * rate) leadLength -= lead.shift().length;
            return;
          }
          // A little of what came just before, so the first sound is not clipped.
          piece = lead.concat([frame]); length = leadLength + frame.length; voiced = frame.length; quiet = 0;
          return;
        }
        piece.push(frame); length += frame.length;
        if(loud){ voiced += frame.length; quiet = 0; } else quiet += frame.length;
        if(quiet >= PAUSE_S * rate || length >= MAX_S * rate) flush();
      },
      stop: flush
    };
  }

  // The lines of one session, oldest first. A line is {id, by, name, text, at}.
  function createTranscript(limit){
    var lines = [], seen = {};
    limit = limit || MAX_LINES;
    return {
      // Returns the stored line, or null for a repeat or anything malformed.
      add: function(line, now){
        if(!line || typeof line.id !== 'string' || !line.id || line.id.length > 40 || typeof line.by !== 'string' || !line.by) return null;
        var text = String(line.text == null ? '' : line.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT), at = Number(line.at);
        var key = line.by + '|' + line.id;
        if(!text || !(at > 0) || seen[key]) return null;
        now = now || Date.now();
        var kept = {id: line.id, by: line.by, name: String(line.name || 'Colleague').slice(0, 80), text: text, at: Math.min(at, now)};
        seen[key] = true;
        var index = lines.length;
        while(index > 0 && lines[index - 1].at > kept.at) index--;
        lines.splice(index, 0, kept);
        while(lines.length > limit){ var gone = lines.shift(); delete seen[gone.by + '|' + gone.id]; }
        return kept;
      },
      lines: function(){ return lines.slice(); },
      by: function(id){ return lines.filter(function(line){ return line.by === id; }); },
      clear: function(){ lines = []; seen = {}; }
    };
  }

  // Listens to this computer's microphone and reports each thing said as text.
  // options: media (navigator.mediaDevices), AudioContext, toWav(samples, rate),
  // transcribe(wav) -> Promise of text, onLine(text, at), onError(error).
  function createListener(options){
    var stream = null, context = null, source = null, node = null, segmenter = null;
    var waiting = [], busy = false, stopped = true, failures = 0;
    function next(){
      if(busy || stopped || !waiting.length) return;
      var piece = waiting.shift();
      busy = true;
      Promise.resolve().then(function(){ return options.transcribe(options.toWav(piece.samples, piece.rate)); }).then(function(text){
        failures = 0;
        text = String(text || '').trim();
        if(text && !stopped) options.onLine(text, piece.at);
      }, function(error){
        // One bad piece is skipped; the engine failing again and again ends the listening.
        if(++failures >= 3 && !stopped){ stop(); if(options.onError) options.onError(error); }
      }).then(function(){ busy = false; next(); });
    }
    function stop(){
      stopped = true; waiting = [];
      if(node){ node.onaudioprocess = null; try { node.disconnect(); } catch(_error) {} }
      if(source){ try { source.disconnect(); } catch(_error) {} }
      if(stream) stream.getTracks().forEach(function(track){ track.stop(); });
      if(context && context.close) Promise.resolve(context.close()).catch(function(){});
      stream = context = source = node = segmenter = null;
    }
    return {
      start: function(){
        if(!stopped) return Promise.resolve();
        stopped = false; failures = 0;
        // Echo cancelling keeps a colleague's voice from the speakers out of this person's lines.
        return options.media.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}}).then(function(media){
          if(stopped){ media.getTracks().forEach(function(track){ track.stop(); }); return; }
          stream = media;
          context = new options.AudioContext();
          var rate = context.sampleRate;
          segmenter = createSegmenter({sampleRate: rate, onPiece: function(samples){
            // Falling behind drops the oldest piece rather than drifting minutes late.
            if(waiting.length >= MAX_WAITING) waiting.shift();
            waiting.push({samples: samples, rate: rate, at: Date.now() - Math.round(samples.length / rate * 1000)});
            next();
          }});
          source = context.createMediaStreamSource(media);
          node = context.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = function(event){ if(segmenter) segmenter.push(event.inputBuffer.getChannelData(0)); };
          source.connect(node);
          // The node only runs while connected onward; it writes nothing, so no sound plays.
          node.connect(context.destination);
        }).catch(function(error){ stop(); throw error; });
      },
      stop: stop,
      active: function(){ return !stopped; }
    };
  }

  // What Mia proposes from what was said. An idea is {id, by, name, title, ask, at}
  // and is known by who proposed it plus its id, so nobody can replace another's.
  function createIdeas(limit){
    var ideas = [], known = {};
    limit = limit || 40;
    function tidy(value, max){ return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
    return {
      add: function(idea, now){
        if(!idea || typeof idea.id !== 'string' || !idea.id || idea.id.length > 40 || typeof idea.by !== 'string' || !idea.by) return null;
        var title = tidy(idea.title, 80), ask = tidy(idea.ask, 600), at = Number(idea.at), key = idea.by + '|' + idea.id;
        if(!title || !ask || !(at > 0) || known[key]) return null;
        var kept = {key: key, id: idea.id, by: idea.by, name: tidy(idea.name || 'Colleague', 80), title: title, ask: ask, at: Math.min(at, now || Date.now()), taken: null, gone: false};
        known[key] = kept;
        ideas.push(kept);
        while(ideas.length > limit) delete known[ideas.shift().key];
        return kept;
      },
      // The first person to take an idea has it; a second take returns null.
      take: function(key, who, now){
        var idea = known[key];
        if(!idea || idea.taken || !who || !who.id) return null;
        idea.taken = {id: who.id, name: tidy(who.name || 'Colleague', 80), at: now || Date.now()};
        return idea;
      },
      dismiss: function(key){ if(known[key]) known[key].gone = true; },
      // The newest few worth showing; one that was taken stays a minute, so people see who has it.
      open: function(now){
        now = now || Date.now();
        return ideas.filter(function(idea){ return !idea.gone && (!idea.taken || now - idea.taken.at < TAKEN_SHOWN_MS); }).slice(-2);
      },
      waiting: function(id){ return ideas.filter(function(idea){ return idea.by === id && !idea.taken; }); },
      titles: function(){ return ideas.map(function(idea){ return idea.title; }); },
      clear: function(){ ideas = []; known = {}; }
    };
  }

  // Decides when to ask the model for ideas: after people pause, once enough
  // new has been said, and never more often than every `gapMs`.
  // options: ask() -> Promise of [{title, ask}], onIdeas(list), should() -> bool.
  function createSuggester(options){
    var minWords = options.minWords || 12, settleMs = options.settleMs == null ? 4000 : options.settleMs, gapMs = options.gapMs == null ? 20000 : options.gapMs;
    var words = 0, last = 0, timer = null, busy = false, stopped = false;
    function later(ms){ clearTimeout(timer); timer = setTimeout(attempt, ms); }
    function attempt(){
      timer = null;
      if(stopped || busy || words < minWords || !options.should()) return;
      var wait = last + gapMs - Date.now();
      if(wait > 0) return later(wait);
      busy = true; words = 0; last = Date.now();
      Promise.resolve().then(options.ask).then(function(list){
        if(!stopped && Array.isArray(list) && list.length) options.onIdeas(list);
      }, function(){}).then(function(){ busy = false; if(!stopped && words >= minWords) later(settleMs); });
    }
    return {
      heard: function(line){
        if(stopped || !line) return;
        words += String(line.text || '').split(/\s+/).filter(Boolean).length;
        later(settleMs);
      },
      stop: function(){ stopped = true; clearTimeout(timer); timer = null; },
      start: function(){ stopped = false; words = 0; last = 0; }
    };
  }

  var api = {createSegmenter: createSegmenter, createTranscript: createTranscript, createListener: createListener, createIdeas: createIdeas, createSuggester: createSuggester};
  root.MiaSpaceTalk = api;
  if(typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
