(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaChatScroll = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  var BOTTOM_THRESHOLD = 32;

  function nearBottom(view){
    if(!view) return true;
    return Number(view.scrollHeight || 0) - Number(view.clientHeight || 0) - Number(view.scrollTop || 0) <= BOTTOM_THRESHOLD;
  }

  function visibleAnchor(view){
    if(!view || typeof view.querySelectorAll !== 'function' || typeof view.getBoundingClientRect !== 'function') return null;
    var top = view.getBoundingClientRect().top;
    var rows = Array.prototype.slice.call(view.querySelectorAll('[data-event-id]'));
    for(var i = 0; i < rows.length; i++){
      if(typeof rows[i].getBoundingClientRect !== 'function') continue;
      var rect = rows[i].getBoundingClientRect();
      if(rect.bottom > top) return {id: rows[i].getAttribute('data-event-id'), offset: rect.top - top};
    }
    return null;
  }

  function nextGeneration(view){
    view.__miaChatScrollGeneration = Number(view.__miaChatScrollGeneration || 0) + 1;
    return view.__miaChatScrollGeneration;
  }

  function capture(view, state, options){
    if(!view || !state) return state;
    if(options && options.invalidatePending) nextGeneration(view);
    state.followLatest = nearBottom(view);
    state.chatScrollTop = Number(view.scrollTop || 0);
    state.chatScrollAnchor = state.followLatest ? null : visibleAnchor(view);
    return state;
  }

  function findAnchor(view, id){
    if(!view || !id || typeof view.querySelectorAll !== 'function') return null;
    var rows = view.querySelectorAll('[data-event-id]');
    for(var i = 0; i < rows.length; i++){
      if(rows[i].getAttribute('data-event-id') === id) return rows[i];
    }
    return null;
  }

  function restore(view, state, options){
    if(!view || !state) return;
    options = options || {};
    if(options.prependAnchor){
      view.scrollTop = Math.max(0, Number(view.scrollHeight || 0) - Number(options.prependAnchor.height || 0) + Number(options.prependAnchor.top || 0));
      state.followLatest = false;
      state.chatScrollTop = view.scrollTop;
      state.chatScrollAnchor = visibleAnchor(view);
      return;
    }
    if(state.followLatest !== false){
      view.scrollTop = Number(view.scrollHeight || 0);
      state.followLatest = true;
      state.chatScrollTop = view.scrollTop;
      state.chatScrollAnchor = null;
      return;
    }
    var anchor = state.chatScrollAnchor;
    var row = anchor && findAnchor(view, anchor.id);
    if(row && typeof row.getBoundingClientRect === 'function' && typeof view.getBoundingClientRect === 'function'){
      var currentOffset = row.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop += currentOffset - Number(anchor.offset || 0);
    } else {
      var maxTop = Math.max(0, Number(view.scrollHeight || 0) - Number(view.clientHeight || 0));
      view.scrollTop = Math.min(Number(state.chatScrollTop || 0), maxTop);
    }
    state.chatScrollTop = view.scrollTop;
  }

  function replace(view, html, state, options){
    if(!view || !state) return;
    state.chatScrollRevision = Number(state.chatScrollRevision || 0) + 1;
    var revision = state.chatScrollRevision;
    var generation = nextGeneration(view);
    view.innerHTML = html;
    restore(view, state, options);
    if(root && typeof root.requestAnimationFrame === 'function'){
      root.requestAnimationFrame(function(){
        if(state.chatScrollRevision === revision && view.__miaChatScrollGeneration === generation) restore(view, state, options);
      });
    }
  }

  function jumpToLatest(view, state){
    if(!view || !state) return;
    state.followLatest = true;
    state.chatScrollAnchor = null;
    view.scrollTop = Number(view.scrollHeight || 0);
    state.chatScrollTop = view.scrollTop;
  }

  function syncButton(button, view, state){
    if(!button) return;
    var hidden = !view || !state || nearBottom(view);
    button.hidden = hidden;
    button.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  return {BOTTOM_THRESHOLD:BOTTOM_THRESHOLD, nearBottom:nearBottom, visibleAnchor:visibleAnchor,
    capture:capture, restore:restore, replace:replace, jumpToLatest:jumpToLatest, syncButton:syncButton};
});
