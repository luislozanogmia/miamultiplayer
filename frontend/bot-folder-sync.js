(function(root){
  'use strict';
  // A shared bot's shared folder, kept the same for everyone who uses it.
  // The company's copy lives on the Hub (its folder routes); this computer's
  // copy is <bot working folder>/shared (/api/bots/:id/shared-folder). Before
  // a run: pull what changed. After it: push what changed. When someone else
  // changed the same file meanwhile, both versions are kept, never one
  // overwritten: this run's becomes "name (<who>'s run).ext".

  var MAX_COMMIT = 500;

  function conflictName(path, who){
    var slash = path.lastIndexOf('/'), dir = slash >= 0 ? path.slice(0, slash + 1) : '', name = path.slice(slash + 1);
    var dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    var label = String(who || 'my').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'my';
    return dir + stem + ' (' + label + (label === 'my' ? ' run' : '’s run') + ')' + ext;
  }

  function base64ToBytes(value){
    var binary = root.atob(value), bytes = new Uint8Array(binary.length);
    for(var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function bytesToBase64(bytes){
    var out = '', chunk = 0x8000;
    for(var i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return root.btoa(out);
  }

  // options: api (the app's), hubCall, teamFiles (MiaTeamFiles), fetch, who
  // (a first name for conflict copies), sleep.
  function createSync(options){
    var api = options.api, hubCall = options.hubCall, TF = options.teamFiles;
    var fetcher = options.fetch || (root.fetch && root.fetch.bind(root));
    var sleep = options.sleep || function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };

    function local(botId, suffix){ return '/api/bots/' + encodeURIComponent(botId) + '/shared-folder' + (suffix || ''); }
    function check(res, fallback){
      if(!res || res.status < 200 || res.status >= 300) throw new Error(res && res.data && res.data.message || fallback);
      return res.data || {};
    }
    function folderPath(source){ return '/v1/teams/' + source.teamId + '/market/bots/' + encodeURIComponent(source.botId) + '/folder'; }

    function readLocal(botId){ return api(local(botId)).then(function(res){ return check(res, 'The shared folder could not be read.'); }); }
    function saveState(botId, state){ return api(local(botId, '/state'), {method: 'PUT', body: state}).then(function(res){ return check(res, 'The shared folder could not be saved.'); }); }

    // One file from the company's copy into this computer's.
    function download(source, botId, file){
      var client = TF.createClient({call: hubCall, teamId: source.teamId});
      return client.download(file.file_id).then(function(link){
        return fetcher(link.url, {credentials: 'omit', redirect: 'error'});
      }).then(function(response){
        if(!response.ok) throw new Error('A shared file could not be downloaded.');
        return response.arrayBuffer();
      }).then(function(buffer){
        return api(local(botId, '/file'), {method: 'PUT', body: {path: file.path, contentBase64: bytesToBase64(new Uint8Array(buffer))}});
      }).then(function(res){ check(res, 'A shared file could not be saved on this computer.'); });
    }

    // One file from this computer into the company's file storage, through
    // the same upload (parts, scan) as any company file. -> {file_id, sha256, size_bytes}
    function upload(source, folder, botId, path){
      return api(local(botId, '/file') + '?path=' + encodeURIComponent(path)).then(function(res){
        var bytes = base64ToBytes(check(res, 'A shared file could not be read.').contentBase64);
        var name = path.slice(path.lastIndexOf('/') + 1);
        var file = new root.File([bytes], name, {type: 'application/octet-stream'});
        var client = TF.createClient({call: hubCall, teamId: source.teamId});
        var store = TF.createStore({getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}});
        return new Promise(function(resolve, reject){
          var manager = TF.createManager({client: client, store: store, teamId: source.teamId, fetch: fetcher, sleep: sleep,
            space: {kind: folder.space_kind || 'bot', id: folder.space_id},
            onChange: function(jobs){
              var job = jobs[0];
              if(!job) return;
              if(job.state === 'clean') resolve({file_id: job.record.fileId, sha256: job.record.sha256, size_bytes: job.record.sizeBytes});
              else if(['quarantined', 'failed', 'cancelled', 'expired'].indexOf(job.state) >= 0){
                reject(new Error(job.state === 'quarantined' ? '"' + path + '" was blocked by the file scan.' : (job.error && job.error.message) || '"' + path + '" didn’t upload.'));
              }
            }});
          var refused = manager.add([file]);
          if(refused.length) reject(new Error(refused[0].message));
        });
      });
    }

    // Before a run. -> {revision, changed} (changed: paths written here)
    function pull(bot){
      var source = bot && bot.marketSource;
      if(!source || !source.folder) return Promise.resolve(null);
      return Promise.all([readLocal(bot.id), hubCall('GET', folderPath(source))]).then(function(both){
        var mine = both[0], remote = both[1] || {};
        if(remote.enabled === false) return {revision: mine.state.revision, changed: []};
        var known = mine.state.files || {}, here = {};
        (mine.files || []).forEach(function(file){ here[file.path] = file.sha256; });
        var changed = [], files = {}, work = [];
        (remote.files || []).forEach(function(file){
          files[file.path] = file.sha256;
          if(here[file.path] === file.sha256) return;
          // Changed here since the last sync and there: keep this computer's as a copy first.
          var keepMine = here[file.path] && here[file.path] !== known[file.path];
          work.push(function(){
            var first = keepMine ? api(local(bot.id, '/file') + '?path=' + encodeURIComponent(file.path)).then(function(res){
              return api(local(bot.id, '/file'), {method: 'PUT', body: {path: conflictName(file.path, options.who), contentBase64: check(res, 'A shared file could not be read.').contentBase64}});
            }) : Promise.resolve();
            return first.then(function(){ return download(source, bot.id, file); }).then(function(){ changed.push(file.path); });
          });
        });
        // Gone from the company's copy and unchanged here since: remove here too.
        Object.keys(known).forEach(function(path){
          if(files[path] || here[path] !== known[path]) return;
          work.push(function(){ return api(local(bot.id, '/file') + '?path=' + encodeURIComponent(path), {method: 'DELETE'}).then(function(){ changed.push(path); }); });
        });
        return work.reduce(function(done, step){ return done.then(step); }, Promise.resolve()).then(function(){
          return saveState(bot.id, {revision: Number(remote.revision) || 0, files: files});
        }).then(function(){ return {revision: Number(remote.revision) || 0, changed: changed}; });
      });
    }

    // After a run. -> {revision, put, removed, copies}
    function push(bot, attempt){
      var source = bot && bot.marketSource;
      if(!source || !source.folder) return Promise.resolve(null);
      attempt = attempt || 0;
      return Promise.all([readLocal(bot.id), hubCall('GET', folderPath(source))]).then(function(both){
        var mine = both[0], folder = both[1] || {};
        if(folder.enabled === false) return null;
        var known = mine.state.files || {}, base = mine.state.revision || 0;
        var put = (mine.files || []).filter(function(file){ return known[file.path] !== file.sha256; }).map(function(file){ return file.path; });
        var here = {};
        (mine.files || []).forEach(function(file){ here[file.path] = file.sha256; });
        var removed = Object.keys(known).filter(function(path){ return !here[path]; });
        if(!put.length && !removed.length) return {revision: base, put: [], removed: [], copies: []};
        if(put.length + removed.length > MAX_COMMIT) throw new Error('Too many shared files changed in one run (' + (put.length + removed.length) + '). Up to ' + MAX_COMMIT + ' sync at once.');
        var uploaded = [];
        return put.reduce(function(done, path){
          return done.then(function(){ return upload(source, folder, bot.id, path).then(function(file){ uploaded.push(Object.assign({path: path}, file)); }); });
        }, Promise.resolve()).then(function(){
          return hubCall('POST', folderPath(source) + '/commit', {base_revision: base, put: uploaded, remove: removed});
        }).then(function(result){
          var files = Object.assign({}, known);
          uploaded.forEach(function(file){ files[file.path] = file.sha256; });
          removed.forEach(function(path){ delete files[path]; });
          var revision = Number(result && result.revision) || base + 1;
          return saveState(bot.id, {revision: revision, files: files}).then(function(){ return {revision: revision, put: put, removed: removed, copies: []}; });
        }, function(error){
          if(!error || error.code !== 'folder_conflict' && !(error.data && error.data.error === 'folder_conflict')) throw error;
          if(attempt >= 2) throw new Error('The shared folder kept changing while this run saved. Your files are still here; they sync after the next run.');
          // Someone changed the same files meanwhile: this run's go under a copy name,
          // the company's come back, and the copies are pushed.
          var paths = (error.data && error.data.paths) || error.paths || [];
          return paths.filter(function(path){ return here[path]; }).reduce(function(done, path){
            return done.then(function(){
              return api(local(bot.id, '/file') + '?path=' + encodeURIComponent(path)).then(function(res){
                return api(local(bot.id, '/file'), {method: 'PUT', body: {path: conflictName(path, options.who), contentBase64: check(res, 'A shared file could not be read.').contentBase64}});
              });
            });
          }, Promise.resolve()).then(function(){
            var state = {revision: base, files: Object.assign({}, known)};
            paths.forEach(function(path){ state.files[path] = here[path]; });
            return saveState(bot.id, state);
          }).then(function(){ return pull(bot); }).then(function(){ return push(bot, attempt + 1); }).then(function(result){
            return Object.assign({}, result, {copies: paths.map(function(path){ return conflictName(path, options.who); })});
          });
        });
      });
    }

    return {pull: pull, push: push};
  }

  root.MiaBotFolderSync = {createSync: createSync, conflictName: conflictName};
})(typeof window !== 'undefined' ? window : globalThis);
