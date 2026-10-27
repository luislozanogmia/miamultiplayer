(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaArtifactsPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The Artifacts page: live apps first, then pages and documents, newest
  // first. Pure data shaping and markup; the app fetches and wires clicks.
  var FILTERS = [
    {id: 'all', label: 'All'},
    {id: 'page', label: 'Pages'},
    {id: 'document', label: 'Docs'},
    {id: 'app', label: 'Apps'},
  ];

  function matches(item, filter, query){
    if(filter && filter !== 'all' && item.kind !== filter) return false;
    var q = String(query || '').trim().toLowerCase();
    if(!q) return true;
    return [item.name, item.from, item.folder, item.url].some(function(value){
      return String(value || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function counts(items){
    var out = {all: items.length, page: 0, document: 0, app: 0};
    items.forEach(function(item){ if(out[item.kind] !== undefined) out[item.kind]++; });
    return out;
  }

  function sections(items, filter, query){
    var shown = items.filter(function(item){ return matches(item, filter, query); });
    return [
      {id: 'apps', title: 'Live apps', items: shown.filter(function(item){ return item.kind === 'app'; })},
      {id: 'files', title: 'Pages and documents', items: shown.filter(function(item){ return item.kind !== 'app'; })},
    ].filter(function(section){ return section.items.length; });
  }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function when(ms, now){
    var age = Math.max(0, (now || Date.now()) - ms);
    if(age < 60000) return 'just now';
    if(age < 3600000) return Math.floor(age / 60000) + 'm ago';
    if(age < 86400000) return Math.floor(age / 3600000) + 'h ago';
    if(age < 172800000) return 'yesterday';
    var date = new Date(ms);
    return MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  function appAddress(url){
    try { var parsed = new URL(url); return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname); }
    catch(_){ return String(url || ''); }
  }

  function rowHtml(item, esc, now){
    var thumb = item.kind === 'app' ? 'App' : (item.type || '');
    var meta;
    if(item.kind === 'app'){
      var dot = item.running === true ? '<span class="artifacts-dot on">● running</span>'
        : item.running === false ? '<span class="artifacts-dot">○ off</span>' : '';
      meta = esc(appAddress(item.url)) + (dot ? ' · ' + dot : '');
    } else {
      meta = esc(item.from ? item.from : 'You') + ' · ' + esc(when(item.modifiedAt, now));
    }
    var removeTitle = item.kind === 'app' ? 'Remove' : 'Move to Trash';
    var remove = '<button type="button" class="artifacts-row-remove" data-artifact-remove="' + esc(item.id) + '" title="' + removeTitle + '" aria-label="' + removeTitle + ': ' + esc(item.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>';
    var share = '<button type="button" class="artifacts-row-share" data-artifact-share="' + esc(item.id) + '" title="Share in a chat" aria-label="Share ' + esc(item.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"></path><path d="M9 15c0-4 3-7 7-7h5"></path><path d="m17 4 4 4-4 4"></path></svg></button>';
    return '<div class="artifacts-row" role="listitem">'
      + '<button type="button" class="artifacts-row-open" data-artifact-open="' + esc(item.id) + '" title="Open in Mia\'s browser">'
      + '<span class="artifacts-thumb">' + esc(thumb) + '</span>'
      + '<span class="artifacts-row-text"><span class="artifacts-row-name">' + esc(item.name) + '</span>'
      + '<span class="artifacts-row-meta">' + meta + '</span></span></button>'
      + share + remove + '</div>';
  }

  function chipsHtml(items, filter, esc){
    var n = counts(items);
    return FILTERS.map(function(f){
      var on = f.id === filter;
      return '<button type="button" class="artifacts-chip' + (on ? ' on' : '') + '" data-artifacts-filter="' + f.id + '" aria-pressed="' + on + '">'
        + esc(f.label) + (f.id === 'all' ? ' ' + n.all : '') + '</button>';
    }).join('');
  }

  function bodyHtml(state, esc, now){
    if(state.loading && !state.items.length) return '<div class="artifacts-empty">Loading…</div>';
    if(state.error) return '<div class="artifacts-empty">' + esc(state.error) + '</div>';
    if(!state.items.length){
      return '<div class="artifacts-empty"><div class="artifacts-empty-title">Your pages and apps show up here</div>'
        + '<div>Anything you or a bot makes in your Mia folder: web pages, PDFs and images.</div>'
        + '<button type="button" class="artifacts-empty-add" data-artifacts-add>Add a live app</button></div>';
    }
    var list = sections(state.items, state.filter, state.query);
    if(!list.length) return '<div class="artifacts-empty">Nothing matches.</div>';
    return list.map(function(section){
      return '<div class="artifacts-section-title">' + esc(section.title) + '</div>'
        + '<div class="artifacts-list" role="list">' + section.items.map(function(item){ return rowHtml(item, esc, now); }).join('') + '</div>';
    }).join('');
  }

  return {FILTERS: FILTERS, bodyHtml: bodyHtml, chipsHtml: chipsHtml, counts: counts, matches: matches, sections: sections, when: when};
});
