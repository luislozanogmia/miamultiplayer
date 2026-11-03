(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaViewShelf = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // Rows in the Downloads look: the chat's files (details pane), the latest
  // automation runs (Automations page). Pure data shaping and markup; the app
  // fetches and wires clicks.
  var RECENT_MAX = 8;

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
        // The bot record keeps each automation's last delivered run; a failed
        // run is delivered too, under a cron-failure session.
        var delivery = (bot.hermesCronDeliveries || {})[automation.id] || {};
        var ts = Date.parse(delivery.deliveredAt) || 0;
        if(!ts) return;
        var failed = /^cron-failure-/.test(String(delivery.sessionId || ''));
        past.push({kind: 'run', id: String(bot.id) + ':' + automation.id, name: automation.name || 'Automation', from: bot.name || '',
          status: failed ? 'Failed' : 'Done',
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

  return {RECENT_MAX: RECENT_MAX, fileKind: fileKind, chatFiles: chatFiles, runHistory: runHistory,
    rememberRecent: rememberRecent, matches: matches, rowsHtml: rowsHtml};
});
