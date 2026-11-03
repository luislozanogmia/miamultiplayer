(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaNeedsYou = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  var AUTOMATION_TAG = 'needs-automation:';
  // What needs this person, across every view: one list for the view badges
  // and the Notifications panel. Pure data shaping; the app renders it.
  function items(input){
    var out = [];
    (input.rooms || []).forEach(function(room){
      out.push({view: 'chat', id: room.id, kind: room.kind, title: room.label, detail: room.pending ? 'Waiting for your OK' : 'New message'});
    });
    (input.automations || []).forEach(function(row){
      if(row.status !== 'needs') return;
      out.push({view: 'automations', botId: row.botId, automationId: row.automationId, title: row.botName + ' · ' + row.name, detail: row.detail || 'Needs you'});
    });
    if(input.appReviews) out.push({view: 'apps', title: input.appReviews === 1 ? '1 app to review' : input.appReviews + ' apps to review', detail: 'Waiting for your review'});
    return out;
  }
  function count(list, view){
    return list.filter(function(item){ return item.view === view; }).length;
  }
  // The automations that newly need this person, for one OS notification each.
  // A row that recovers is forgotten, so needing help again notifies again.
  function automationAlerts(rows, seen){
    var next = (seen || []).slice(), alerts = [];
    (rows || []).forEach(function(row){
      var tag = automationTag(row), known = next.indexOf(tag);
      if(row.status !== 'needs'){ if(known >= 0) next.splice(known, 1); return; }
      if(known < 0){ next.push(tag); alerts.push(row); }
    });
    return {alerts: alerts, seen: next};
  }
  function automationTag(row){
    return AUTOMATION_TAG + row.botId + ':' + row.automationId;
  }
  function automationFromTag(tag){
    var text = String(tag || '');
    if(text.indexOf(AUTOMATION_TAG) !== 0) return null;
    var parts = text.slice(AUTOMATION_TAG.length).split(':');
    return {view: 'automations', botId: parts[0], automationId: parts.slice(1).join(':')};
  }
  return {items: items, count: count, automationAlerts: automationAlerts, automationTag: automationTag, automationFromTag: automationFromTag};
});
