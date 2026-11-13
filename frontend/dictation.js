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

  return {createEngine: createEngine, TARGET_RATE: TARGET_RATE, mixToMono: mixToMono, resample: resample, encodeWav: encodeWav, toWav16k: toWav16k, insertText: insertText};
});
