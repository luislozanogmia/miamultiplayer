(function(root, factory){
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./safe-page-url.js') : root.MiaSafePageUrl);
  if(node) module.exports = api;
  else root.MiaSharedSpace = api;
})(typeof window !== 'undefined' ? window : globalThis, function(safePageUrl){
  'use strict';
  // A shared space is a tab group several teammates have open at once. Each
  // person opens its pages with their own sign-ins; the space only shares
  // which tabs it holds, who is on which tab, and where bots are working.
  // Updates travel as hidden messages in one team channel, behind MARKER.
  var MARKER = '⁣mia-space/1 ';
  var PRESENCE_TTL_MS = 75000;
  var MAX_TABS = 24;

  function encode(payload){ return MARKER + JSON.stringify(payload); }
  function isSpaceMessage(body){ return typeof body === 'string' && /^(?:\u2063)?mia-space\/1 \{/.test(body); }
  function decode(body){
    if(!isSpaceMessage(body)) return null;
    try {
      var value = JSON.parse(body.slice(body.indexOf('mia-space/1 ') + 'mia-space/1 '.length));
      return value && typeof value === 'object' && typeof value.t === 'string' && typeof value.space === 'string' ? value : null;
    } catch(_error) { return null; }
  }

  // An admin ending a session reaches everyone as a Hub system message. Only the
  // channel row's own author counts; the JSON inside the body can claim anything.
  var ADMIN_AUTHOR = 'system:admin';
  function isAdminEnd(row){
    var message = row && decode(row.body);
    return !!message && message.t === 'end' && row.author_type === 'system' && row.author_id === ADMIN_AUTHOR;
  }

  // Only web pages are shared, with secrets taken out of the address: a teammate
  // can never open a local file or a script URL on someone else's computer, and
  // tokens in a URL stay on the computer that has them.
  function shareableUrl(url){ return safePageUrl.safeBrowserPageUrl(url); }
  function cleanTabs(list){
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(function(tab){
      if(!tab || typeof tab.k !== 'string' || !/^[a-z0-9]{6,32}$/.test(tab.k) || seen[tab.k]) return false;
      seen[tab.k] = true; return true;
    }).slice(0, MAX_TABS).map(function(tab){
      return {k: tab.k, url: shareableUrl(tab.url), title: String(tab.title || '').slice(0, 200)};
    });
  }

  // The tab list is last-writer-wins: a higher revision replaces it, and the
  // author id breaks a tie so every computer settles on the same list.
  function newer(current, incoming){
    if(!current) return true;
    if(incoming.rev !== current.rev) return incoming.rev > current.rev;
    return String(incoming.by || '') > String(current.by || '');
  }
  function applySpace(current, message){
    if(!message || message.t !== 'space' || !Number.isSafeInteger(message.rev)) return current;
    var incoming = {id: message.space, name: String(message.name || 'Shared tabs').slice(0, 80), rev: message.rev,
      by: message.from && message.from.id || '', tabs: cleanTabs(message.tabs)};
    var startedAt = Number(message.startedAt) || current && current.startedAt;
    if(startedAt) incoming.startedAt = startedAt;
    // Whoever started the call stays its host, whoever last changed the tabs.
    var hostId = typeof message.host === 'string' && message.host || current && current.host;
    if(hostId) incoming.host = hostId;
    return newer(current, incoming) ? incoming : current;
  }

  function applyPresence(presence, message, now){
    var next = Object.assign({}, presence);
    var from = message && message.from;
    if(!from || typeof from.id !== 'string') return next;
    if(message.t === 'leave') { delete next[from.id]; return next; }
    if(message.t !== 'here') return next;
    next[from.id] = {id: from.id, name: String(from.name || 'Colleague').slice(0, 80), tab: typeof message.tab === 'string' ? message.tab : null,
      url: shareableUrl(message.url), follow: typeof message.follow === 'string' ? message.follow : null, away: message.away === true,
      bots: (Array.isArray(message.bots) ? message.bots : []).slice(0, 8).filter(function(bot){ return bot && typeof bot.tab === 'string'; })
        .map(function(bot){ return {tab: bot.tab, name: String(bot.name || 'Bot').slice(0, 80), mia: !!bot.mia}; }),
      at: now};
    return next;
  }
  function livePresence(presence, now){
    var next = {};
    Object.keys(presence || {}).forEach(function(id){ if(now - presence[id].at < PRESENCE_TTL_MS) next[id] = presence[id]; });
    return next;
  }

  function initials(name){
    var words = String(name || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    if(!words.length) return '?';
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }
  // One tile per tab: who is on it, which bots work there, and whether it is
  // the tab you are looking at.
  function tiles(space, presence, me){
    var people = Object.keys(presence || {}).map(function(id){ return presence[id]; });
    if(me) people = people.filter(function(person){ return person.id !== me.id; }).concat([me]);
    return (space ? space.tabs : []).map(function(tab){
      var here = people.filter(function(person){ return person.tab === tab.k; }).map(function(person){
        return {id: person.id, name: person.name, initials: initials(person.name), me: !!(me && person.id === me.id)};
      });
      var bots = [];
      people.forEach(function(person){ (person.bots || []).forEach(function(bot){
        if(bot.tab === tab.k) bots.push({name: bot.name, mia: bot.mia, owner: person.name, ownerId: person.id});
      }); });
      return {k: tab.k, title: tab.title || hostOf(tab.url) || 'New tab', url: tab.url, people: here, bots: bots, mine: !!(me && me.tab === tab.k)};
    });
  }
  // Whose copy of a tab its tile shows: who you follow first, then a bot's
  // computer, then a colleague on it. Where someone else is, your own copy
  // never stands in for theirs: the minimap would show your own movements as
  // theirs. Their newest frame is kept if theirs stopped arriving, else none.
  // A tab only you are on shows your copy.
  var FRAME_FRESH_MS = 20000;
  function pickFrame(tile, frames, selfId, now, followId){
    var byPerson = frames && frames[tile.k] || {};
    var others = followId && followId !== selfId ? [followId] : [];
    tile.bots.forEach(function(bot){ if(bot.ownerId !== selfId) others.push(bot.ownerId); });
    tile.people.forEach(function(person){ if(person.id !== selfId) others.push(person.id); });
    for(var i = 0; i < others.length; i++){
      var frame = byPerson[others[i]];
      if(frame && now - frame.at < FRAME_FRESH_MS) return frame;
    }
    var newest = function(ids){ return ids.map(function(id){ return byPerson[id]; }).filter(Boolean).sort(function(a, b){ return b.at - a.at; })[0] || null; };
    if(others.length) return newest(others);
    var ownAndRest = Object.keys(byPerson);
    return (selfId && byPerson[selfId]) || newest(ownAndRest);
  }
  // The line beside Follow: who is working in this group right now.
  // `active` holds teammates (other than you) moving on a tab: [{name, tab}].
  function activity(tiles, active, doneCount){
    var bots = [];
    tiles.forEach(function(tile, index){ tile.bots.forEach(function(bot){ bots.push({name: bot.name, tab: index + 1}); }); });
    var people = [];
    (active || []).forEach(function(person){
      var index = tiles.map(function(tile){ return tile.k; }).indexOf(person.tab);
      if(index >= 0) people.push({name: person.name, tab: index + 1});
    });
    var total = bots.length + people.length;
    if(!total) return doneCount && doneCount === tiles.length ? {lead: tiles.length === 1 ? 'The tab' : 'All ' + tiles.length + ' tabs', rest: tiles.length === 1 ? ' is done' : ' are done'} : null;
    if(total === 1){ var one = bots[0] || people[0]; return {lead: one.name, rest: ' is working in tab ' + one.tab}; }
    var parts = [];
    if(bots.length) parts.push(bots.length + (bots.length === 1 ? ' bot' : ' bots'));
    if(people.length) parts.push(people.length + (people.length === 1 ? ' person' : ' people'));
    return {lead: parts.join(' and '), rest: ' are working in this tab group'};
  }
  // What the toolbar shows while someone else is in the session. Follow stays
  // reachable when nobody is moving, and while you are following someone.
  function toolbarLine(summary, followedName, others){
    if(followedName) return {lead: 'Following ' + followedName, rest: ''};
    if(summary) return summary;
    if(!others || !others.length) return null;
    return others.length === 1 ? {lead: others[0].name, rest: ' is in this session'} : {lead: others.length + ' people', rest: ' are in this session'};
  }
  function hostOf(url){ var m = /^https?:\/\/([^/?#]+)/i.exec(url || ''); return m ? m[1].replace(/^www\./, '') : ''; }

  // What this computer must do so its tab group matches the space: open the
  // tabs it lacks and close the ones the space dropped. `links` maps a space
  // tab key to the local tab id.
  function reconcile(space, links, localTabs){
    var localIds = {};
    (localTabs || []).forEach(function(tab){ localIds[tab.id] = tab; });
    var open = [], close = [], keys = {};
    (space ? space.tabs : []).forEach(function(tab){
      keys[tab.k] = true;
      if(!(links[tab.k] && localIds[links[tab.k]]) && tab.url) open.push(tab);
    });
    Object.keys(links || {}).forEach(function(key){ if(!keys[key] && localIds[links[key]]) close.push(links[key]); });
    return {open: open, close: close};
  }
  // The space's tab list as this computer's group now has it: new local tabs
  // get a key, closed ones drop out, and pages keep their latest address.
  // With `keepUnopened`, tabs this person has not opened stay in the list, in
  // their place: not approving a page must not remove it for everyone.
  function localTabList(space, links, groupTabs, makeKey, keepUnopened, approved, opening){
    var byLocal = {};
    Object.keys(links).forEach(function(key){ byLocal[links[key]] = key; });
    var previous = {};
    (space ? space.tabs : []).forEach(function(tab){ previous[tab.k] = tab; });
    var nextLinks = {}, list = [];
    (groupTabs || []).forEach(function(tab){
      var url = shareableUrl(tab.url);
      var key = byLocal[tab.id];
      if(!key){ if(!url) return; key = makeKey(); }
      nextLinks[key] = tab.id;
      // In page-approval mode, a remote address may be waiting while this
      // computer is still showing the last approved address. Do not publish
      // that old address back to the team and undo their navigation.
      if(keepUnopened && previous[key] && (
        (approved && approved[key] === url && previous[key].url !== url) ||
        (opening && opening[key] && opening[key] !== url)
      )){
        list.push(previous[key]);
      } else {
        list.push({k: key, url: url || (previous[key] && previous[key].url) || '', title: String(tab.title || '').slice(0, 200)});
      }
    });
    if(keepUnopened) (space ? space.tabs : []).forEach(function(tab, index){
      if(!links[tab.k]) list.splice(Math.min(index, list.length), 0, tab);
    });
    return {tabs: list.slice(0, MAX_TABS), links: nextLinks};
  }
  // Rejoining: which tabs of the copy left on this computer are the session's
  // pages (matched by address), and which are something else and must not be shared.
  function reuseGroupTabs(space, groupTabs){
    var links = {}, used = {};
    (space ? space.tabs : []).forEach(function(tab){
      var match = (groupTabs || []).filter(function(local){ return !used[local.id] && tab.url && shareableUrl(local.url) === tab.url; })[0];
      if(match){ links[tab.k] = match.id; used[match.id] = true; }
    });
    return {links: links, strays: (groupTabs || []).filter(function(local){ return !used[local.id]; }).map(function(local){ return local.id; })};
  }
  // Pages waiting for this person's answer: in the space, not open here, not ignored.
  function pendingPages(space, links, ignored, approved){
    return (space ? space.tabs : []).filter(function(tab){
      return tab.url && (!links[tab.k] || !approved || approved[tab.k] !== tab.url) && (!ignored || ignored[tab.k] !== tab.url);
    });
  }
  function sameTabs(a, b){
    if(a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++) if(a[i].k !== b[i].k || a[i].url !== b[i].url) return false;
    return true;
  }

  return {pickFrame: pickFrame, activity: activity, toolbarLine: toolbarLine, MARKER: MARKER, PRESENCE_TTL_MS: PRESENCE_TTL_MS, MAX_TABS: MAX_TABS, encode: encode, decode: decode, isSpaceMessage: isSpaceMessage, isAdminEnd: isAdminEnd,
    shareableUrl: shareableUrl, applySpace: applySpace, applyPresence: applyPresence, livePresence: livePresence, initials: initials,
    tiles: tiles, hostOf: hostOf, reconcile: reconcile, localTabList: localTabList, reuseGroupTabs: reuseGroupTabs, pendingPages: pendingPages, sameTabs: sameTabs};
});
