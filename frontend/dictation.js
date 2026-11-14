(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaDictation = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  // Audio helpers for local dictation. The browser records, these helpers turn
  // the recording into 16 kHz mono PCM16 WAV (what whisper.cpp wants), and the
  // WAV is posted to the loopback backend (/api/speech/transcribe). Nothing is
  // sent to a third-party service.
  var TARGET_RATE = 16000;

  function mixToMono(channels){
    if(!channels || !channels.length) return new Float32Array(0);
    if(channels.length === 1) return channels[0];
    var length = channels[0].length;
    var out = new Float32Array(length);
    for(var c = 0; c < channels.length; c++){
      var data = channels[c];
      for(var i = 0; i < length; i++) out[i] += data[i] / channels.length;
    }
    return out;
  }

  // Linear interpolation is plenty for speech recognition input.
  function resample(samples, fromRate, toRate){
    toRate = toRate || TARGET_RATE;
    if(!samples.length || fromRate === toRate) return samples;
    var ratio = fromRate / toRate;
    var length = Math.floor(samples.length / ratio);
    var out = new Float32Array(length);
    for(var i = 0; i < length; i++){
      var pos = i * ratio;
      var index = Math.floor(pos);
      var next = Math.min(index + 1, samples.length - 1);
      var frac = pos - index;
      out[i] = samples[index] * (1 - frac) + samples[next] * frac;
    }
    return out;
  }

  function encodeWav(samples, sampleRate){
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function text(offset, value){ for(var i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for(var i = 0; i < samples.length; i++){
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function toWav16k(channels, sampleRate){
    return encodeWav(resample(mixToMono(channels), sampleRate, TARGET_RATE), TARGET_RATE);
  }

  // Inserts dictated text at the caret (or over the selection), adding a space
  // on either side only where it would otherwise glue words together.
  function insertText(value, start, end, text){
    value = String(value || '');
    text = String(text || '').trim();
    if(!text) return {value: value, caret: end == null ? value.length : end};
    start = start == null ? value.length : start;
    end = end == null ? start : end;
    var before = value.slice(0, start);
    var after = value.slice(end);
    if(before && !/\s$/.test(before)) text = ' ' + text;
    if(after && !/^\s/.test(after)) text = text + ' ';
    return {value: before + text + after, caret: before.length + text.length};
  }

  // The speech engine on this computer, shared by the composer's mic and a
  // shared session's transcript. options: fetch(path, init), workspace().
  function createEngine(options){
    function call(path, init){
      init = init || {};
      init.credentials = 'include';
      init.headers = Object.assign({'X-MiaOS-Workspace': options.workspace()}, init.headers || {});
      return options.fetch(path, init).then(function(r){
        return r.json().catch(function(){ return {}; }).then(function(data){ return {status: r.status, data: data}; });
      });
    }
    return {
      // Engine/model gate. The model download only ever starts from this
      // explicit confirmation, and goes to the user's Mia data folder.
      // hooks: confirm(text) -> boolean, onDownloading(). Resolves false when the person says no.
      ready: function(hooks){
        return call('/api/speech/status').then(function(res){
          var status = res.data || {};
          if(!status.binaryReady) throw new Error('Dictation is missing from this copy of Mia. Reinstall Mia to get it back.');
          if(status.modelReady) return true;
          if(!hooks.confirm('Dictation runs on this computer with the whisper.cpp "' + status.model + '" speech model (about 142 MB).\n\nDownload it once from huggingface.co into your Mia data folder? Your audio is never uploaded anywhere.')) return false;
          if(hooks.onDownloading) hooks.onDownloading();
          return call('/api/speech/model', {method: 'POST'}).then(function(done){
            if(done.status !== 200) throw new Error((done.data && done.data.message) || 'Model download failed.');
            return true;
          });
        });
      },
      transcribe: function(wav){
        return call('/api/speech/transcribe', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: wav}).then(function(res){
          if(res.status !== 200) throw new Error((res.data && res.data.message) || 'Transcription failed.');
          return String((res.data && res.data.text) || '').trim();
        });
      }
    };
  }

  // One recording from the microphone, written down when it ends. Shared by
  // the composer's mic and AI mode's. options: media (navigator.mediaDevices),
  // MediaRecorder, AudioContext, transcribe(wav) -> Promise of text.
  function createRecorder(options){
    var recorder = null, stream = null, chunks = [], finish = null;
    function release(){
      if(stream){ stream.getTracks().forEach(function(track){ track.stop(); }); stream = null; }
      recorder = null; finish = null;
    }
    function written(){
      var blob = new Blob(chunks, {type: (recorder && recorder.mimeType) || 'audio/webm'});
      release();
      return blob.arrayBuffer().then(function(bytes){
        var ctx = new options.AudioContext();
        return ctx.decodeAudioData(bytes).then(function(audio){
          ctx.close();
          var channels = [];
          for(var c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
          return toWav16k(channels, audio.sampleRate);
        }, function(error){ ctx.close(); throw error; });
      }).then(function(wav){
        return options.transcribe(wav);
      });
    }
    return {
      start: function(){
        return options.media.getUserMedia({audio:true}).then(function(media){
          stream = media; chunks = [];
          recorder = new options.MediaRecorder(media);
          recorder.ondataavailable = function(ev){ if(ev.data && ev.data.size) chunks.push(ev.data); };
          recorder.onstop = function(){ if(finish) finish(); };
          recorder.start();
        });
      },
      // Ends the recording; resolves with what was said ('' when nothing was).
      stop: function(){
        return new Promise(function(resolve, reject){
          if(!recorder) return resolve('');
          finish = function(){ written().then(resolve, reject); };
          try { recorder.stop(); } catch(error) { release(); reject(error); }
        });
      },
      // Lets go of the microphone without writing anything down.
      cancel: function(){
        var old = recorder;
        release();
        if(old){ old.onstop = null; try { old.stop(); } catch(_error) { /* already stopped */ } }
      },
      active: function(){ return !!recorder; }
    };
  }

  // Hears where a person starts and stops talking, from how loud each short
  // piece of sound is. feed(level, ms, loud) -> 'start' when they begin, 'end'
  // when they have stopped, 'drop' when it was only a noise, '' otherwise.
  // loud: Mia's own voice is playing, so it takes more to count as the person.
  function createEndpointer(options){
    var o = options || {};
    var startMs = o.startMs || 130, loudStartMs = o.loudStartMs || 320, endMs = o.endMs || 1000;
    var minMs = o.minMs || 250, maxMs = o.maxMs || 45000, least = o.least || 0.015;
    var floor = 0.004, up = 0, speaking = false, voiced = 0, silent = 0, total = 0;
    function reset(){ up = 0; speaking = false; voiced = 0; silent = 0; total = 0; }
    return {
      reset: reset,
      feed: function(level, ms, loud){
        var bar = Math.max(least, floor * 3.5) * (loud && !speaking ? 3 : 1);
        if(!speaking){
          if(level >= bar) up += ms;
          else { up = 0; if(!loud) floor = floor * 0.95 + level * 0.05; }
          if(up < (loud ? loudStartMs : startMs)) return '';
          speaking = true; voiced = up; total = up; silent = 0;
          return 'start';
        }
        total += ms;
        if(level >= bar * 0.6){ voiced += ms; silent = 0; } else silent += ms;
        if(silent < endMs && total < maxMs) return '';
        var real = voiced >= minMs;
        reset();
        return real ? 'end' : 'drop';
      }
    };
  }

  // An open microphone for talking with no button: each thing the person says
  // is written down when they stop. options: media, AudioContext,
  // transcribe(wav) -> Promise of text, loud() -> Mia is speaking now,
  // onStart(), onWriting(), onText(text), onDrop(), onError(error).
  function createListener(options){
    var stream = null, ctx = null, node = null, ears = createEndpointer(options.endpointer);
    var lead = [], said = null, writing = false, run = 0;
    function level(block){
      var sum = 0;
      for(var i = 0; i < block.length; i++) sum += block[i] * block[i];
      return Math.sqrt(sum / (block.length || 1));
    }
    function join(blocks){
      var length = 0, at = 0;
      blocks.forEach(function(block){ length += block.length; });
      var out = new Float32Array(length);
      blocks.forEach(function(block){ out.set(block, at); at += block.length; });
      return out;
    }
    function hear(block, rate){
      if(writing) return;
      var ms = block.length / rate * 1000, what = ears.feed(level(block), ms, !!(options.loud && options.loud()));
      if(said) said.push(block);
      else {
        // The half second before they were heard is kept, so the first word is whole.
        lead.push(block);
        while(lead.length * ms > 600) lead.shift();
      }
      if(what === 'start'){ said = lead; lead = []; if(options.onStart) options.onStart(); }
      else if(what === 'drop'){ said = null; if(options.onDrop) options.onDrop(); }
      else if(what === 'end'){
        var mine = run, pcm = join(said);
        said = null; writing = true;
        if(options.onWriting) options.onWriting();
        Promise.resolve().then(function(){ return options.transcribe(toWav16k([pcm], rate)); }).then(function(text){
          if(mine !== run) return;
          writing = false; ears.reset();
          if(options.onText) options.onText(String(text || '').trim());
        }, function(error){
          if(mine !== run) return;
          writing = false; ears.reset();
          if(options.onError) options.onError(error);
        });
      }
    }
    function stop(){
      run++; writing = false; said = null; lead = []; ears.reset();
      if(node){ node.onaudioprocess = null; try { node.disconnect(); } catch(_error) { /* already off */ } node = null; }
      if(stream){ stream.getTracks().forEach(function(track){ track.stop(); }); stream = null; }
      if(ctx){ try { ctx.close(); } catch(_error) { /* already closed */ } ctx = null; }
    }
    return {
      start: function(){
        var mine = ++run;
        return options.media.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}}).then(function(media){
          if(mine !== run){ media.getTracks().forEach(function(track){ track.stop(); }); return; }
          stream = media; ctx = new options.AudioContext();
          var rate = ctx.sampleRate, quiet = ctx.createGain();
          node = ctx.createScriptProcessor(2048, 1, 1);
          node.onaudioprocess = function(ev){ hear(new Float32Array(ev.inputBuffer.getChannelData(0)), rate); };
          quiet.gain.value = 0;
          ctx.createMediaStreamSource(media).connect(node); node.connect(quiet); quiet.connect(ctx.destination);
        });
      },
      stop: stop,
      active: function(){ return !!stream; },
      hear: hear
    };
  }

  return {createEngine: createEngine, createRecorder: createRecorder, createEndpointer: createEndpointer, createListener: createListener, TARGET_RATE: TARGET_RATE, mixToMono: mixToMono, resample: resample, encodeWav: encodeWav, toWav16k: toWav16k, insertText: insertText};
});
