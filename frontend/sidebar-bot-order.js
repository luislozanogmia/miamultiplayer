(function(root){
  'use strict';
  // The My Bots order, one rule for Solo and for a company:
  // unread first, then working, then the rest by their latest message,
  // and bots that never had a message last. Within a group the latest
  // message wins, then the newest bot, then the order the list came in.

  var UNREAD = 0, WORKING = 1, IDLE = 2, NEW = 3;

  // A time can come as a number or as a date string; anything else is none.
  function toTs(value){
    if(typeof value === 'number') return isFinite(value) && value > 0 ? value : 0;
    if(typeof value === 'string' && value){
      var parsed = Date.parse(value);
      return isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return 0;
  }

  // facts: {unread, working, lastTs, createdAt}. Unread wins over working,
  // so a bot that answered while you were away is not lost among busy ones.
  function botGroup(facts){
    facts = facts || {};
    if(facts.unread) return UNREAD;
    if(facts.working) return WORKING;
    if(toTs(facts.lastTs)) return IDLE;
    return NEW;
  }

  // Returns a new array; the list passed in is left as it was.
  function orderBots(items, factsFor){
    return (items || []).map(function(item, index){
      var facts = (factsFor ? factsFor(item) : item) || {};
      return {item: item, index: index, group: botGroup(facts), lastTs: toTs(facts.lastTs), createdTs: toTs(facts.createdAt)};
    }).sort(function(a, b){
      return a.group - b.group || b.lastTs - a.lastTs || b.createdTs - a.createdTs || a.index - b.index;
    }).map(function(entry){ return entry.item; });
  }

  root.MiaSidebarBotOrder = {
    orderBots: orderBots,
    botGroup: botGroup,
    groups: {unread: UNREAD, working: WORKING, idle: IDLE, fresh: NEW}
  };
})(typeof window !== 'undefined' ? window : globalThis);
