(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaViewShelf = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The bar's one per-view button, where Downloads sits in the browser: the
  // files in the open chat, the latest automation runs, or the artifacts
  // opened last. Pure data shaping and markup; the app fetches and wires clicks.
  var ICONS = {
    chat: '<path d="M15 3v4a1 1 0 0 0 1 1h4"></path><path d="M18 17h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l5 5v7a2 2 0 0 1-2 2z"></path><path d="M16 17v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2"></path>',
    automations: '<path d="M3.5 5.5 5 7l2.5-2.5"></path><path d="M3.5 11.5 5 13l2.5-2.5"></path><path d="M3.5 17.5 5 19l2.5-2.5"></path><path d="M11 6h9"></path><path d="M11 12h9"></path><path d="M11 18h9"></path>',
    artifacts: '<path d="M12 8v4l2 2"></path><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"></path>',
  };
  var VIEWS = {
    chat: {title: 'Files', label: 'Files in this chat', search: 'Search files', empty: 'Files shared in this chat appear here.'},
    automations: {title: 'Run history', label: 'Run history', search: 'Search runs', empty: 'Automation runs appear here once they have run.'},
    artifacts: {title: 'Recently opened', label: 'Recently opened artifacts', search: 'Search recent', empty: 'Artifacts you open appear here.'},
  };
  var RECENT_MAX = 8;

  function config(view){
    var base = VIEWS[view];
    return base ? Object.assign({view: view, icon: ICONS[view]}, base) : null;
  }

  // The same colored tiles as Downloads.
  function fileKind(name, mimeType){
    var ext = (/\.([a-z0-9]{1,5})$/i.exec(String(name || '')) || [])[1] || '';
    ext = ext.toLowerCase();
    var mime = String(mimeType || '').toLowerCase();
    var kind = mime.indexOf('image/') === 0 ? 'image'
      : (mime.indexOf('video/') === 0 || mime.indexOf('audio/') === 0) ? 'media'
      : (ext === 'pdf' || mime === 'application/pdf') ? 'pdf'
      : /^(xlsx?|csv|tsv|numbers)$/.test(ext) ? 'sheet'
      : /^(docx?|rtf|txt|md|pages)$/.test(ext) ? 'doc'
      : /^(pptx?|key)$/.test(ext) ? 'slides' : '';
    return {kind: kind, label: (ext || (mime.split('/')[1] || 'file')).slice(0, 4)};
  }

  // Newest first; one row per attachment of the chat's loaded messages.
  function chatFiles(messages, attachmentsOf, fromOf){
    var rows = [];
    (messages || []).forEach(function(message){
      if(!message || message.deleted) return;
      (attachmentsOf(message) || []).forEach(function(file){
        if(!file || !file.filename) return;
        var tile = fileKind(file.filename, file.mimeType);
        rows.push({kind: 'file', id: String(file.id || file.filename), name: file.filename, from: fromOf ? fromOf(message) || '' : '',
          ts: Number(message.ts) || 0, tile: tile.kind, tileLabel: tile.label, url: file.url || '', previewUrl: file.previewUrl || file.url || '', canPreview: !!file.canPreview});
      });
    });
    return rows.sort(function(a, b){ return b.ts - a.ts; });
  }

  // Running runs first, then each automation's latest run, newest first.
  function runHistory(running, bots, automationsOf, limit){
    var rows = (running || []).map(function(run){
      return {kind: 'run', id: 'running-' + run.id, name: run.name || 'Automation', from: run.botName || '', status: 'Running',
        ts: Date.parse(run.startedAt) || 0, botId: run.botId, automationId: run.automationId, tile: 'media', tileLabel: 'run'};
    });
    var past = [];
    (bots || []).forEach(function(bot){
      (automationsOf(bot) || []).forEach(function(automation){
        var ts = Date.parse(automation.lastRunAt) || 0;
        if(!ts) return;
        var status = String(automation.lastRunStatus || '').toLowerCase();
        var failed = status === 'failed' || status === 'error';
        past.push({kind: 'run', id: String(bot.id) + ':' + automation.id, name: automation.name || 'Automation', from: bot.name || '',
          status: failed ? 'Failed' : status === 'ok' || status === 'success' || status === 'succeeded' ? 'Done' : (automation.lastRunStatus ? String(automation.lastRunStatus) : ''),
          ts: ts, botId: bot.id, automationId: automation.id, tile: failed ? 'pdf' : 'sheet', tileLabel: 'run'});
      });
    });
    past.sort(function(a, b){ return b.ts - a.ts; });
    return rows.concat(past).slice(0, limit || 12);
  }

  function rememberRecent(ids, id, max){
    if(!id) return (ids || []).slice();
    return [String(id)].concat((ids || []).filter(function(item){ return item !== String(id); })).slice(0, max || RECENT_MAX);
  }

  // Ids of artifacts that are gone are dropped quietly.
  function recentArtifacts(ids, items){
    var byId = {};
    (items || []).forEach(function(item){ if(item && item.id) byId[item.id] = item; });
    return (ids || []).map(function(id){ return byId[id]; }).filter(Boolean).map(function(item){
      var tile = item.kind === 'app' ? {kind: 'doc', label: 'app'} : fileKind(item.name, item.type && item.type.indexOf('/') > 0 ? item.type : '');
      return {kind: 'artifact', id: item.id, name: item.name || 'Artifact', from: item.kind === 'app' ? String(item.url || '').replace(/^https?:\/\//, '') : (item.from || 'You'),
        ts: Number(item.modifiedAt) || Date.parse(item.modifiedAt) || 0, tile: tile.kind, tileLabel: item.kind === 'app' ? 'app' : (item.type ? String(item.type).slice(0, 4) : tile.label)};
    });
  }

  function matches(row, query){
    var q = String(query || '').trim().toLowerCase();
    if(!q) return true;
    return [row.name, row.from, row.status].some(function(value){ return String(value || '').toLowerCase().indexOf(q) !== -1; });
  }

  function rowsHtml(rows, esc, when){
    return rows.map(function(row, index){
      var meta = [row.status, row.from, row.ts && when ? when(row.ts) : ''].filter(Boolean).join(' · ');
      return '<div class="local-browser-download" data-state="completed">' +
        '<span class="local-browser-download-icon"' + (row.tile ? ' data-kind="' + esc(row.tile) + '"' : '') + ' aria-hidden="true">' + esc(row.tileLabel || '') + '</span>' +
        '<span class="local-browser-download-text"><button type="button" class="local-browser-download-name" data-shelf-row="' + index + '">' + esc(row.name) + '</button>' +
        (meta ? '<span class="local-browser-download-meta">' + esc(meta) + '</span>' : '') + '</span></div>';
    }).join('');
  }

  return {ICONS: ICONS, RECENT_MAX: RECENT_MAX, config: config, fileKind: fileKind, chatFiles: chatFiles, runHistory: runHistory,
    rememberRecent: rememberRecent, recentArtifacts: recentArtifacts, matches: matches, rowsHtml: rowsHtml};
});
