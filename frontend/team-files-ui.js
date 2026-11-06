(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaTeamFilesUi = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  // The Team files screen: one panel for the files of a channel, group or direct
  // message, the same in every view. Markup is pure (bodyHtml) so it can be
  // tested; the controller below wires it to the Hub through MiaTeamFiles.
  var tf = root.MiaTeamFiles || (typeof require === 'function' ? require('./team-files.js') : null);

  function escape(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  function percent(done, total){ return total > 0 ? Math.max(0, Math.min(100, Math.floor(done * 100 / total))) : 0; }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function whenFallback(ms, now){
    var age = Math.max(0, (now || Date.now()) - ms);
    if(age < 60000) return 'just now';
    if(age < 3600000) return Math.floor(age / 60000) + 'm ago';
    if(age < 86400000) return Math.floor(age / 3600000) + 'h ago';
    if(age < 172800000) return 'yesterday';
    var date = new Date(ms);
    return MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  // What each upload step says to the person.
  function jobStatus(job){
    var total = job.sizeBytes;
    switch(job.state){
      case 'queued': return {text: 'Waiting', tone: ''};
      case 'hashing': return {text: 'Preparing… ' + percent(job.hashedBytes, total) + '%', tone: '', cancel: true};
      case 'reserving': return {text: 'Getting ready…', tone: '', cancel: true};
      case 'uploading': return {text: 'Uploading… ' + percent(job.doneBytes, total) + '%', tone: '', cancel: true};
      case 'completing': return {text: 'Finishing…', tone: '', cancel: true};
      case 'scanning': return {text: 'Scanning for viruses. You can open it here once it is clean.', tone: 'wait'};
      case 'failed': return {text: (job.error && job.error.message) || 'This upload stopped.', tone: 'bad', retry: true, cancel: true};
      case 'interrupted': return {text: 'This upload was interrupted. Choose the same file to continue where it stopped.', tone: 'bad', resume: true, cancel: true};
      case 'quarantined': return {text: 'Blocked. The virus scan did not pass, so nobody can open this file.', tone: 'bad', forget: true};
      case 'expired': return {text: (job.error && job.error.message) || 'This upload timed out. Start it again.', tone: 'bad', dismiss: true};
      default: return null;
    }
  }
  var SHOWN_JOBS = ['queued', 'hashing', 'reserving', 'uploading', 'completing', 'scanning', 'failed', 'interrupted', 'quarantined', 'expired'];

  function jobRowHtml(job, deps){
    var esc = deps.esc, status = jobStatus(job);
    if(!status) return '';
    var busy = ['hashing', 'uploading'].indexOf(job.state) >= 0;
    var bar = busy ? '<span class="tf-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'
      + percent(job.state === 'hashing' ? job.hashedBytes : job.doneBytes, job.sizeBytes) + '"><span style="width:'
      + percent(job.state === 'hashing' ? job.hashedBytes : job.doneBytes, job.sizeBytes) + '%"></span></span>' : '';
    var id = esc(job.id), name = esc(job.filename);
    var actions = '';
    if(status.retry) actions += '<button type="button" class="artifacts-bar-text-btn" data-tf-retry="' + id + '">Retry</button>';
    if(status.resume) actions += '<button type="button" class="artifacts-bar-text-btn" data-tf-resume="' + id + '">Choose file</button>';
    if(status.cancel) actions += '<button type="button" class="artifacts-bar-text-btn" data-tf-cancel="' + id + '" aria-label="Cancel ' + name + '">Cancel</button>';
    if(status.forget) actions += '<button type="button" class="artifacts-bar-text-btn" data-tf-forget="' + id + '" aria-label="Delete ' + name + '">Delete</button>';
    if(status.dismiss) actions += '<button type="button" class="artifacts-bar-text-btn" data-tf-dismiss="' + id + '">Dismiss</button>';
    return '<div class="artifacts-row tf-row tf-' + (status.tone || 'plain') + '" role="listitem" data-tf-job="' + id + '">'
      + '<span class="artifacts-thumb">' + esc(deps.fileKind(job.filename, '').label) + '</span>'
      + '<span class="artifacts-row-text"><span class="artifacts-row-name">' + name + '</span>'
      + '<span class="artifacts-row-meta">' + esc(tf.formatBytes(job.sizeBytes)) + ' · ' + esc(status.text) + '</span>' + bar + '</span>'
      + '<span class="tf-actions">' + actions + '</span></div>';
  }

  function fileRowHtml(file, view, deps){
    var esc = deps.esc, id = esc(file.fileId), name = esc(file.filename);
    var busy = view.busy && view.busy[file.fileId];
    var removable = view.isAdmin || (view.mine && view.mine(file.fileId));
    var meta = [tf.formatBytes(file.sizeBytes), file.createdAt ? deps.when(file.createdAt * 1000, view.now) : ''].filter(Boolean).join(' · ');
    if(busy) meta += ' · ' + busy;
    var tile = deps.fileKind(file.filename, file.contentType);
    return '<div class="artifacts-row tf-row" role="listitem">'
      + '<span class="artifacts-thumb"' + (tile.kind ? ' data-kind="' + esc(tile.kind) + '"' : '') + '>' + esc(tile.label) + '</span>'
      + '<span class="artifacts-row-text"><span class="artifacts-row-name">' + name + '</span>'
      + '<span class="artifacts-row-meta">' + esc(meta) + '</span></span>'
      + '<span class="tf-actions">'
      + '<button type="button" class="artifacts-bar-text-btn" data-tf-download="' + id + '"' + (busy ? ' disabled' : '') + ' aria-label="Download ' + name + '">Download</button>'
      + (removable ? '<button type="button" class="artifacts-bar-text-btn" data-tf-delete="' + id + '"' + (busy ? ' disabled' : '') + ' aria-label="Delete ' + name + '">Delete</button>' : '')
      + '</span></div>';
  }

  function usageHtml(usage, esc){
    if(!usage) return '';
    var used = percent(usage.usedBytes, usage.quotaBytes);
    return '<div class="tf-usage' + (used >= 90 ? ' tf-usage-high' : '') + '">'
      + '<div class="tf-usage-text">' + esc(tf.formatBytes(usage.usedBytes)) + ' of ' + esc(tf.formatBytes(usage.quotaBytes)) + ' used by your company</div>'
      + '<div class="tf-bar" role="progressbar" aria-label="Company file storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + used + '"><span style="width:' + Math.max(used, usage.usedBytes > 0 ? 1 : 0) + '%"></span></div></div>';
  }

  // view: {loading, error, notice, usage, files, jobs, nextCursor, loadingMore, isAdmin, mine(), busy{}, now}
  function bodyHtml(view, deps){
    deps = deps || {};
    var esc = deps.esc || escape;
    deps = {esc: esc, when: deps.when || whenFallback, fileKind: deps.fileKind || function(){ return {kind: '', label: 'file'}; }};
    var out = usageHtml(view.usage, esc);
    if(view.notice) out += '<div class="tf-notice" role="alert">' + esc(view.notice) + '</div>';
    if(view.unavailable){
      return out + '<div class="artifacts-empty"><div class="artifacts-empty-title">Company files are not available</div><div>' + esc(view.unavailable) + '</div></div>';
    }
    var jobs = (view.jobs || []).filter(function(job){ return SHOWN_JOBS.indexOf(job.state) >= 0; });
    if(jobs.length){
      out += '<div class="artifacts-section-title">Adding</div><div class="artifacts-list" role="list">'
        + jobs.map(function(job){ return jobRowHtml(job, deps); }).join('') + '</div>';
    }
    if(view.loading && !(view.files || []).length) return out + '<div class="artifacts-empty">Loading…</div>';
    if(view.error && !(view.files || []).length) return out + '<div class="artifacts-empty">' + esc(view.error) + '<br><button type="button" class="artifacts-empty-add" data-tf-reload>Try again</button></div>';
    if(!(view.files || []).length){
      return out + (jobs.length ? '' : '<div class="artifacts-empty"><div class="artifacts-empty-title">No files here yet</div>'
        + '<div>Files added here are shared with everyone in this conversation. Each one is scanned for viruses before anyone can open it, and shows up in this list once it passes.</div></div>');
    }
    out += '<div class="artifacts-section-title">Files</div><div class="artifacts-list" role="list">'
      + view.files.map(function(file){ return fileRowHtml(file, view, deps); }).join('') + '</div>';
    if(view.nextCursor) out += '<div class="tf-more"><button type="button" class="artifacts-bar-text-btn" data-tf-more' + (view.loadingMore ? ' disabled' : '') + '>'
      + (view.loadingMore ? 'Loading…' : 'Show older files') + '</button></div>';
    return out;
  }

  // ---- The panel -------------------------------------------------------------------------
  var panel = null, current = null, managers = {}, scanTimer = null, scanDelay = 3000;

  function el(id){ return root.document.getElementById(id); }
  function ensurePanel(){
    if(panel) return panel;
    var doc = root.document;
    panel = doc.createElement('div');
    panel.className = 'tf-overlay';
    panel.id = 'teamFilesOverlay';
    panel.hidden = true;
    panel.innerHTML = '<section class="tf-window" role="dialog" aria-modal="true" aria-labelledby="teamFilesTitle">'
      + '<header class="tf-head"><h2 id="teamFilesTitle">Files</h2>'
      + '<button type="button" class="artifacts-bar-text-btn primary" data-tf-add>Add files</button>'
      + '<button type="button" class="local-browser-btn automations-bar-btn" data-tf-close title="Close" aria-label="Close files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></header>'
      + '<div class="tf-body" id="teamFilesBody"></div>'
      + '<input type="file" id="teamFilesInput" multiple hidden></section>';
    doc.body.appendChild(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('keydown', function(event){ if(event.key === 'Escape'){ event.stopPropagation(); close(); } });
    panel.addEventListener('mousedown', function(event){ if(event.target === panel) close(); });
    panel.addEventListener('dragover', function(event){ event.preventDefault(); panel.classList.add('tf-drop'); });
    panel.addEventListener('dragleave', function(event){ if(event.target === panel) panel.classList.remove('tf-drop'); });
    panel.addEventListener('drop', function(event){
      event.preventDefault(); panel.classList.remove('tf-drop');
      if(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
    });
    el('teamFilesInput').addEventListener('change', function(event){
      var input = event.target, files = Array.prototype.slice.call(input.files || []), resume = input.getAttribute('data-resume');
      input.value = ''; input.removeAttribute('data-resume');
      if(!files.length || !current) return;
      if(resume){
        var result = current.manager.resume(resume, files[0]);
        if(!result.ok){ current.view.notice = result.message || tf.errorMessage('file_changed'); render(); }
      } else addFiles(files);
    });
    return panel;
  }

  function setNotice(text){ if(current){ current.view.notice = text || ''; render(); } }
  function deps(){
    var shelf = root.MiaViewShelf, artifacts = root.MiaArtifactsPage;
    return {esc: escape, when: artifacts && artifacts.when, fileKind: shelf && shelf.fileKind};
  }
  function render(){
    if(!panel || !current || panel.hidden) return;
    current.view.jobs = current.manager.jobs();
    current.view.now = Date.now();
    el('teamFilesTitle').textContent = current.options.title ? 'Files · ' + current.options.title : 'Files';
    var body = el('teamFilesBody'), scroll = body.scrollTop;
    body.innerHTML = bodyHtml(current.view, deps());
    body.scrollTop = scroll;
    scheduleScan();
  }

  function addFiles(files){
    if(!current) return;
    var rejected = current.manager.add(files);
    current.view.notice = rejected.length ? rejected.map(function(r){ return r.filename + ': ' + r.message; }).join(' ') : '';
    render();
  }

  function loadUsage(){
    var entry = current;
    return entry.client.usage().then(function(usage){ if(current === entry){ entry.view.usage = usage; render(); } }, function(){});
  }
  function load(){
    var entry = current, o = entry.options;
    entry.view.loading = true; entry.view.error = ''; entry.view.unavailable = '';
    render();
    loadUsage();
    return entry.client.list(o.spaceKind, o.spaceId, null).then(function(page){
      if(current !== entry) return;
      entry.view.files = page.files; entry.view.nextCursor = page.nextCursor;
    }, function(error){
      if(current !== entry) return;
      entry.view.files = [];
      if(error && error.code === 'team_files_not_configured') entry.view.unavailable = tf.errorMessage('team_files_not_configured');
      else entry.view.error = tf.friendly(error);
    }).then(function(){ if(current === entry){ entry.view.loading = false; render(); } });
  }
  function loadMore(){
    var entry = current;
    if(!entry || !entry.view.nextCursor || entry.view.loadingMore) return;
    entry.view.loadingMore = true; render();
    entry.client.list(entry.options.spaceKind, entry.options.spaceId, entry.view.nextCursor).then(function(page){
      var seen = {};
      entry.view.files.forEach(function(f){ seen[f.fileId] = true; });
      entry.view.files = entry.view.files.concat(page.files.filter(function(f){ return !seen[f.fileId]; }));
      entry.view.nextCursor = page.nextCursor;
    }, function(error){ entry.view.notice = tf.friendly(error); }).then(function(){ entry.view.loadingMore = false; if(current === entry) render(); });
  }

  // While a file is being scanned, ask again every few seconds; a file that
  // turns clean joins the list, and a blocked one says so.
  function scheduleScan(){
    if(scanTimer || !current || panel.hidden || !current.manager.hasScanning()) return;
    var entry = current;
    scanTimer = root.setTimeout(function(){
      scanTimer = null;
      if(current !== entry || panel.hidden) return;
      entry.manager.checkScans().then(function(changed){
        scanDelay = changed ? 3000 : Math.min(15000, scanDelay + 2000);
        if(changed && current === entry){ load(); }
        else render();
      }, function(){ render(); });
    }, scanDelay);
  }

  function saveBlob(blob, name){
    var url = root.URL.createObjectURL(blob), link = root.document.createElement('a');
    link.href = url; link.download = tf.safeFilename(name); root.document.body.appendChild(link); link.click(); link.remove();
    root.setTimeout(function(){ root.URL.revokeObjectURL(url); }, 60000);
  }
  function findFile(id){ return current.view.files.filter(function(f){ return f.fileId === id; })[0]; }

  function download(id){
    var entry = current, file = findFile(id);
    if(!file || entry.view.busy[id]) return;
    entry.view.busy[id] = 'Downloading…'; entry.view.notice = ''; render();
    tf.downloadFile({client: entry.client, file: file, onProgress: function(done, total){
      entry.view.busy[id] = 'Downloading ' + percent(done, total) + '%'; if(current === entry) render();
    }}).then(function(blob){ saveBlob(blob, file.filename); }, function(error){ entry.view.notice = tf.friendly(error); })
      .then(function(){ delete entry.view.busy[id]; if(current === entry) render(); });
  }
  function confirmThen(message, label, action){
    var ask = current.options.confirm;
    var done = ask ? ask(message, label) : Promise.resolve(root.confirm ? root.confirm(message) : true);
    done.then(function(ok){ if(ok) action(); });
  }
  function remove(id){
    var entry = current, file = findFile(id);
    if(!file || entry.view.busy[id]) return;
    confirmThen('Delete ' + file.filename + '? It is removed for everyone in this conversation and cannot be brought back.', 'Delete', function(){
      entry.view.busy[id] = 'Deleting…'; entry.view.notice = ''; render();
      entry.client.remove(id).then(function(){
        entry.view.files = entry.view.files.filter(function(f){ return f.fileId !== id; });
        entry.store.drop(entry.options.teamId, id);
        loadUsage();
      }, function(error){ entry.view.notice = tf.deleteErrorMessage(error); })
        .then(function(){ delete entry.view.busy[id]; if(current === entry) render(); });
    });
  }
  // A blocked or stuck upload: delete it from storage too, then forget it.
  function forget(jobId){
    var entry = current, job = entry.manager.jobs().filter(function(j){ return j.id === jobId; })[0];
    if(!job) return;
    confirmThen('Delete ' + job.filename + '? It is removed from your company’s storage.', 'Delete', function(){
      var fileId = job.record && job.record.fileId;
      (fileId ? entry.client.remove(fileId) : Promise.resolve()).then(function(){
        entry.manager.forget(jobId); loadUsage();
      }, function(error){
        if(error && (error.status === 404 || error.code === 'not_found')) entry.manager.forget(jobId);
        else entry.view.notice = tf.deleteErrorMessage(error);
        render();
      });
    });
  }

  function onClick(event){
    var target = event.target.closest('[data-tf-close],[data-tf-add],[data-tf-download],[data-tf-delete],[data-tf-retry],[data-tf-cancel],[data-tf-resume],[data-tf-forget],[data-tf-dismiss],[data-tf-more],[data-tf-reload]');
    if(!target || !current) return;
    var attr = function(name){ return target.getAttribute(name); };
    if(target.hasAttribute('data-tf-close')) close();
    else if(target.hasAttribute('data-tf-add')){ el('teamFilesInput').removeAttribute('data-resume'); el('teamFilesInput').click(); }
    else if(target.hasAttribute('data-tf-download')) download(attr('data-tf-download'));
    else if(target.hasAttribute('data-tf-delete')) remove(attr('data-tf-delete'));
    else if(target.hasAttribute('data-tf-retry')) current.manager.retry(attr('data-tf-retry'));
    else if(target.hasAttribute('data-tf-cancel')) current.manager.cancel(attr('data-tf-cancel'));
    else if(target.hasAttribute('data-tf-resume')){ var input = el('teamFilesInput'); input.setAttribute('data-resume', attr('data-tf-resume')); input.click(); }
    else if(target.hasAttribute('data-tf-forget')) forget(attr('data-tf-forget'));
    else if(target.hasAttribute('data-tf-dismiss')) current.manager.dismiss(attr('data-tf-dismiss'));
    else if(target.hasAttribute('data-tf-more')) loadMore();
    else if(target.hasAttribute('data-tf-reload')) load();
  }

  // options: {teamId, spaceKind: 'channel'|'group'|'dm', spaceId, title, isAdmin,
  // call(method, path, body), confirm(message, label)}. Team mode only.
  function open(options){
    if(!tf || !options || !/^[a-f0-9]{32}$/.test(options.teamId || '') || !/^[a-f0-9]{32}$/.test(options.spaceId || '')
      || ['channel', 'group', 'dm'].indexOf(options.spaceKind) < 0) return false;
    ensurePanel();
    var key = options.teamId + '|' + options.spaceKind + '|' + options.spaceId;
    var call = options.call || function(method, path, body){ return root.MiaHubChat.call(method, path, body); };
    var client = tf.createClient({teamId: options.teamId, call: call});
    var storage = (function(){ try { return root.localStorage; } catch(_){ return null; } })();
    var store = tf.createStore(storage || {getItem: function(){ return null; }, setItem: function(){}});
    // Uploads keep going while the panel is closed, so a team's manager lives on.
    var manager = managers[key];
    if(!manager){
      manager = managers[key] = tf.createManager({client: client, store: store, teamId: options.teamId,
        space: {kind: options.spaceKind, id: options.spaceId}, onChange: function(){ if(current && current.key === key) render(); }});
      manager.restore();
    }
    current = {key: key, options: options, client: client, store: store, manager: manager,
      view: {loading: true, error: '', notice: '', usage: null, files: [], nextCursor: null, loadingMore: false, busy: {}, unavailable: '',
        isAdmin: !!options.isAdmin, mine: function(id){ return store.isMine(options.teamId, id); }}};
    current.opener = root.document.activeElement;
    panel.hidden = false;
    scanDelay = 3000;
    render();
    load();
    var closeButton = panel.querySelector('[data-tf-close]');
    if(closeButton && closeButton.focus) closeButton.focus({preventScroll: true});
    return true;
  }
  function close(){
    if(!panel || panel.hidden) return;
    panel.hidden = true;
    if(scanTimer){ root.clearTimeout(scanTimer); scanTimer = null; }
    var opener = current && current.opener;
    current = null;
    if(opener && opener.focus) opener.focus({preventScroll: true});
  }

  return {bodyHtml: bodyHtml, jobStatus: jobStatus, open: open, close: close, isOpen: function(){ return !!panel && !panel.hidden; }};
});
