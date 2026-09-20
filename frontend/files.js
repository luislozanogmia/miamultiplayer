(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else factory(root);
})(typeof window !== 'undefined' ? window : this, function(root){
  'use strict';

  /* ============ pure helpers (exported for tests, no DOM/window needed) ============ */

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }

  // Extension -> MIME map. Kept in sync by hand with the server's allow
  // list in backend/artifact-policy.js#ARTIFACT_MIME_BY_EXTENSION — a file
  // outside this list simply doesn't get a "Send to room" / "Add as
  // context" pill, since the upload would 415 anyway.
  var MIME_BY_EXTENSION = {
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.zip': 'application/zip'
  };

  function extensionOf(filename){
    var name = String(filename || '');
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase() : '';
  }

  function mimeTypeForFilename(filename){
    return MIME_BY_EXTENSION[extensionOf(filename)] || null;
  }

  // A row can go into a conversation only when the server's attachment
  // store will accept its type (see mimeTypeForFilename above); an
  // attachment row already carries a known-good mimeType from the server.
  function canSendToRoom(file){
    if(!file) return false;
    if(file.root === 'attachments') return !!file.mimeType;
    return !!mimeTypeForFilename(file.name);
  }

  function formatBytes(value){
    var n = Number(value);
    if(!isFinite(n) || n < 0) return '';
    if(n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n /= 1024; i += 1; } while(n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  function fmtDate(value){
    if(!value) return '';
    var d = new Date(value);
    if(isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if(sameDay) return d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) +
      (d.getFullYear() !== now.getFullYear() ? ', ' + d.getFullYear() : '');
  }

  // Plain-language caption under a file's name: where it came from (a bot
  // or a room, when known) plus when it last changed. No dev jargon.
  function captionFor(file){
    var parts = [];
    if(file && file.caption) parts.push(file.caption);
    else if(file && file.root === 'automations') parts.push('Automation output');
    if(file && file.modifiedAt) parts.push(fmtDate(file.modifiedAt));
    return parts.join(' · ');
  }

  function filterFilesByName(files, query){
    var needle = String(query == null ? '' : query).trim().toLowerCase();
    if(!needle) return files || [];
    return (files || []).filter(function(f){
      return String((f && f.name) || '').toLowerCase().indexOf(needle) !== -1;
    });
  }

  // Combines every section's files into one reverse-chronological list for
  // the "Recent" sidebar entry, capped so the pane stays scannable.
  function recentFiles(sections, limit){
    var all = [];
    Object.keys(sections || {}).forEach(function(key){
      all = all.concat(sections[key] || []);
    });
    all.sort(function(a, b){ return new Date(b.modifiedAt) - new Date(a.modifiedAt); });
    return all.slice(0, limit || 50);
  }

  function sortFiles(files, sortKey){
    var list = (files || []).slice();
    if(sortKey === 'name'){
      list.sort(function(a, b){ return String(a.name).localeCompare(String(b.name)); });
    } else {
      list.sort(function(a, b){ return new Date(b.modifiedAt) - new Date(a.modifiedAt); });
    }
    return list;
  }

  function fileDownloadUrl(file){
    if(!file) return '';
    if(file.root === 'attachments'){
      return '/api/conversations/' + encodeURIComponent(file.conversationId) +
        '/attachments/' + encodeURIComponent(file.attachmentId);
    }
    return '/api/files/download?root=' + encodeURIComponent(file.root) +
      '&path=' + encodeURIComponent(file.path);
  }

  /* ============ DOM wiring (skipped entirely under Node tests) ============ */

  function initBrowser(win){
    var doc = win.document;
    function $(sel, ctx){ return (ctx || doc).querySelector(sel); }
    function $all(sel, ctx){ return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

    function workspaceKey(){
      var stored = '';
      try { stored = win.localStorage.getItem('miaosActiveWorkspace') || ''; } catch(_err) {}
      return stored === 'solo' ? 'solo' : 'multiplayer_test';
    }

    function call(path, opts){
      opts = opts || {};
      opts.credentials = 'include';
      opts.headers = Object.assign({'Accept': 'application/json', 'X-MiaOS-Workspace': workspaceKey()}, opts.headers || {});
      if(opts.body && typeof opts.body !== 'string'){
        opts.headers = Object.assign({'Content-Type': 'application/json'}, opts.headers || {});
        opts.body = JSON.stringify(opts.body);
      }
      return win.fetch(path, opts).then(function(r){
        return r.text().then(function(raw){
          var data = {};
          if(raw && raw.trim()){ try { data = JSON.parse(raw); } catch(_e) { data = {}; } }
          return {status: r.status, data: data};
        });
      });
    }

    var SECTIONS = [
      {key: 'workspace', label: 'Workspace', endpoint: '/api/files/workspace'},
      {key: 'attachments', label: 'Attachments', endpoint: '/api/files/attachments'},
      {key: 'automations', label: 'Bot outputs', endpoint: '/api/files/automations'}
    ];

    var state = {
      sections: {workspace: [], attachments: [], automations: []},
      activeSection: 'recent',
      sortKey: 'modified',
      selectedPath: null,
      searchQuery: '',
      searchResults: null,
      loading: true
    };

    var sidebar = $('#filesSidebar');
    var listEl = $('#filesList');
    var countEl = $('#filesCount');
    var toolbar = $('#filesToolbar');
    var searchInput = $('#filesSearch');
    var pickerEl = $('#filesRoomPicker');
    var pickerListEl = $('#filesRoomPickerList');
    var pickerTitleEl = $('#filesRoomPickerTitle');
    var toastEl = $('#filesToast');
    var searchTimer = null;
    var pendingSendFile = null;
    var pendingSendKind = null;

    function toast(message){
      if(!toastEl) return;
      toastEl.textContent = message;
      toastEl.hidden = false;
      win.clearTimeout(toastEl._timer);
      toastEl._timer = win.setTimeout(function(){ toastEl.hidden = true; }, 3200);
    }

    function currentFiles(){
      if(state.searchResults) return state.searchResults;
      if(state.activeSection === 'recent') return recentFiles(state.sections, 50);
      return state.sections[state.activeSection] || [];
    }

    function selectedFile(){
      var files = currentFiles();
      return files.filter(function(f){ return f.path === state.selectedPath && f.root === state.selectedRoot; })[0] || null;
    }

    function renderSidebar(){
      if(!sidebar) return;
      var items = [{key: 'recent', label: 'Recent'}].concat(SECTIONS.map(function(s){ return {key: s.key, label: s.label}; }));
      sidebar.innerHTML = items.map(function(item){
        var count = item.key === 'recent' ? recentFiles(state.sections, 500).length : (state.sections[item.key] || []).length;
        return '<button type="button" class="files-nav-item' + (state.activeSection === item.key ? ' active' : '') + '" data-section="' +
          esc(item.key) + '">' + esc(item.label) + '<span class="files-nav-count">' + count + '</span></button>';
      }).join('');
    }

    function renderToolbar(){
      if(!toolbar) return;
      var file = selectedFile();
      $all('button', toolbar).forEach(function(btn){ btn.disabled = !file; });
    }

    function rowHtml(file){
      var caption = captionFor(file);
      var selected = file.path === state.selectedPath && file.root === state.selectedRoot;
      var pills = '';
      if(canSendToRoom(file)){
        pills =
          '<button type="button" class="files-pill" data-action="send-room" data-path="' + esc(file.path) + '" data-root="' + esc(file.root) + '">Send to room</button>' +
          '<button type="button" class="files-pill" data-action="add-context" data-path="' + esc(file.path) + '" data-root="' + esc(file.root) + '">Add as context</button>';
      }
      var matchLine = file.snippet
        ? '<div class="files-row-snippet">Line ' + Number(file.line) + ': ' + esc(file.snippet) + '</div>'
        : '';
      return '<li class="files-row' + (selected ? ' selected' : '') + '" data-path="' + esc(file.path) + '" data-root="' + esc(file.root) + '" role="option" aria-selected="' + selected + '">' +
        '<div class="files-row-icon" aria-hidden="true"></div>' +
        '<div class="files-row-main">' +
          '<div class="files-row-name">' + esc(file.name) + '</div>' +
          '<div class="files-row-caption">' + esc(caption) + (file.sizeBytes != null ? ' · ' + esc(formatBytes(file.sizeBytes)) : '') + '</div>' +
          matchLine +
        '</div>' +
        '<div class="files-row-pills">' + pills + '</div>' +
      '</li>';
    }

    function renderList(){
      if(!listEl) return;
      var files = sortFiles(currentFiles(), state.sortKey);
      if(countEl){
        var label = state.searchResults ? (files.length + (files.length === 1 ? ' match' : ' matches')) : (files.length + (files.length === 1 ? ' item' : ' items'));
        countEl.textContent = state.loading ? 'Loading…' : label;
      }
      if(!files.length){
        listEl.innerHTML = '<li class="files-empty">' + (state.loading ? 'Loading…' :
          state.searchResults ? 'No files contain that text.' : 'Nothing here yet.') + '</li>';
      } else {
        listEl.innerHTML = files.map(rowHtml).join('');
      }
      renderToolbar();
    }

    function loadSection(section){
      return call(section.endpoint).then(function(res){
        state.sections[section.key] = (res.data && res.data.files) || [];
      }).catch(function(){ state.sections[section.key] = []; });
    }

    function loadAll(){
      state.loading = true;
      renderList();
      return Promise.all(SECTIONS.map(loadSection)).then(function(){
        state.loading = false;
        renderSidebar();
        renderList();
      });
    }

    function runSearch(query){
      state.searchQuery = query;
      if(!query){
        state.searchResults = null;
        renderList();
        return;
      }
      var roots = state.activeSection === 'workspace' || state.activeSection === 'automations'
        ? [state.activeSection]
        : ['workspace', 'automations'];
      Promise.all(roots.map(function(root){
        return call('/api/files/search?root=' + encodeURIComponent(root) + '&q=' + encodeURIComponent(query))
          .then(function(res){ return (res.data && res.data.results) || []; })
          .catch(function(){ return []; });
      })).then(function(lists){
        var merged = [].concat.apply([], lists);
        // A filename match belongs alongside a content match when searching
        // the attachments-free roots, and always for the Attachments tab.
        if(state.activeSection === 'attachments'){
          merged = filterFilesByName(state.sections.attachments, query);
        } else if(state.activeSection === 'recent'){
          merged = merged.concat(filterFilesByName(recentFiles(state.sections, 500), query));
        }
        state.searchResults = merged;
        renderList();
      });
    }

    function fetchFileAsBase64(file){
      return win.fetch(fileDownloadUrl(file), {credentials: 'include'}).then(function(r){
        if(!r.ok) throw new Error('Could not read this file.');
        return r.blob();
      }).then(function(blob){
        return new Promise(function(resolve, reject){
          var reader = new win.FileReader();
          reader.onerror = function(){ reject(new Error('Could not read this file.')); };
          reader.onload = function(){
            var value = String(reader.result || '');
            var comma = value.indexOf(',');
            resolve(comma === -1 ? value : value.slice(comma + 1));
          };
          reader.readAsDataURL(blob);
        });
      });
    }

    function openRoomPicker(file, kind){
      pendingSendFile = file;
      pendingSendKind = kind;
      if(pickerTitleEl){
        pickerTitleEl.textContent = kind === 'add-context'
          ? 'Add "' + file.name + '" as context to…'
          : 'Send "' + file.name + '" to…';
      }
      if(pickerListEl) pickerListEl.innerHTML = '<li class="files-empty">Loading rooms…</li>';
      if(pickerEl) pickerEl.hidden = false;
      call('/api/conversations').then(function(res){
        var conversations = (res.data && res.data.conversations) || [];
        if(!pickerListEl) return;
        if(!conversations.length){
          pickerListEl.innerHTML = '<li class="files-empty">No rooms yet.</li>';
          return;
        }
        pickerListEl.innerHTML = conversations.map(function(c){
          return '<li><button type="button" class="files-room-option" data-id="' + esc(c.id) + '">' +
            esc(c.name || 'Untitled room') + '</button></li>';
        }).join('');
      }).catch(function(){
        if(pickerListEl) pickerListEl.innerHTML = '<li class="files-empty">Couldn’t load rooms.</li>';
      });
    }

    function closeRoomPicker(){
      if(pickerEl) pickerEl.hidden = true;
      pendingSendFile = null;
      pendingSendKind = null;
    }

    function sendToRoom(conversationId){
      var file = pendingSendFile;
      var kind = pendingSendKind;
      if(!file) return;
      closeRoomPicker();
      var mimeType = file.root === 'attachments' ? file.mimeType : mimeTypeForFilename(file.name);
      fetchFileAsBase64(file).then(function(contentBase64){
        return call('/api/conversations/' + encodeURIComponent(conversationId) + '/attachments?workspace=' + encodeURIComponent(workspaceKey()), {
          method: 'POST',
          body: {filename: file.name, mimeType: mimeType, contentBase64: contentBase64}
        });
      }).then(function(res){
        if(res.status !== 201){
          toast((res.data && res.data.message) || 'Could not send that file.');
          return;
        }
        toast(kind === 'add-context' ? 'Added as context.' : 'Sent to room.');
      }).catch(function(){
        toast('Could not send that file.');
      });
    }

    function wire(){
      if(sidebar){
        sidebar.addEventListener('click', function(ev){
          var btn = ev.target.closest && ev.target.closest('[data-section]');
          if(!btn) return;
          state.activeSection = btn.getAttribute('data-section');
          state.selectedPath = null;
          state.searchResults = null;
          if(searchInput) searchInput.value = '';
          renderSidebar();
          renderList();
        });
      }
      if(listEl){
        listEl.addEventListener('click', function(ev){
          var pillBtn = ev.target.closest && ev.target.closest('.files-pill');
          if(pillBtn){
            var row = pillBtn.closest('.files-row');
            var path = row.getAttribute('data-path');
            var fileRoot = row.getAttribute('data-root');
            var file = currentFiles().filter(function(f){ return f.path === path && f.root === fileRoot; })[0];
            if(file) openRoomPicker(file, pillBtn.getAttribute('data-action'));
            return;
          }
          var row = ev.target.closest && ev.target.closest('.files-row');
          if(!row) return;
          state.selectedPath = row.getAttribute('data-path');
          state.selectedRoot = row.getAttribute('data-root');
          renderList();
        });
      }
      if(toolbar){
        toolbar.addEventListener('click', function(ev){
          var btn = ev.target.closest && ev.target.closest('button[data-toolbar]');
          if(!btn) return;
          var file = selectedFile();
          if(!file) return;
          var action = btn.getAttribute('data-toolbar');
          var url = fileDownloadUrl(file);
          if(action === 'open'){
            win.open(url, '_blank', 'noopener');
          } else if(action === 'download'){
            var a = doc.createElement('a');
            a.href = url; a.download = file.name;
            doc.body.appendChild(a); a.click(); a.remove();
          } else if(action === 'copy'){
            var text = file.path || file.name;
            if(win.navigator.clipboard && win.navigator.clipboard.writeText){
              win.navigator.clipboard.writeText(text).then(function(){ toast('Copied.'); }).catch(function(){ toast('Could not copy.'); });
            }
          }
        });
      }
      if(searchInput){
        searchInput.addEventListener('input', function(){
          win.clearTimeout(searchTimer);
          var value = searchInput.value;
          searchTimer = win.setTimeout(function(){ runSearch(value); }, 250);
        });
      }
      if(pickerListEl){
        pickerListEl.addEventListener('click', function(ev){
          var btn = ev.target.closest && ev.target.closest('.files-room-option');
          if(btn) sendToRoom(btn.getAttribute('data-id'));
        });
      }
      var pickerClose = $('#filesRoomPickerClose');
      if(pickerClose) pickerClose.addEventListener('click', closeRoomPicker);
      if(pickerEl){
        pickerEl.addEventListener('click', function(ev){ if(ev.target === pickerEl) closeRoomPicker(); });
      }
    }

    function boot(){
      call('/api/me').then(function(res){
        if(res.status === 401){
          win.location.href = '/';
          return;
        }
        wire();
        renderSidebar();
        loadAll();
      }).catch(function(){
        win.location.href = '/';
      });
    }

    if(doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  var exportsObj = {
    esc: esc,
    mimeTypeForFilename: mimeTypeForFilename,
    canSendToRoom: canSendToRoom,
    formatBytes: formatBytes,
    fmtDate: fmtDate,
    captionFor: captionFor,
    filterFilesByName: filterFilesByName,
    recentFiles: recentFiles,
    sortFiles: sortFiles,
    fileDownloadUrl: fileDownloadUrl
  };

  if(root && root.document) initBrowser(root);

  return exportsObj;
});
