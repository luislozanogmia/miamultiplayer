(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaTeamFiles = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  // Team files: the logic behind the shared file screens. No DOM here. Bytes go
  // straight from this computer to signed S3 links; the Hub only ever sees JSON
  // (sizes, hashes, ETags). Team mode only; Solo files stay local.
  var MAX_BYTES = 500000000;          // one file, as the Hub allows
  var PART_BYTES = 8000000;           // every part but the last
  var PARTS_PER_REQUEST = 16;         // signed links the Hub gives per request
  var PART_ATTEMPTS = 3;
  var PART_PARALLEL = 3;
  var RETRY_DELAYS = [500, 1500, 4000];
  var ID = /^[a-f0-9]{32}$/;
  var HEX64 = /^[a-f0-9]{64}$/;
  var CURSOR = /^[1-9][0-9]{0,14}\/[a-f0-9]{32}$/;
  var SPACE_KINDS = ['channel', 'group', 'dm'];
  // Uploads this computer tracks. An `app` space holds published mini-apps; only
  // an admin may list it, and nothing here needs to, so list() stays narrower.
  var UPLOAD_KINDS = SPACE_KINDS.concat('app');

  function fail(code, extra){
    var error = new Error(errorMessage(code));
    error.code = code;
    if(extra) Object.keys(extra).forEach(function(key){ error[key] = extra[key]; });
    return error;
  }

  // ---- Plain-language errors ------------------------------------------------
  // The Hub's file errors reuse a few codes that mean something else for chat
  // images (file_too_large is 8 MB there), so these win for team files.
  var MESSAGES = {
    file_too_large: 'That file is over the 500 MB limit for one file.',
    empty_file: 'That file is empty, so there is nothing to upload.',
    file_quota_exceeded: 'Your team has used all of its file storage. Delete some files to make room.',
    team_files_not_configured: 'File storage is not set up for this team yet. Ask your team admin.',
    file_uploads_disabled: 'Uploading files is turned off for now. Existing files can still be downloaded.',
    file_storage_unavailable: 'The file storage service did not answer. Try again in a moment.',
    upload_closed: 'This upload is no longer open. Start it again.',
    upload_expired: 'This upload timed out. Start it again.',
    file_not_ready: 'This file is still being scanned for viruses. Try again in a moment.',
    file_integrity_mismatch: 'The stored file does not match what was uploaded. It was not made available.',
    upload_incomplete: 'This upload did not finish.',
    invalid_parts: 'Mia could not split that file for upload. Start it again.',
    invalid_file: 'That file could not be uploaded. Check its name and try again.',
    invalid_run: 'That file does not belong to a run.',
    invalid_cursor: 'The next page of files could not be loaded. Refresh and try again.',
    run_finished: 'That run has already finished.',
    space_archived: 'This conversation is archived, so files cannot be added.',
    channel_archived: 'This conversation is archived, so files cannot be added.',
    download_allowance_exceeded: 'Your team has used this month’s download allowance. Try again next month.',
    scan_status_conflict: 'This file’s scan result changed. Refresh and try again.',
    invalid_scan_status: 'The scan result could not be read. Try again.',
    not_found: 'This file is no longer available to you.',
    file_in_use: 'A team app is using this file, so it can’t be deleted. Remove the app first.',
    unsafe_url: 'Mia refused a file link that did not point at your team’s storage.',
    unsafe_headers: 'Mia refused upload instructions it did not expect.',
    bad_response: 'The file service sent something Mia could not read. Try again.',
    part_mismatch: 'The file service split this file differently than expected. Start it again.',
    file_changed: 'The file changed on this computer. Choose it again to upload the new version.',
    part_rejected: 'The storage service rejected a piece of the file. It may have changed while uploading. Start it again.',
    part_failed: 'A piece of the file did not upload. Check your connection, then retry.',
    storage_unreadable: 'The storage service accepted a piece but your app cannot read its receipt. Ask your team admin to check the storage settings.',
    storage_refused: 'The storage service refused this transfer. Try again.',
    download_failed: 'The file could not be downloaded. Try again.',
    integrity_failed: 'The downloaded file did not match its fingerprint, so it was discarded.',
    aborted: 'Stopped.',
    team_storage_full: 'Your team has used all of its file storage. Delete some files to make room.',
    // Not specific to files; wording matches the rest of the team screens.
    hub_unavailable: 'Can’t reach the shared team service right now. Try again in a moment.',
    service_unavailable: 'Can’t reach the shared team service right now. Try again in a moment.',
    writes_paused: 'The shared team service is briefly read-only for maintenance. Try again in a moment.',
    sign_in_required: 'Sign in to your Mia account to use shared teams.',
    rate_limit: 'Too many requests. Wait a moment and try again.',
  };
  function errorMessage(code, status){
    if(code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code];
    if(status === 401) return MESSAGES.sign_in_required;
    if(status === 403 || status === 404) return MESSAGES.not_found;
    if(status >= 500 || status === 0) return MESSAGES.hub_unavailable;
    return 'The file service could not do that' + (code ? ' (' + code + ')' : '') + '. Try again.';
  }
  // Delete is only for the uploader or a team admin; the Hub answers anyone else
  // with "not found", so say what likely happened.
  function deleteErrorMessage(error){
    if(error && (error.code === 'not_found' || error.status === 404 || error.status === 403)) return 'Only the person who added this file or a team admin can delete it.';
    return friendly(error);
  }
  // A Hub error carries its own chat-flavoured wording; prefer the file wording.
  function friendly(error){
    if(!error) return errorMessage('');
    if(error.code && Object.prototype.hasOwnProperty.call(MESSAGES, error.code)) return MESSAGES[error.code];
    return error.message || errorMessage(error.code, error.status);
  }

  // ---- Sizes and parts ------------------------------------------------------
  function checkSize(size){
    if(!Number.isSafeInteger(size) || size < 1) throw fail('empty_file');
    if(size > MAX_BYTES) throw fail('file_too_large');
  }
  function partCount(size){ checkSize(size); return Math.ceil(size / PART_BYTES); }
  function partSize(total, number){
    var count = partCount(total);
    if(!Number.isSafeInteger(number) || number < 1 || number > count) throw fail('invalid_parts');
    return number === count ? total - (number - 1) * PART_BYTES : PART_BYTES;
  }
  function partRanges(total){
    var count = partCount(total), ranges = [];
    for(var number = 1; number <= count; number++){
      var start = (number - 1) * PART_BYTES;
      ranges.push({number: number, start: start, end: start + partSize(total, number), sizeBytes: partSize(total, number)});
    }
    return ranges;
  }
  function batches(list, size){
    var out = [];
    for(var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }
  var UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function formatBytes(bytes){
    var n = Number(bytes);
    if(!Number.isFinite(n) || n < 0) return '';
    var unit = 0;
    while(n >= 1000 && unit < UNITS.length - 1){ n /= 1000; unit++; }
    return (unit === 0 || n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + UNITS[unit];
  }

  // ---- File name and type the Hub will accept ---------------------------------
  function safeFilename(name){
    var clean = String(name || '').replace(/[\x00-\x1f\x7f\/\\]/g, '_').trim();
    if(!clean) clean = 'file';
    if(clean.length > 255){
      var dot = clean.lastIndexOf('.'), ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
      clean = clean.slice(0, 255 - ext.length) + ext;
    }
    return clean;
  }
  function contentTypeOf(type){
    var value = String(type || '').split(';')[0].trim().toLowerCase();
    return value.length <= 120 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value) ? value : 'application/octet-stream';
  }

  // ---- SHA-256, incremental ---------------------------------------------------
  // WebCrypto only hashes a whole buffer at once, which would mean holding a
  // 500 MB file in memory. This hashes it one part at a time.
  var K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function Sha256(){
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer = new Uint8Array(64);
    this.filled = 0;
    this.length = 0;
    this.w = new Uint32Array(64);
  }
  Sha256.prototype.block = function(data, offset){
    var w = this.w, h = this.h, i;
    for(i = 0; i < 16; i++, offset += 4) w[i] = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    for(; i < 64; i++){
      var a = w[i - 15], b = w[i - 2];
      var s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      var s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
    for(i = 0; i < 64; i++){
      var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      var t1 = (H + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
      var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      var t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0;
    h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + G) | 0; h[7] = (h[7] + H) | 0;
  };
  Sha256.prototype.update = function(bytes){
    var offset = 0, length = bytes.length;
    this.length += length;
    if(this.filled){
      var take = Math.min(64 - this.filled, length);
      this.buffer.set(bytes.subarray(0, take), this.filled);
      this.filled += take; offset = take;
      if(this.filled < 64) return this;
      this.block(this.buffer, 0); this.filled = 0;
    }
    for(; offset + 64 <= length; offset += 64) this.block(bytes, offset);
    if(offset < length){ this.buffer.set(bytes.subarray(offset), 0); this.filled = length - offset; }
    return this;
  };
  Sha256.prototype.digestHex = function(){
    var bits = this.length * 8, pad = new Uint8Array(this.filled < 56 ? 64 - this.filled : 128 - this.filled);
    pad[0] = 0x80;
    var high = Math.floor(bits / 4294967296), low = bits >>> 0, end = pad.length;
    pad[end - 8] = high >>> 24; pad[end - 7] = high >>> 16; pad[end - 6] = high >>> 8; pad[end - 5] = high;
    pad[end - 4] = low >>> 24; pad[end - 3] = low >>> 16; pad[end - 2] = low >>> 8; pad[end - 1] = low;
    var length = this.length;
    this.update(pad);
    this.length = length;
    var out = '';
    for(var i = 0; i < 8; i++) out += ('00000000' + this.h[i].toString(16)).slice(-8);
    return out;
  };
  function toHex(buffer){
    var bytes = new Uint8Array(buffer), out = '';
    for(var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }
  function subtleOf(options){ return (options && options.subtle) || (root.crypto && root.crypto.subtle) || null; }
  async function sha256Hex(bytes, subtle){
    if(subtle) return toHex(await subtle.digest('SHA-256', bytes));
    return new Sha256().update(bytes).digestHex();
  }
  function checksumBase64(hex){
    var binary = '';
    for(var i = 0; i < hex.length; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return (root.btoa || function(value){ return Buffer.from(value, 'binary').toString('base64'); })(binary);
  }
  function throwIfAborted(signal){ if(signal && signal.aborted) throw fail('aborted'); }
  // One pass over the file: the whole-file hash the Hub stores, and one hash per
  // part. A file is read a part at a time, never all at once.
  async function hashFile(file, options){
    options = options || {};
    var total = file.size, ranges = partRanges(total), whole = new Sha256(), subtle = subtleOf(options), parts = [];
    for(var i = 0; i < ranges.length; i++){
      throwIfAborted(options.signal);
      var range = ranges[i];
      var bytes = new Uint8Array(await file.slice(range.start, range.end).arrayBuffer());
      if(bytes.length !== range.sizeBytes) throw fail('file_changed');
      whole.update(bytes);
      parts.push({number: range.number, sizeBytes: range.sizeBytes, sha256: await sha256Hex(bytes, subtle)});
      if(options.onProgress) options.onProgress(range.end, total);
    }
    return {sha256: whole.digestHex(), parts: parts};
  }

  // ---- Link and header checks ---------------------------------------------------
  // A signed link must point at this team's own bucket, over https, at this
  // file's own key, before anything is sent to it or read from it.
  function validateS3Url(raw, expected){
    expected = expected || {};
    var url;
    try { url = new URL(String(raw)); } catch(_){ throw fail('unsafe_url'); }
    if(String(raw).length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw fail('unsafe_url');
    if(!ID.test(expected.teamId || '') || !ID.test(expected.fileId || '') || !ID.test(expected.spaceId || '')) throw fail('unsafe_url');
    var host = new RegExp('^mia-hub-files-[0-9]{12}-' + expected.teamId + '\\.s3\\.us-east-1\\.amazonaws\\.com$');
    if(!host.test(url.hostname)) throw fail('unsafe_url');
    if(url.pathname !== '/spaces/' + expected.spaceId + '/' + expected.fileId) throw fail('unsafe_url');
    return url.toString();
  }
  // The only request headers a page may not set itself.
  var FORBIDDEN_HEADER = /^(?:accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/;
  // Keep the checksum header (it must be ours), drop forbidden ones such as
  // Content-Length (the browser sets that from the body), refuse anything else.
  function partHeaders(returned, sha256){
    var out = {};
    if(!returned || typeof returned !== 'object' || Array.isArray(returned)) throw fail('unsafe_headers');
    Object.keys(returned).forEach(function(key){
      var name = key.toLowerCase(), value = returned[key];
      if(FORBIDDEN_HEADER.test(name)) return;
      if(!/^x-amz-[a-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) throw fail('unsafe_headers');
      out[name] = value;
    });
    if(out['x-amz-checksum-sha256'] !== checksumBase64(sha256)) throw fail('unsafe_headers');
    return out;
  }

  // ---- Upload state machine -------------------------------------------------------
  // queued -> hashing -> reserving -> uploading -> completing -> scanning -> clean
  // A failed part or step stops in "failed" and can be retried where it stopped;
  // an upload cut short by closing the app is "interrupted" and resumes when the
  // same file is chosen again. A scan that finds something ends in "quarantined".
  var TRANSITIONS = {
    queued: {START: 'hashing', CANCEL: 'cancelled'},
    hashing: {HASHED: 'reserving', FAIL: 'failed', CANCEL: 'cancelled'},
    reserving: {RESERVED: 'uploading', FAIL: 'failed', CANCEL: 'cancelled'},
    uploading: {PARTS_DONE: 'completing', FAIL: 'failed', INTERRUPT: 'interrupted', EXPIRE: 'expired', CANCEL: 'cancelled'},
    completing: {COMPLETED: 'scanning', FAIL: 'failed', INTERRUPT: 'interrupted', EXPIRE: 'expired', CANCEL: 'cancelled'},
    scanning: {SCAN_CLEAN: 'clean', SCAN_BLOCKED: 'quarantined'},
    failed: {RETRY_HASH: 'hashing', RETRY_UPLOAD: 'uploading', RETRY_COMPLETE: 'completing', EXPIRE: 'expired', CANCEL: 'cancelled'},
    interrupted: {RESUME: 'hashing', EXPIRE: 'expired', CANCEL: 'cancelled'},
    clean: {}, quarantined: {}, cancelled: {}, expired: {},
  };
  var TERMINAL = ['clean', 'quarantined', 'cancelled', 'expired'];
  function transition(state, event){
    var next = TRANSITIONS[state] && TRANSITIONS[state][event];
    if(!next) throw fail('bad_transition', {from: state, event: event});
    return next;
  }

  // ---- Hub calls ----------------------------------------------------------------
  function createClient(options){
    var call = options.call, base = '/v1/teams/' + options.teamId;
    if(!ID.test(options.teamId || '')) throw fail('not_found');
    function fileId(id){ if(!ID.test(id || '')) throw fail('not_found'); return id; }
    return {
      teamId: options.teamId,
      usage: function(){
        return call('GET', base + '/files/usage').then(function(r){
          if(!r || !Number.isSafeInteger(r.usedBytes) || !Number.isSafeInteger(r.quotaBytes) || r.quotaBytes < 1) throw fail('bad_response');
          return {usedBytes: r.usedBytes, quotaBytes: r.quotaBytes};
        });
      },
      list: function(kind, spaceId, cursor){
        if(SPACE_KINDS.indexOf(kind) < 0 || !ID.test(spaceId || '')) throw fail('not_found');
        if(cursor != null && !CURSOR.test(cursor)) throw fail('invalid_cursor');
        var path = base + '/file-spaces/' + kind + '/' + spaceId + '/files' + (cursor ? '/before/' + cursor : '');
        return call('GET', path).then(function(r){
          if(!r || !Array.isArray(r.files)) throw fail('bad_response');
          var files = r.files.filter(function(f){
            return f && ID.test(f.fileId) && typeof f.filename === 'string' && Number.isSafeInteger(f.sizeBytes) && HEX64.test(f.sha256 || '');
          }).map(function(f){
            return {fileId: f.fileId, filename: f.filename, contentType: String(f.contentType || ''), sizeBytes: f.sizeBytes, sha256: f.sha256,
              createdAt: Number(f.createdAt) || 0, spaceKind: kind, spaceId: spaceId};
          });
          return {files: files, nextCursor: typeof r.nextCursor === 'string' && CURSOR.test(r.nextCursor) ? r.nextCursor : null};
        });
      },
      reserve: function(body){
        return call('POST', base + '/files/uploads', body).then(function(r){
          if(!r || !ID.test(r.fileId || '') || !Number.isSafeInteger(r.partBytes) || !Number.isSafeInteger(r.partCount)) throw fail('bad_response');
          return {fileId: r.fileId, partBytes: r.partBytes, partCount: r.partCount, expiresAt: Number(r.expiresAt) || 0};
        });
      },
      signParts: function(id, parts){
        return call('POST', base + '/files/' + fileId(id) + '/parts', {parts: parts}).then(function(r){
          if(!r || !Array.isArray(r.parts)) throw fail('bad_response');
          return r.parts;
        });
      },
      complete: function(id, parts){
        return call('POST', base + '/files/' + fileId(id) + '/complete', {parts: parts}).then(function(r){
          if(!r || r.scanStatus !== 'PENDING') throw fail('bad_response');
          return r;
        });
      },
      status: function(id){ return call('GET', base + '/files/' + fileId(id) + '/status'); },
      download: function(id){
        return call('GET', base + '/files/' + fileId(id) + '/download').then(function(r){
          if(!r || typeof r.url !== 'string' || !HEX64.test(r.sha256 || '')) throw fail('bad_response');
          return r;
        });
      },
      remove: function(id){ return call('DELETE', base + '/files/' + fileId(id), {}); },
    };
  }

  // ---- What this computer remembers -----------------------------------------------
  // Uploads still in flight and the files this person added (the list does not
  // say who added what). Kept per team; read back defensively.
  var STATES_STORED = ['uploading', 'completing', 'interrupted', 'scanning', 'quarantined'];
  function createStore(storage){
    var PREFIX = 'mia.teamFiles.v1:';
    function read(teamId){
      try {
        var data = JSON.parse(storage.getItem(PREFIX + teamId) || '{}');
        var records = (Array.isArray(data.records) ? data.records : []).filter(validRecord).slice(0, 100);
        var mine = (Array.isArray(data.mine) ? data.mine : []).filter(function(id){ return ID.test(id); }).slice(0, 500);
        return {records: records, mine: mine};
      } catch(_){ return {records: [], mine: []}; }
    }
    function write(teamId, data){ try { storage.setItem(PREFIX + teamId, JSON.stringify(data)); } catch(_){} }
    function validRecord(r){
      return r && ID.test(r.fileId) && ID.test(r.spaceId) && UPLOAD_KINDS.indexOf(r.spaceKind) >= 0 && typeof r.filename === 'string'
        && Number.isSafeInteger(r.sizeBytes) && HEX64.test(r.sha256 || '') && STATES_STORED.indexOf(r.state) >= 0
        && r.parts && typeof r.parts === 'object' && !Array.isArray(r.parts);
    }
    return {
      records: function(teamId){ return read(teamId).records; },
      isMine: function(teamId, id){ return read(teamId).mine.indexOf(id) >= 0; },
      save: function(teamId, record){
        var data = read(teamId);
        data.records = data.records.filter(function(r){ return r.fileId !== record.fileId; });
        data.records.unshift(record);
        if(data.mine.indexOf(record.fileId) < 0) data.mine.unshift(record.fileId);
        write(teamId, data);
      },
      drop: function(teamId, id, keepMine){
        var data = read(teamId);
        data.records = data.records.filter(function(r){ return r.fileId !== id; });
        if(!keepMine) data.mine = data.mine.filter(function(x){ return x !== id; });
        write(teamId, data);
      },
    };
  }

  // ---- Uploading ---------------------------------------------------------------------
  function sleepFor(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }
  async function pool(items, limit, worker){
    var index = 0, failure = null;
    async function lane(){
      while(index < items.length && !failure){
        var item = items[index++];
        try { await worker(item); } catch(error){ failure = failure || error; }
      }
    }
    var lanes = [];
    for(var i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane());
    await Promise.all(lanes);
    if(failure) throw failure;
  }

  // Runs one team's uploads, one file at a time, and watches for scan results.
  // options: client, store, teamId, space {kind,id}, fetch, subtle, sleep, now,
  // onChange(jobs). `file` objects only need size, name, type and slice().
  function createManager(options){
    var client = options.client, store = options.store, teamId = options.teamId, space = options.space;
    var fetcher = options.fetch || (root.fetch && root.fetch.bind(root)), sleep = options.sleep || sleepFor;
    var now = options.now || function(){ return Date.now(); };
    var jobs = [], running = false, counter = 0;

    function emit(){ if(options.onChange) options.onChange(jobs.slice()); }
    function apply(job, event){ job.state = transition(job.state, event); persist(job); emit(); }
    function persist(job){
      var r = job.record;
      if(!r) return;
      if(STATES_STORED.indexOf(job.state) < 0) return;
      r.state = job.state;
      store.save(teamId, r);
    }
    function newJob(file, record){
      var job = {id: 'upload-' + (++counter), file: file || null, record: record || null, state: 'queued', hash: null,
        filename: record ? record.filename : safeFilename(file.name), sizeBytes: record ? record.sizeBytes : file.size,
        doneBytes: 0, hashedBytes: 0, error: null, failedAt: null, abort: null, runnable: !record};
      if(record){
        job.doneBytes = Object.keys(record.parts).reduce(function(sum, n){ return sum + partSize(record.sizeBytes, Number(n)); }, 0);
      }
      return job;
    }
    function setError(job, error){
      job.error = {code: error.code || '', message: friendly(error)};
    }

    async function reserve(job){
      var hash = job.hash;
      var body = {spaceKind: space.kind, spaceId: space.id, sizeBytes: job.sizeBytes, sha256: hash.sha256,
        filename: job.filename, contentType: contentTypeOf(job.file.type)};
      // A team workflow's file belongs to one run's automation space.
      if(space.runId) body.runId = space.runId;
      var reply = await client.reserve(body);
      // Cancelled while the Hub was answering: it has only now said what to release.
      if(job.abort.signal.aborted){
        client.remove(reply.fileId).catch(function(){});
        throw fail('aborted');
      }
      var count = partCount(job.sizeBytes);
      if(reply.partBytes !== PART_BYTES || reply.partCount !== count){
        // The Hub's plan is not the one Mia hashed for; release it and stop.
        client.remove(reply.fileId).catch(function(){});
        throw fail('part_mismatch');
      }
      job.record = {fileId: reply.fileId, spaceKind: space.kind, spaceId: space.id, filename: job.filename, contentType: contentTypeOf(job.file.type),
        sizeBytes: job.sizeBytes, sha256: hash.sha256, state: 'uploading', parts: {}, expiresAt: reply.expiresAt, createdAt: Math.floor(now() / 1000)};
    }

    async function putPart(job, signed, range, partHash){
      var url = validateS3Url(signed.url, {teamId: teamId, spaceId: job.record.spaceId, fileId: job.record.fileId});
      var headers = partHeaders(signed.headers, partHash);
      var attempt = 0, lastCode = 'part_failed';
      while(attempt < PART_ATTEMPTS){
        throwIfAborted(job.abort.signal);
        try {
          var response = await fetcher(url, {method: 'PUT', headers: headers, body: job.file.slice(range.start, range.end),
            credentials: 'omit', redirect: 'error', signal: job.abort.signal});
          if(response.ok){
            var etag = response.headers && response.headers.get('etag');
            if(!etag || etag.length > 128 || /[\x00-\x1f\x7f]/.test(etag)) throw fail('storage_unreadable', {fatal: true});
            return etag;
          }
          // 400: the bytes do not match their hash, so the file changed. 403:
          // the link expired; the caller asks for a fresh one.
          if(response.status === 400) throw fail('part_rejected', {fatal: true});
          if(response.status === 403) throw fail('upload_expired', {expiredLink: true});
          lastCode = 'part_failed';
        } catch(error){
          if(error.fatal || error.expiredLink || (job.abort.signal.aborted)) throw error;
          lastCode = 'part_failed';
        }
        attempt++;
        if(attempt < PART_ATTEMPTS) await sleep(RETRY_DELAYS[attempt - 1] || 4000);
      }
      throw fail(lastCode, {part: range.number});
    }

    async function uploadParts(job){
      var record = job.record, ranges = partRanges(job.sizeBytes);
      var hashes = {};
      job.hash.parts.forEach(function(p){ hashes[p.number] = p.sha256; });
      var todo = ranges.filter(function(r){ return !record.parts[r.number]; });
      for(const b of batches(todo, PARTS_PER_REQUEST)){
        throwIfAborted(job.abort.signal);
        var signedList = await client.signParts(record.fileId, b.map(function(r){ return {number: r.number, sizeBytes: r.sizeBytes, sha256: hashes[r.number]}; }));
        var byNumber = {};
        signedList.forEach(function(s){ if(s && Number.isSafeInteger(s.number)) byNumber[s.number] = s; });
        await pool(b, PART_PARALLEL, async function(range){
          var signed = byNumber[range.number];
          if(!signed || typeof signed.url !== 'string') throw fail('bad_response');
          var etag;
          try { etag = await putPart(job, signed, range, hashes[range.number]); }
          catch(error){
            if(!error.expiredLink) throw error;
            // Links last five minutes; ask for one fresh link and try once more.
            var again = (await client.signParts(record.fileId, [{number: range.number, sizeBytes: range.sizeBytes, sha256: hashes[range.number]}]))[0];
            etag = await putPart(job, again || {}, range, hashes[range.number]);
          }
          record.parts[range.number] = etag;
          job.doneBytes += range.sizeBytes;
          persist(job); emit();
        });
      }
    }

    async function completeUpload(job){
      var record = job.record, list = partRanges(job.sizeBytes).map(function(r){
        return {number: r.number, etag: record.parts[r.number], sha256: job.hash.parts[r.number - 1].sha256};
      });
      if(list.some(function(p){ return !p.etag; })) throw fail('upload_incomplete');
      await client.complete(record.fileId, list);
    }

    async function drive(job){
      job.runnable = false;
      job.abort = typeof AbortController === 'function' ? new AbortController() : {signal: {aborted: false}, abort: function(){ this.signal.aborted = true; }};
      job.error = null;
      try {
        if(job.state === 'queued') apply(job, 'START');
        if(job.state === 'hashing'){
          job.failedAt = 'hashing';
          job.hash = await hashFile(job.file, {subtle: options.subtle, signal: job.abort.signal, onProgress: function(done){ job.hashedBytes = done; emit(); }});
          if(job.record && job.record.sha256 !== job.hash.sha256) throw fail('file_changed');
          apply(job, 'HASHED');
        }
        if(job.state === 'reserving'){
          job.failedAt = 'reserving';
          if(!job.record) await reserve(job);
          apply(job, 'RESERVED');
        }
        if(job.state === 'uploading'){
          job.failedAt = 'uploading';
          await uploadParts(job);
          apply(job, 'PARTS_DONE');
        }
        if(job.state === 'completing'){
          job.failedAt = 'completing';
          await completeUpload(job);
          apply(job, 'COMPLETED');
        }
      } catch(error){
        if(job.abort.signal.aborted || error.code === 'aborted'){
          if(TRANSITIONS[job.state] && TRANSITIONS[job.state].CANCEL) job.state = 'cancelled';
        } else if(error.code === 'upload_closed' && job.record){
          job.state = 'expired'; setError(job, error); store.drop(teamId, job.record.fileId);
        } else {
          setError(job, error);
          if(TRANSITIONS[job.state] && TRANSITIONS[job.state].FAIL) job.state = 'failed';
          if(job.record && job.record.fileId) persist(Object.assign({}, job, {state: job.failedAt === 'completing' ? 'completing' : 'uploading'}));
        }
        emit();
      }
    }

    async function pump(){
      if(running) return;
      running = true;
      try {
        for(var job = nextRunnable(); job; job = nextRunnable()) await drive(job);
      } finally { running = false; emit(); }
    }
    // One file at a time, in the order they were added or retried.
    function nextRunnable(){ return jobs.filter(function(j){ return j.runnable; })[0] || null; }

    var self = {
      jobs: function(){ return jobs.slice(); },
      // Files the person picked; each is checked before it is queued.
      add: function(files){
        var rejected = [];
        Array.prototype.slice.call(files || []).forEach(function(file){
          try { checkSize(file.size); } catch(error){ rejected.push({filename: safeFilename(file.name), message: friendly(error), code: error.code}); return; }
          jobs.push(newJob(file));
        });
        emit(); pump();
        return rejected;
      },
      retry: function(id){
        var job = jobs.filter(function(j){ return j.id === id; })[0];
        if(!job || job.state !== 'failed') return;
        var event = job.failedAt === 'completing' ? 'RETRY_COMPLETE' : job.failedAt === 'uploading' && job.hash ? 'RETRY_UPLOAD' : 'RETRY_HASH';
        job.error = null; job.abort = null;
        job.state = transition(job.state, event);
        job.runnable = true;
        emit(); pump();
      },
      // An interrupted upload continues when the same file is chosen again.
      resume: function(id, file){
        var job = jobs.filter(function(j){ return j.id === id; })[0];
        if(!job || job.state !== 'interrupted') return {ok: false};
        if(!file || file.size !== job.sizeBytes) return {ok: false, message: errorMessage('file_changed')};
        job.file = file; job.abort = null; job.error = null;
        job.state = transition(job.state, 'RESUME');
        job.runnable = true;
        emit(); pump();
        return {ok: true};
      },
      cancel: function(id){
        var job = jobs.filter(function(j){ return j.id === id; })[0];
        if(!job) return;
        if(job.abort) job.abort.abort();
        job.runnable = false;
        if(TRANSITIONS[job.state] && TRANSITIONS[job.state].CANCEL) job.state = 'cancelled';
        // Release the reserved space and stop the multipart upload.
        if(job.record && job.record.fileId){ client.remove(job.record.fileId).catch(function(){}); store.drop(teamId, job.record.fileId); }
        emit();
      },
      dismiss: function(id){ jobs = jobs.filter(function(j){ return j.id !== id; }); emit(); },
      // Uploads cut short by closing the app, and files still being scanned.
      restore: function(){
        var nowSeconds = Math.floor(now() / 1000);
        store.records(teamId).filter(function(r){ return r.spaceKind === space.kind && r.spaceId === space.id; }).forEach(function(record){
          if(jobs.some(function(j){ return j.record && j.record.fileId === record.fileId; })) return;
          var job = newJob(null, record);
          if(record.state === 'scanning' || record.state === 'quarantined') job.state = record.state;
          else if(record.expiresAt && record.expiresAt <= nowSeconds){ job.state = 'expired'; job.error = {code: 'upload_expired', message: errorMessage('upload_expired')}; store.drop(teamId, record.fileId); }
          else job.state = 'interrupted';
          jobs.push(job);
        });
        emit();
      },
      // One look at every scanning file. Returns true when something changed.
      checkScans: async function(){
        var changed = false;
        var scanning = jobs.filter(function(j){ return j.state === 'scanning'; });
        for(const job of scanning){
          var reply;
          try { reply = await client.status(job.record.fileId); }
          catch(error){
            if(error && (error.status === 404 || error.code === 'not_found')){ job.state = 'cancelled'; store.drop(teamId, job.record.fileId); changed = true; }
            continue;
          }
          var verdict = scanVerdict(reply);
          if(verdict === 'clean'){ job.state = 'clean'; store.drop(teamId, job.record.fileId, true); changed = true; }
          else if(verdict === 'blocked'){ job.state = 'quarantined'; job.record.state = 'quarantined'; store.save(teamId, job.record); changed = true; }
        }
        if(changed) emit();
        return changed;
      },
      hasScanning: function(){ return jobs.some(function(j){ return j.state === 'scanning'; }); },
      // Throw away a finished record (clean or blocked) from the list.
      forget: function(id){
        var job = jobs.filter(function(j){ return j.id === id; })[0];
        if(job && job.record) store.drop(teamId, job.record.fileId);
        self.dismiss(id);
      },
    };
    return self;
  }
  function scanVerdict(reply){
    if(!reply) return 'pending';
    if(reply.scanStatus === 'NO_THREATS_FOUND' || reply.state === 'ready') return 'clean';
    if(reply.state === 'quarantined' || ['THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'].indexOf(reply.scanStatus) >= 0) return 'blocked';
    return 'pending';
  }

  // ---- Downloading ---------------------------------------------------------------------
  // The Hub hands out a link only after a clean scan. S3's own hash of a
  // multipart file is composite, so the whole-file SHA-256 is checked here.
  async function downloadFile(options){
    var file = options.file, client = options.client, fetcher = options.fetch || root.fetch.bind(root);
    var reply = await client.download(file.fileId);
    if(file.sha256 && reply.sha256 !== file.sha256) throw fail('integrity_failed');
    var url = validateS3Url(reply.url, {teamId: client.teamId, spaceId: file.spaceId, fileId: file.fileId});
    var response;
    try { response = await fetcher(url, {method: 'GET', credentials: 'omit', redirect: 'error', signal: options.signal}); }
    catch(_){ throw fail('download_failed'); }
    if(!response.ok || !response.body) throw fail('download_failed');
    var reader = response.body.getReader(), hasher = new Sha256(), chunks = [], received = 0;
    for(;;){
      throwIfAborted(options.signal);
      var step = await reader.read();
      if(step.done) break;
      received += step.value.length;
      if(received > file.sizeBytes) { try { reader.cancel(); } catch(_){} throw fail('integrity_failed'); }
      hasher.update(step.value);
      chunks.push(step.value);
      if(options.onProgress) options.onProgress(received, file.sizeBytes);
    }
    if(received !== file.sizeBytes || hasher.digestHex() !== reply.sha256) throw fail('integrity_failed');
    return new Blob(chunks, {type: 'application/octet-stream'});
  }

  return {
    MAX_BYTES: MAX_BYTES, PART_BYTES: PART_BYTES, PARTS_PER_REQUEST: PARTS_PER_REQUEST, TERMINAL: TERMINAL,
    partCount: partCount, partSize: partSize, partRanges: partRanges, batches: batches, formatBytes: formatBytes,
    safeFilename: safeFilename, contentTypeOf: contentTypeOf, Sha256: Sha256, hashFile: hashFile, checksumBase64: checksumBase64,
    validateS3Url: validateS3Url, partHeaders: partHeaders, transition: transition, errorMessage: errorMessage, friendly: friendly,
    deleteErrorMessage: deleteErrorMessage, createClient: createClient, createStore: createStore, createManager: createManager,
    scanVerdict: scanVerdict, downloadFile: downloadFile,
  };
});
