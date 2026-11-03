/* Shared space bar: a tab group teammates work in together, with a minimap of
   who is on which tab and where bots are working. Logic lives in
   shared-space.js; this file wires it to the browser and the team channel. */
(function(){
  'use strict';
  var model = window.MiaSharedSpace;
  var bridge = window.miaDesktop && window.miaDesktop.browser;
  var bar = document.getElementById('miaSpaceBar');
  if(!model || !bridge || !bar) return;
  var host = function(){ return window.MiaSpaceHost || null; };
  var HEARTBEAT_MS = 30000;
  // The minimap: about one frame a second where someone is working, a slower
  // refresh for the other tabs, and pointers a few times a second.
  var FRAME_MS = 1000, IDLE_FRAME_EVERY = 5, FRAME_WIDTH = 360, POINTER_MS = 250, POINTER_FRESH_MS = 15000, MAX_FRAME_CHARS = 200000;
  var pageHead = document.getElementById('miaSpacePageHead');
  // In the chat beside the browser: the call controls, and invitations for this person.
  var callBar = document.getElementById('miaSpaceCall'), chatInvites = document.getElementById('miaSpaceChatInvites');
  var inviteBtn = document.getElementById('localBrowserInviteBtn');
  // Switching workspace reloads this page, so the session lives in storage:
  // coming back within this long puts you back in it without asking again.
  var MAP_TOGGLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6l5 5 5-5M7 13l5 5 5-5"/></svg>';
  var MAP_KEY = 'miaSharedMapHidden', SESSION_KEY = 'miaSharedSession', LEFTOVERS_KEY = 'miaSharedLeftoverGroups', RESUME_MS = 3600000;

  var s = {space:null, teamKey:null, channelId:null, groupId:null, links:{}, presence:{}, invites:{},
    follow:null, browser:null, pendingOpens:0, sent:{}, timers:{}, shareChannelId:null, ended:{}, notice:null,
    confirming:null, approveEach:false, ignored:{}, joined:false, resumeChecked:false, dismissed:{}, rung:{}, invited:{}, callMenu:null, joinedAt:0,
    sharePicking:null, zoomed:false, covered:false, mapHidden:false, mesh:null, frames:{}, pointers:{}, botPoints:{}, worked:{}, done:{}, lastBot:{}, frameBusy:false, frameTick:0, cursorSig:'', cursorTab:null, pillSig:''};

  function key(){ return Array.from(crypto.getRandomValues(new Uint8Array(8)), function(b){ return b.toString(16).padStart(2, '0'); }).join(''); }
  function esc(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){ return '&#' + ch.charCodeAt(0) + ';'; }); }
  function me(){ var h = host(); return h && h.me(); }
  function teamKey(){ var h = host(); return h ? h.teamKey() : null; }
  function bound(){ return !!(s.space && s.teamKey && s.teamKey === teamKey()); }
  function command(action, extra){ return bridge.command(Object.assign({action: action}, extra || {})); }
  function readStored(name){
    try { return JSON.parse(window.localStorage.getItem(name) || 'null'); } catch(_storedError) { return null; }
  }
  function writeStored(name, value){
    try {
      if(value) window.localStorage.setItem(name, JSON.stringify(value));
      else window.localStorage.removeItem(name);
    } catch(_storedError) {}
  }

  s.mapHidden = readStored(MAP_KEY) === true;

  // ---- Staying in a session across a reload --------------------------------
  // Only written while the session is showing, so `at` is when it was last in use.
  function saveSession(){
    if(!bound() || !me()) return;
    writeStored(SESSION_KEY, {space: s.space, teamKey: s.teamKey, channelId: s.channelId, groupId: s.groupId, links: s.links,
      follow: s.follow, approveEach: s.approveEach, ignored: s.ignored, joined: s.joined, user: me().id, at: Date.now()});
  }
  function resumeSession(){
    var team = teamKey(), self = me();
    if(s.resumeChecked || s.space || !team || !self) return;
    s.resumeChecked = true;
    var saved = readStored(SESSION_KEY);
    if(!saved || saved.teamKey !== team) return;
    if(saved.user !== self.id || !saved.space || Date.now() - Number(saved.at || 0) >= RESUME_MS){ writeStored(SESSION_KEY, null); return; }
    start(saved.channelId, saved.space, saved.groupId || null, saved.links);
    enterRoom();
    s.follow = saved.follow || null; s.approveEach = !!saved.approveEach; s.ignored = saved.ignored || {}; s.joined = !!saved.joined;
    sendPresence(true);
  }

  // ---- Sending -------------------------------------------------------------
  function post(message){
    var h = host(), self = me();
    if(!h || !self || !s.channelId) return;
    var payload = Object.assign({space: s.space.id, from: {id: self.id, name: self.name}, at: Date.now()}, message);
    h.send(s.channelId, model.encode(payload)).catch(function(){ /* The next heartbeat resends the state. */ });
  }
  // Each kind of update goes out at most this often; the latest one wins.
  function later(kind, delay, fn){
    clearTimeout(s.timers[kind]);
    s.timers[kind] = setTimeout(fn, delay);
  }
  function sendSpace(){ if(bound()) post({t: 'space', name: s.space.name, rev: s.space.rev, startedAt: s.space.startedAt, tabs: s.space.tabs}); }
  function myPresence(){
    var state = s.browser, linksByLocal = {};
    Object.keys(s.links).forEach(function(k){ linksByLocal[s.links[k]] = k; });
    var active = state && state.tabs.filter(function(tab){ return tab.active; })[0];
    var bots = [];
    (state ? state.tabs : []).forEach(function(tab){
      if(tab.botActivity && linksByLocal[tab.id]) bots.push({tab: linksByLocal[tab.id], name: tab.botActivity.name || (tab.botActivity.mia ? 'Mia' : 'Bot'), mia: !!tab.botActivity.mia});
    });
    return {t: 'here', tab: active && linksByLocal[active.id] || null, url: active ? model.shareableUrl(active.url) : '', follow: s.follow, away: !inRoom(), bots: bots};
  }
  // In the call means the browser is in front. Back to Mia keeps you in the call, stepped out.
  function inRoom(){ return document.body.classList.contains('browser-collab-mode'); }
  function syncZoom(){
    var zoomed = bound() && inRoom(), returning = zoomed && !s.zoomed && !!s.joinedAt;
    if(zoomed === s.zoomed) return;
    s.zoomed = zoomed;
    document.body.classList.toggle('mia-call-zoomed', zoomed);
    if(!zoomed) s.callMenu = null;
    if(!bound()) return;
    sendPresence(true);
    // Following waits while you are out, then catches up with them.
    var followed = returning && s.follow && s.presence[s.follow];
    if(followed) goTo(followed.tab, followed.url);
    render();
  }
  function sendPresence(force){
    if(!bound()) return;
    var here = myPresence(), sig = JSON.stringify(here);
    if(!force && sig === s.sent.here) return;
    s.sent.here = sig; post(here);
  }

  // ---- Browser -------------------------------------------------------------
  function groupTabs(){ return s.browser && s.groupId ? s.browser.tabs.filter(function(tab){ return tab.groupId === s.groupId; }) : []; }
  function onBrowser(state){
    s.browser = state;
    resumeSession();
    // The browser can still be on another workspace's tabs right after a reload.
    var onOurTabs = !state.workspace || state.workspace === s.teamKey;
    if(bound() && onOurTabs){
      // Someone approving page by page may have no group yet.
      var groupGone = !!s.groupId && !state.groups.some(function(group){ return group.id === s.groupId; });
      if(groupGone && state.tabs.length && !s.pendingOpens){ leave(true); return render(); }
      if(!s.pendingOpens){
        // Tabs opened, closed or moved in this group change the space for everyone.
        var next = model.localTabList(s.space, s.links, groupTabs(), key, s.approveEach);
        s.links = next.links;
        if(!model.sameTabs(s.space.tabs, next.tabs)){
          s.space = Object.assign({}, s.space, {tabs: next.tabs, rev: s.space.rev + 1, by: me().id});
          later('space', 600, sendSpace);
        }
      }
      later('here', 350, function(){ sendPresence(false); });
      stayInSession();
    }
    render();
  }
  // In a session the browser is the session: nothing but its tabs and your
  // private ones comes to the front.
  function stayInSession(){
    var state = s.browser, active = state.tabs.filter(function(tab){ return tab.active; })[0];
    if(s.pendingOpens || !s.groupId || !active || active.groupId === s.groupId || active.private) return;
    var first = groupTabs()[0];
    if(first) command('select', {id: first.id}).catch(function(){});
  }
  // Titles arrive after the address. A tile shows this computer's copy of the
  // page's title and sends no update, so two copies can't argue over wording.
  function shownSpace(){
    var tabs = s.browser ? s.browser.tabs : [];
    return Object.assign({}, s.space, {tabs: s.space.tabs.map(function(tab){
      var local = tabs.filter(function(item){ return item.id === s.links[tab.k]; })[0];
      return local && local.title ? Object.assign({}, tab, {title: local.title}) : tab;
    })});
  }
  function enterRoom(){
    var h = host();
    if(h && h.enterSession) h.enterSession(s.channelId);
  }
  function goTo(tabKey, url){
    var id = s.links[tabKey];
    if(!id) return Promise.resolve();
    var local = s.browser && s.browser.tabs.filter(function(tab){ return tab.id === id; })[0];
    return command('select', {id: id}).then(function(){
      // Approving page by page: come to the tab, but no new address without a yes.
      var target = s.approveEach ? '' : model.shareableUrl(url);
      if(target && local && model.shareableUrl(local.url) !== target) return command('navigate', {value: target});
    }).catch(function(){});
  }
  // Opens the tabs the space has and this computer lacks, in the background,
  // and closes the ones the space dropped.
  function applyRemoteTabs(){
    var plan = model.reconcile(s.space, s.links, s.browser ? s.browser.tabs : []);
    plan.close.forEach(function(id){ command('close', {id: id}).catch(function(){}); });
    plan.close.forEach(function(id){ Object.keys(s.links).forEach(function(k){ if(s.links[k] === id) delete s.links[k]; }); });
    if(s.approveEach) return Promise.resolve();
    return plan.open.reduce(function(chain, tab){
      return chain.then(function(){ return openLinked(tab, false); });
    }, Promise.resolve());
  }
  function openLinked(tab, activate){
    if(!s.space) return Promise.resolve();
    s.pendingOpens++;
    return command('spaceOpenTab', {url: tab.url, groupId: s.groupId, name: s.space.name, activate: activate}).then(function(result){
      if(result && result.openedId){ s.links[tab.k] = result.openedId; s.groupId = result.groupId || s.groupId; }
    }).catch(function(){}).then(function(){ s.pendingOpens--; });
  }

  // ---- Receiving -----------------------------------------------------------
  function receive(channelId, row){
    var message = model.decode(row && row.body);
    if(!message) return;
    resumeSession();
    // Only the Hub can end a session; the same words from anyone else mean nothing.
    if(message.t === 'end'){
      if(model.isAdminEnd(row)) endedByAdmin(channelId, message.space);
      return;
    }
    message.from = {id: row.author_id, name: message.from && message.from.name || row.author_name || row.author_email || 'Teammate'};
    if(message.t === 'ring'){
      var self = me();
      if(self && message.to === self.id && message.from.id !== self.id && !(bound() && s.space.id === message.space)){
        s.rung[message.space] = true;
        delete s.dismissed[message.space];
        toast(message.from.name + ' invited you to browse together');
        render();
      }
      return;
    }
    if(bound() && message.space === s.space.id){
      if(message.t === 'rtc'){
        // Live views connect directly; these hidden messages only introduce the two computers.
        if(s.mesh && me() && message.to === me().id && message.from.id !== me().id) s.mesh.signal(message.from.id, message);
        return;
      }
      if(message.t === 'space'){
        var next = model.applySpace(s.space, message);
        if(next !== s.space){ s.space = next; applyRemoteTabs().then(render); }
      } else if(message.t === 'look'){
        s.follow = null; goTo(message.tab, message.url);
        toast(message.from.name + ' asked everyone to look at ' + (tabTitle(message.tab) || 'a tab'));
      } else {
        var before = s.presence[message.from.id];
        s.presence = model.applyPresence(s.presence, message, Date.now());
        var now = s.presence[message.from.id];
        // Someone new can't see us until we say where we are; both sides answer once.
        if(message.t === 'here' && !before) sendPresence(true);
        if(s.follow === message.from.id && now && s.zoomed && (!before || before.tab !== now.tab || before.url !== now.url)) goTo(now.tab, now.url);
        if(message.t === 'leave' && s.follow === message.from.id) s.follow = null;
      }
    } else if(message.t === 'space' && !bound() && !s.ended[message.space]){
      var invite = s.invites[message.space];
      s.invites[message.space] = {channelId: channelId, teamKey: teamKey(), from: message.from, space: model.applySpace(invite && invite.space, message), at: Date.now()};
    } else if(message.t === 'leave' && s.invites[message.space] && s.invites[message.space].from.id === message.from.id){
      delete s.invites[message.space];
    }
    render();
  }
  // Tabs stay open on this computer, the same as leaving. The session's id is
  // remembered so a teammate's last update can't offer it again right away.
  function endedByAdmin(channelId, spaceId){
    s.ended[spaceId] = true;
    delete s.invites[spaceId];
    if(bound() && s.space.id === spaceId && s.channelId === channelId){
      var text = 'An admin ended ' + s.space.name + ' for everyone. Your tabs stay open on this computer.';
      s.notice = {text: text, at: Date.now()};
      leave(false);
      toast(text);
    }
    render();
  }
  function tabTitle(tabKey){
    var tab = s.space && s.space.tabs.filter(function(item){ return item.k === tabKey; })[0];
    return tab ? tab.title || model.hostOf(tab.url) : '';
  }

  // ---- Actions -------------------------------------------------------------
  function selectedGroup(){
    var state = s.browser;
    return state && state.selectedGroupId ? state.groups.filter(function(group){ return group.id === state.selectedGroupId; })[0] : null;
  }
  // Tells this computer's backend a session is live, so Mia and bots are reminded on every turn.
  function announce(active){ var h = host(); if(h && h.sharedSession) h.sharedSession(active); }
  function start(channelId, space, groupId, links){
    s.space = space; s.teamKey = teamKey(); s.channelId = channelId; s.groupId = groupId; s.links = links || {};
    s.presence = {}; s.follow = null; s.sent = {}; s.confirming = null; s.approveEach = false; s.ignored = {}; s.joined = false;
    s.sharePicking = null; s.invited = {}; s.callMenu = null; s.joinedAt = Date.now();
    delete s.rung[space.id]; delete s.dismissed[space.id];
    command('spaceSession', {groupId: groupId}).catch(function(){});
    announce(true);
    startLive();
    clearInterval(s.timers.beat);
    s.timers.beat = setInterval(function(){
      if(!bound()) return;
      announce(true);
      s.presence = model.livePresence(s.presence, Date.now());
      sendPresence(true); sendSpace(); render();
    }, HEARTBEAT_MS);
  }
  function share(){
    var group = selectedGroup(), self = me(), channelId = s.shareChannelId || defaultChannel();
    if(!group || !self || !channelId) return;
    var tabs = s.browser.tabs.filter(function(tab){ return tab.groupId === group.id; });
    var list = model.localTabList(null, {}, tabs, key);
    if(!list.tabs.length){ toast('Open a web page in this group first.'); return; }
    start(channelId, {id: key(), name: group.name || 'Shared tabs', rev: 1, by: self.id, startedAt: Date.now(), tabs: list.tabs}, group.id, list.links);
    enterRoom();
    sendSpace(); sendPresence(true); render();
  }
  // Starting from a chat always opens a new group, so no page you already had
  // open is shared by surprise.
  var START_PAGE = 'https://www.google.com/';
  function startInChannel(channelId){
    var self = me(), h = host(), channel = (h ? h.channels() : []).filter(function(item){ return item.id === channelId; })[0];
    if(!self || !channel || bound()) return Promise.resolve();
    return command('spaceOpenTab', {url: START_PAGE, name: channel.name, activate: true}).then(function(result){
      if(!result || !result.openedId || bound()) return;
      var tabKey = key(), links = {};
      links[tabKey] = result.openedId;
      start(channelId, {id: key(), name: channel.name, rev: 1, by: self.id, startedAt: Date.now(), tabs: [{k: tabKey, url: START_PAGE, title: 'Google'}]}, result.groupId, links);
      enterRoom();
      sendSpace(); sendPresence(true); render();
      s.callMenu = 'invite'; renderCall();
    }).catch(function(){ toast('Could not start the session. Try again.'); });
  }
  // The toolbar's Invite: inside a session it opens the people list, otherwise
  // it starts one from the page in front.
  function inviteFromToolbar(){
    if(bound()){ s.callMenu = 'invite'; renderCall(); return; }
    var state = s.browser, active = state && state.tabs.filter(function(tab){ return tab.active; })[0];
    var group = selectedGroup();
    if(active && active.private){ toast('This tab is private. Open a shared page to invite your team.'); return; }
    if(!active || !model.shareableUrl(active.url)){ toast('Open a web page first, then invite your team.'); return; }
    if(group && group.id === active.groupId){ s.sharePicking = group.id; render(); return; }
    command('groupCreate', {id: active.id, name: active.title || 'Shared tabs'}).then(function(next){
      var created = next && next.groups && next.tabs && next.tabs.filter(function(tab){ return tab.id === active.id; })[0];
      s.browser = next && next.tabs ? next : s.browser;
      s.sharePicking = created && created.groupId || null;
      render();
    }).catch(function(){});
  }
  // `approveEach`: nothing opens until this person says yes to that page.
  function join(spaceId, approveEach){
    var invite = s.invites[spaceId];
    if(!invite || !invite.space || !invite.space.tabs.length) return;
    delete s.invites[spaceId];
    var reuse = leftoverPlan(invite);
    // Pages that aren't part of this session leave the group first, so they are never shared.
    if(reuse.strays.length){
      Promise.all(reuse.strays.map(function(id){ return command('groupRemoveTab', {id: id}).catch(function(){}); }))
        .then(function(){ enterSession(invite, approveEach, reuse); });
      return;
    }
    enterSession(invite, approveEach, reuse);
  }
  function enterSession(invite, approveEach, reuse){
    start(invite.channelId, invite.space, reuse.groupId, reuse.links);
    s.joined = true;
    enterRoom();
    var reusedFirst = invite.space.tabs.filter(function(tab){ return tab.url && reuse.links[tab.k]; })[0];
    if(reusedFirst) command('select', {id: reuse.links[reusedFirst.k]}).catch(function(){});
    if(approveEach){
      s.approveEach = true;
      sendPresence(true); render();
      return;
    }
    s.pendingOpens++;
    var first = invite.space.tabs.filter(function(tab){ return tab.url && !reuse.links[tab.k]; });
    first.reduce(function(chain, tab, index){
      return chain.then(function(){ return openLinked(tab, index === 0 && !reusedFirst); });
    }, Promise.resolve()).then(function(){
      s.pendingOpens--;
      if(!s.space) return render();
      s.follow = invite.from.id;
      sendPresence(true); render();
    });
    render();
  }
  // Leaving keeps the tabs, so joining the same group again picks up that copy
  // instead of opening a second one.
  function leftoverKey(channelId, name){ return [teamKey(), channelId, name].join('|'); }
  function leftoverPlan(invite){
    var leftovers = readStored(LEFTOVERS_KEY) || {}, id = leftoverKey(invite.channelId, invite.space.name), groupId = leftovers[id];
    delete leftovers[id];
    writeStored(LEFTOVERS_KEY, leftovers);
    // A group of another name took this number: not the copy from last time.
    var same = groupId && s.browser && s.browser.groups.some(function(group){ return group.id === groupId && group.name === invite.space.name; });
    var tabs = same ? s.browser.tabs.filter(function(tab){ return tab.groupId === groupId; }) : [];
    var plan = model.reuseGroupTabs(invite.space, tabs);
    plan.groupId = Object.keys(plan.links).length ? groupId : null;
    return plan;
  }
  function leave(silent){
    if(s.space && !silent) post({t: 'leave'});
    if(s.space && s.joined && s.groupId && !silent){
      var leftovers = readStored(LEFTOVERS_KEY) || {};
      leftovers[leftoverKey(s.channelId, s.space.name)] = s.groupId;
      writeStored(LEFTOVERS_KEY, leftovers);
    }
    writeStored(SESSION_KEY, null);
    command('spaceSession', {groupId: null}).catch(function(){});
    s.callMenu = null;
    announce(false);
    clearInterval(s.timers.beat);
    stopLive();
    s.space = null; s.groupId = null; s.links = {}; s.presence = {}; s.follow = null;
    render();
    if(host() && host().leftSession) host().leftSession();
  }
  // Stays quiet about this session unless someone invites this person directly.
  function declineInvite(spaceId){
    s.dismissed[spaceId] = true;
    delete s.rung[spaceId];
    s.confirming = null;
    render();
  }
  function openPage(tabKey){
    var tab = s.space && s.space.tabs.filter(function(item){ return item.k === tabKey; })[0];
    if(!tab || !tab.url || s.links[tab.k]) return;
    openLinked(tab, true).then(function(){ sendPresence(true); render(); });
  }
  function lookHere(){
    var here = myPresence();
    if(!here.tab){ toast('Open one of the space’s tabs first.'); return; }
    post({t: 'look', tab: here.tab, url: here.url});
    toast('Everyone in the space is coming to this tab.');
  }
  function followPerson(id){
    s.follow = s.follow === id ? null : id;
    var person = s.presence[id];
    if(s.follow && person && s.zoomed) goTo(person.tab, person.url);
    sendPresence(true); render();
  }
  function defaultChannel(){
    var h = host(), channels = h ? h.channels() : [];
    var test = channels.filter(function(channel){ return /space-test/i.test(channel.name); })[0];
    return (test && test.id) || (h && h.activeChannelId()) || (channels[0] && channels[0].id) || null;
  }
  function toast(text){ var h = host(); if(h && h.toast) h.toast(text); }

  // ---- Live minimap --------------------------------------------------------
  // Pixels and pointers go straight between computers over WebRTC and are never
  // sent through or stored on the Hub.
  function startLive(){
    stopLive();
    var self = me();
    if(self && window.MiaSpaceLive && window.RTCPeerConnection) s.mesh = window.MiaSpaceLive.createMesh({
      selfId: self.id,
      signal: function(to, payload){ if(bound()) post(Object.assign({t: 'rtc', to: to}, payload)); },
      onMessage: onLive
    });
  }
  function stopLive(){
    if(s.mesh) s.mesh.close();
    s.mesh = null; s.frames = {}; s.pointers = {}; s.botPoints = {}; s.worked = {}; s.done = {}; s.lastBot = {};
    s.cursorSig = ''; s.frameTick = 0;
    if(s.cursorTab){ command('spaceCursors', {id: s.cursorTab, cursors: []}).catch(function(){}); s.cursorTab = null; }
    if(pageHead){ pageHead.hidden = true; pageHead.textContent = ''; }
    syncToolbar();
  }
  function onLive(fromId, message){
    if(!bound() || !s.presence[fromId] || !message || typeof message.tab !== 'string') return;
    if(!s.space.tabs.some(function(tab){ return tab.k === message.tab; })) return;
    if(message.t === 'f'){
      if(typeof message.url !== 'string' || message.url.length > MAX_FRAME_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(message.url)) return;
      keepFrame(message.tab, fromId, message.url);
      syncLive();
    } else if(message.t === 'p' || message.t === 'b'){
      var x = Number(message.x), y = Number(message.y);
      if(!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
      if(message.t === 'p') s.pointers[fromId] = {k: message.tab, x: x, y: y, at: Date.now()};
      else s.botPoints[fromId + '|' + String(message.name || 'Bot').slice(0, 80)] = {k: message.tab, x: x, y: y, at: Date.now()};
      syncLive();
    }
  }
  function keepFrame(tabKey, personId, url){
    (s.frames[tabKey] = s.frames[tabKey] || {})[personId] = {url: url, at: Date.now()};
  }
  function linkedTabs(){
    var byKey = s.browser ? s.browser.tabs : [], out = [];
    Object.keys(s.links).forEach(function(k){
      var tab = byKey.filter(function(item){ return item.id === s.links[k]; })[0];
      if(tab && model.shareableUrl(tab.url)) out.push({k: k, tab: tab});
    });
    return out;
  }
  function tickFrames(){
    if(!bound() || s.frameBusy || !s.browser) return;
    var peers = s.mesh ? s.mesh.openCount() : 0;
    if(!peers && (s.mapHidden || !bar.offsetParent)) return;
    s.frameTick++;
    var refreshAll = s.frameTick % IDLE_FRAME_EVERY === 1;
    var links = linkedTabs().filter(function(link){ return refreshAll || link.tab.active || link.tab.botActivity; });
    if(!links.length) return;
    s.frameBusy = true;
    command('spaceFrames', {ids: links.map(function(link){ return link.tab.id; }), width: FRAME_WIDTH}).then(function(result){
      if(!bound() || !me()) return;
      (result && result.frames || []).forEach(function(frame){
        var link = links.filter(function(item){ return item.tab.id === frame.id; })[0];
        if(!link) return;
        keepFrame(link.k, me().id, frame.dataUrl);
        if(s.mesh) s.mesh.send({t: 'f', tab: link.k, url: frame.dataUrl});
      });
      syncLive();
    }).catch(function(){}).then(function(){ s.frameBusy = false; });
  }
  function tickPointers(){
    if(!bound() || !s.browser || !me()) return;
    var links = linkedTabs();
    if(!links.length) return syncCursors();
    command('spacePointers', {ids: links.map(function(link){ return link.tab.id; })}).then(function(result){
      if(!bound() || !me()) return;
      var pointers = result && result.pointers || {};
      links.forEach(function(link){
        var now = pointers[link.tab.id];
        if(!now) return;
        if(link.tab.active && now.pointer && (!s.pointers[me().id] || s.pointers[me().id].stamp !== now.pointer.at)){
          s.pointers[me().id] = {k: link.k, x: now.pointer.x, y: now.pointer.y, at: now.pointer.at, stamp: now.pointer.at};
          if(s.mesh) s.mesh.send({t: 'p', tab: link.k, x: now.pointer.x, y: now.pointer.y});
        }
        var worker = link.tab.botActivity;
        if(worker && now.bot){
          var id = me().id + '|' + (worker.name || (worker.mia ? 'Mia' : 'Bot')), seen = s.botPoints[id];
          if(!seen || seen.stamp !== now.bot.at || seen.k !== link.k){
            s.botPoints[id] = {k: link.k, x: now.bot.x, y: now.bot.y, at: now.bot.at, stamp: now.bot.at};
            if(s.mesh) s.mesh.send({t: 'b', tab: link.k, name: worker.name || 'Bot', x: now.bot.x, y: now.bot.y});
          }
        }
      });
      syncLive();
    }).catch(function(){});
  }
  function tone(id){
    var hash = 0;
    String(id).split('').forEach(function(ch){ hash = (hash * 31 + ch.charCodeAt(0)) % 360; });
    return 'hsl(' + hash + ', 62%, 44%)';
  }
  function liveTiles(){
    var self = me(), here = myPresence();
    return model.tiles(shownSpace(), model.livePresence(s.presence, Date.now()), self ? {id: self.id, name: self.name, tab: here.tab, bots: here.bots} : null);
  }
  function activePeople(){
    var self = me(), now = Date.now();
    return Object.keys(s.pointers).filter(function(id){
      return (!self || id !== self.id) && s.presence[id] && now - s.pointers[id].at < 10000;
    }).map(function(id){ return {id: id, name: s.presence[id].name, tab: s.pointers[id].k}; });
  }
  // Where everyone else is. You know where you are: your tile has the dark ring.
  function markersFor(tile){
    var now = Date.now(), list = [];
    tile.people.forEach(function(person){
      if(person.me) return;
      var point = s.pointers[person.id];
      list.push({key: 'p' + person.id, name: person.name, initials: person.initials, color: tone(person.id), me: person.me,
        point: point && point.k === tile.k && now - point.at < POINTER_FRESH_MS ? point : null});
    });
    tile.bots.forEach(function(bot){
      var point = s.botPoints[bot.ownerId + '|' + bot.name];
      list.push({key: 'b' + bot.ownerId + bot.name, name: bot.name + ' · ' + bot.owner, bot: bot.name,
        point: point && point.k === tile.k && now - point.at < POINTER_FRESH_MS ? point : null});
    });
    return list;
  }
  function paintMarkers(node, tile){
    var box = node.querySelector('.mia-space-marks'), wanted = {}, h = host();
    if(!box) return;
    markersFor(tile).forEach(function(marker, index){
      wanted[marker.key] = true;
      var el = Array.prototype.filter.call(box.children, function(item){ return item.getAttribute('data-mark') === marker.key; })[0];
      if(!el){
        el = document.createElement(marker.bot ? 'img' : 'span');
        el.setAttribute('data-mark', marker.key);
        el.className = 'mia-space-mark' + (marker.bot ? ' bot' : '');
        if(marker.bot){ el.alt = ''; el.src = h && h.moteSrc ? h.moteSrc(marker.bot) : ''; }
        else { el.textContent = marker.name.split(' ')[0]; el.style.background = marker.color; }
        box.appendChild(el);
      }
      el.title = marker.name;
      // Nothing to report yet: wait in a row at the bottom of the tile.
      el.style.left = (marker.point ? marker.point.x * 100 : 10 + index * 16) + '%';
      el.style.top = (marker.point ? marker.point.y * 100 : 78) + '%';
    });
    Array.prototype.slice.call(box.children).forEach(function(el){ if(!wanted[el.getAttribute('data-mark')]) el.remove(); });
  }
  // Frames and markers update in place, so a repaint of the bar never disturbs them.
  function syncLive(){
    if(!bound()) return;
    var tiles = liveTiles(), self = me(), now = Date.now();
    tiles.forEach(function(tile){
      if(tile.bots.length){ s.worked[tile.k] = true; s.done[tile.k] = false; s.lastBot[tile.k] = tile.bots[0]; }
      else if(s.worked[tile.k]) s.done[tile.k] = true;
      var node = bar.querySelector('[data-space-tab="' + tile.k + '"]');
      if(!node) return;
      var frame = model.pickFrame(tile, s.frames, self && self.id, now), img = node.querySelector('.mia-space-frame');
      if(img && frame && img.getAttribute('src') !== frame.url){ img.src = frame.url; img.hidden = false; }
      node.classList.toggle('working', tile.bots.length > 0);
      node.classList.toggle('done', !!s.done[tile.k]);
      paintMarkers(node, tile);
    });
    syncPageHead(tiles);
    syncCursors(tiles);
    syncToolbar();
  }
  function activeTile(tiles){
    var here = myPresence().tab;
    return here ? tiles.filter(function(tile){ return tile.k === here; })[0] : null;
  }
  function syncPageHead(tiles){
    if(!pageHead) return;
    var tile = activeTile(tiles), self = me(), bot = tile && (tile.bots[0] || (s.done[tile.k] && s.lastBot[tile.k]));
    var person = !bot && tile && activePeople().filter(function(item){ return item.tab === tile.k; })[0];
    var h = host(), html = '';
    if(bot){
      html = '<img class="mia-space-pagehead-mote" alt="" src="' + esc(h && h.moteSrc ? h.moteSrc(bot.name) : '') + '"><span>' + esc(bot.name) + ' · ' +
        esc(self && bot.ownerId === self.id ? 'You' : bot.owner) + '</span><span class="mia-space-status' + (tile.bots.length ? ' on' : '') + '">' + (tile.bots.length ? 'Working' : 'Done') + '</span>';
    } else if(person){
      html = chip({name: person.name}) + '<span>' + esc(person.name) + '</span><span class="mia-space-status on">Working</span>';
    }
    if(pageHead.getAttribute('data-html') !== html){
      pageHead.setAttribute('data-html', html);
      pageHead.innerHTML = html;
      pageHead.hidden = !html;
    }
  }
  // Teammates' pointers and every bot's working spot, drawn over the tab in front.
  function syncCursors(tiles){
    var list = tiles || liveTiles(), tile = activeTile(list), self = me(), now = Date.now(), cursors = [];
    if(tile){
      Object.keys(s.pointers).forEach(function(id){
        var point = s.pointers[id], person = s.presence[id];
        if(self && id === self.id || !person || point.k !== tile.k || now - point.at >= POINTER_FRESH_MS) return;
        cursors.push({id: 'p' + id, label: person.name, x: point.x, y: point.y, color: tone(id)});
      });
      Object.keys(s.botPoints).forEach(function(id){
        var point = s.botPoints[id];
        if(point.k !== tile.k || now - point.at >= POINTER_FRESH_MS) return;
        cursors.push({id: 'b' + id, label: id.slice(id.indexOf('|') + 1), x: point.x, y: point.y, color: tone(id)});
      });
    }
    var tabId = tile ? s.links[tile.k] : null, sig = tabId + JSON.stringify(cursors);
    if(sig === s.cursorSig) return;
    s.cursorSig = sig;
    if(s.cursorTab && s.cursorTab !== tabId) command('spaceCursors', {id: s.cursorTab, cursors: []}).catch(function(){});
    s.cursorTab = tabId;
    if(tabId) command('spaceCursors', {id: tabId, cursors: cursors}).catch(function(){});
  }
  function workerSummary(){
    if(!bound()) return null;
    var tiles = liveTiles(), done = tiles.filter(function(tile){ return s.done[tile.k]; }).length;
    return model.activity(tiles, activePeople(), done);
  }
  // Someone to follow from the toolbar: the first teammate running a bot, else the first one working.
  function workerToFollow(){
    var self = me(), found = null;
    liveTiles().forEach(function(tile){ tile.bots.forEach(function(bot){ if(!found && (!self || bot.ownerId !== self.id)) found = bot.ownerId; }); });
    if(found || activePeople()[0]) return found || activePeople()[0].id;
    return othersHere()[0] ? othersHere()[0].id : null;
  }
  function othersHere(){
    var live = model.livePresence(s.presence, Date.now());
    return Object.keys(live).map(function(id){ return {id: id, name: live[id].name}; });
  }
  function toolbarLine(){
    var followed = s.follow && (s.presence[s.follow] ? s.presence[s.follow].name : 'teammate');
    return model.toolbarLine(workerSummary(), followed, othersHere());
  }
  function syncToolbar(){
    var sig = (s.space ? s.groupId : '') + '|' + JSON.stringify(bound() ? toolbarLine() : null) + '|' + s.follow;
    if(sig === s.pillSig) return;
    s.pillSig = sig;
    if(window.miaNativeBrowser && window.miaNativeBrowser.refresh) window.miaNativeBrowser.refresh();
  }

  // ---- Rendering -----------------------------------------------------------
  var PEOPLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"></path><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.4c1.6.7 2.6 2.3 3 4.6"></path></svg>';
  var BOT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8" width="14" height="10" rx="3"></rect><path d="M12 4v4M9.5 13h.01M14.5 13h.01"></path></svg>';
  function chip(person, extraClass, attrs){
    return '<span class="mia-space-chip ' + (extraClass || '') + '" title="' + esc(person.name) + '"' + (attrs || '') + '>' + esc(person.initials || model.initials(person.name)) + '</span>';
  }
  function inviteHtml(visibleInvites){
    var confirming = s.confirming && visibleInvites.filter(function(invite){ return invite.space.id === s.confirming; })[0];
    if(confirming){
      var id = esc(confirming.space.id);
      return '<div class="mia-space-invite mia-space-confirm" role="alertdialog" aria-label="Before you join"><span class="mia-space-text"><b>Before you join</b><span class="mia-space-hint">In shared-browser sessions, each person in the session can open tabs for the whole group, and they open immediately on your computer. Everyone in the session also sees a small live view of these tabs, including pages you are signed in to.</span></span>' +
        '<span class="mia-space-choices"><button type="button" class="mia-space-btn" data-space-decline="' + id + '">Not now</button>' +
        '<button type="button" class="mia-space-btn" data-space-approve="' + id + '">Approve by page</button>' +
        '<button type="button" class="mia-space-btn primary" data-space-allow="' + id + '">Allow all pages</button></span></div>';
    }
    return visibleInvites.slice(0, 2).map(function(invite){
      var rung = s.rung[invite.space.id];
      return '<div class="mia-space-invite' + (rung ? ' ringing' : '') + '"><span class="mia-space-live-dot" aria-hidden="true"></span><span class="mia-space-text"><b>' + esc(invite.from.name) + (rung ? ' invited you to browse together' : ' is browsing with the team') +
        '</b><span class="mia-space-hint">' + esc(invite.space.name) + ' · ' + invite.space.tabs.length + ' tab' + (invite.space.tabs.length === 1 ? '' : 's') +
        '</span></span><span class="mia-space-choices"><button type="button" class="mia-space-btn" data-space-decline="' + esc(invite.space.id) + '">Not now</button><button type="button" class="mia-space-btn primary" data-space-join="' + esc(invite.space.id) + '">Join</button></span></div>';
    }).join('');
  }
  function render(){
    resumeSession();
    saveSession();
    var team = teamKey(), inSession = bound();
    document.body.classList.toggle('mia-session-mode', inSession);
    syncZoom();
    if(inviteBtn) inviteBtn.hidden = !team || inSession;
    var visibleInvites = Object.keys(s.invites).map(function(id){ return s.invites[id]; })
      .filter(function(invite){ return invite.teamKey === team && Date.now() - invite.at < 120000 && !s.dismissed[invite.space.id]; });
    var group = selectedGroup();
    if(s.notice && Date.now() - s.notice.at >= 60000) s.notice = null;
    renderCall();
    if(inSession){
      paintInvites('');
      bar.hidden = false;
      return renderSpace();
    }
    // Invitations sit in the chat; with the chat pane hidden they fall back to the bar.
    var chatShown = !!chatInvites && !document.body.classList.contains('browser-mia-collapsed');
    var invites = inviteHtml(visibleInvites);
    paintInvites(chatShown ? invites : '');
    var html = s.notice ? '<div class="mia-space-invite" role="status"><span class="mia-space-hint">' + esc(s.notice.text) +
      '</span><button type="button" class="mia-space-btn" data-space-dismiss>OK</button></div>' : '';
    if(!chatShown) html += invites;
    if(group && s.sharePicking === group.id){
      var h = host(), channels = h ? h.channels() : [], chosen = s.shareChannelId || defaultChannel();
      html += '<div class="mia-space-invite"><span class="mia-space-icon">' + PEOPLE_ICON + '</span><span class="mia-space-text"><b>Browse ' + esc(group.name || 'this group') + ' with your team' +
        '</b><span class="mia-space-hint">Everyone in the chat you pick can join, open its tabs and see a small live view of them.</span></span>' +
        '<span class="mia-space-choices"><select class="mia-space-select" data-space-channel aria-label="Chat to invite">' + channels.map(function(channel){
          return '<option value="' + esc(channel.id) + '"' + (channel.id === chosen ? ' selected' : '') + '>' + esc(channel.name) + '</option>';
        }).join('') + '</select><button type="button" class="mia-space-btn" data-space-pick-cancel>Cancel</button><button type="button" class="mia-space-btn primary" data-space-share>Start session</button></span></div>';
    }
    bar.hidden = !html;
    paint(html);
  }
  var painted = null, paintedInvites = null, paintedCall = null;
  function paint(html){ if(html !== painted){ painted = html; bar.innerHTML = html; } }
  function paintInvites(html){
    if(!chatInvites || html === paintedInvites) return;
    paintedInvites = html; chatInvites.innerHTML = html; chatInvites.hidden = !html;
  }
  function clockText(){
    var started = s.space && (s.space.startedAt || s.joinedAt), seconds = started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    var minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    var rest = String(seconds % 60).padStart(2, '0');
    return hours ? hours + ':' + String(minutes % 60).padStart(2, '0') + ':' + rest : minutes + ':' + rest;
  }
  function invitePeople(){
    var h = host(), self = me(), live = model.livePresence(s.presence, Date.now());
    return (h && h.channelPeople ? h.channelPeople(s.channelId) : []).filter(function(person){ return !self || person.id !== self.id; }).map(function(person){
      return {id: person.id, name: person.name, here: !!live[person.id], invited: !!s.invited[person.id]};
    });
  }
  function callMenuHtml(){
    if(s.callMenu === 'more'){
      return '<div class="mia-space-call-menu" role="menu"><button type="button" role="menuitem" data-space-look>Bring everyone to my tab</button>' +
        '<button type="button" role="menuitem" data-space-map="' + (s.mapHidden ? 'show' : 'hide') + '">' + (s.mapHidden ? 'Show' : 'Hide') + ' minimap</button></div>';
    }
    if(s.callMenu !== 'invite') return '';
    var people = invitePeople(), channel = (host() ? host().channels() : []).filter(function(item){ return item.id === s.channelId; })[0];
    var open = people.filter(function(person){ return !person.here; });
    return '<div class="mia-space-call-menu invite" role="dialog" aria-label="Invite people"><b>Invite people</b><span class="mia-space-hint">From ' + esc(channel ? channel.name : 'this chat') + '. Only people in this chat can join.</span>' +
      (people.length ? '<div class="mia-space-invitees">' + people.map(function(person){
        return '<div class="mia-space-invitee">' + chip({name: person.name}) + '<span class="mia-space-invitee-name">' + esc(person.name) + '</span>' +
          (person.here ? '<span class="mia-space-hint">In the session</span>' : person.invited ? '<span class="mia-space-hint">Invited</span>' :
            '<button type="button" class="mia-space-btn" data-space-ring="' + esc(person.id) + '">Invite</button>') + '</div>';
      }).join('') + '</div>' : '<span class="mia-space-hint">No one else is in this chat yet.</span>') +
      (open.length > 1 ? '<button type="button" class="mia-space-btn primary" data-space-ring-all>Invite everyone</button>' : '') + '</div>';
  }
  // The bar takes the group's colour when a bot owns the group, else call green.
  function callColor(){
    var agents = window.miaBrowserAgents, group = s.browser && s.browser.groups.filter(function(item){ return item.id === s.groupId; })[0];
    return group && group.botId && agents && agents.groupColor && agents.groupColor(group.botId) || '#188038';
  }
  function syncCallCover(){
    var cover = !!s.callMenu, browser = window.miaNativeBrowser;
    if(cover === s.covered) return;
    s.covered = cover;
    if(browser && browser.coverPage) browser.coverPage(cover);
  }
  function placeFollow(){
    var slot = callBar.querySelector('.mia-space-call-follow-slot'), browser = window.miaNativeBrowser;
    if(slot && browser && browser.callFollow) slot.append(browser.callFollow);
  }
  function renderCall(){
    if(!callBar) return;
    if(!bound()){
      if(paintedCall !== ''){ paintedCall = ''; callBar.innerHTML = ''; callBar.hidden = true; callBar.className = 'mia-space-call'; }
      syncCallCover();
      return;
    }
    syncCallCover();
    var html;
    if(!s.zoomed){
      callBar.className = 'mia-space-call away';
      html = '<button type="button" class="mia-space-call-return" data-space-return title="Return to ' + esc(s.space.name) + '"><i class="mia-space-live-dot" aria-hidden="true"></i>In a call <b class="mia-space-clock">' + clockText() + '</b><span aria-hidden="true">·</span> Return</button>';
    } else {
      callBar.className = 'mia-space-call';
      var self = me(), live = model.livePresence(s.presence, Date.now());
      var faces = (self ? chip({name: self.name}, 'me') : '') + Object.keys(live).map(function(id){
        var person = live[id], where = person.tab ? tabTitle(person.tab) : '';
        return '<button type="button" class="mia-space-person' + (s.follow === id ? ' following' : '') + (person.away ? ' away' : '') + '" data-space-follow="' + esc(id) +
          '" title="' + (person.away ? esc(person.name) + ' is away · ' : '') + (s.follow === id ? 'Stop following ' : 'Follow ') + esc(person.name) + (where ? ' · on ' + esc(where) : '') + '">' + chip({name: person.name}, 'tone', ' style="background:' + tone(id) + '"') + '</button>';
      }).join('');
      html = '<button type="button" class="mia-space-btn" data-space-back><span aria-hidden="true">←</span> Back to Mia</button>' +
        '<span class="mia-space-call-title"><i class="mia-space-live-dot" aria-hidden="true"></i><span class="mia-space-call-name">In a call: ' + esc(s.space.name) + '</span><b class="mia-space-clock">' + clockText() + '</b></span>' +
        '<span class="mia-space-faces">' + faces + '</span><span class="mia-space-call-follow-slot"></span>' +
        '<span class="mia-space-call-actions"><button type="button" class="mia-space-btn" data-space-invite>Invite</button>' +
        '<button type="button" class="mia-space-btn icon" data-space-more aria-label="More" title="More">⋯</button>' +
        '<button type="button" class="mia-space-btn leave" data-space-leave>Leave</button></span>' + callMenuHtml();
    }
    [callBar, bar].forEach(function(el){ if(el.style && el.style.setProperty) el.style.setProperty('--mia-call-color', callColor()); });
    if(html.replace(/mia-space-clock">[^<]*/, '') !== paintedCall){
      paintedCall = html.replace(/mia-space-clock">[^<]*/, '');
      callBar.innerHTML = html;
      placeFollow();
    }
    callBar.hidden = false;
  }
  function ring(ids){
    ids.forEach(function(id){ post({t: 'ring', to: id}); s.invited[id] = true; });
    sendSpace();
    renderCall();
  }
  function renderSpace(){
    var self = me(), live = model.livePresence(s.presence, Date.now()), here = myPresence();
    var mine = self ? {id: self.id, name: self.name, tab: here.tab, bots: here.bots} : null;
    var tiles = model.tiles(shownSpace(), live, mine);
    var others = Object.keys(live).map(function(id){ return live[id]; });
    // One line per page waiting for a yes; the rest follow as these are answered.
    var waiting = s.approveEach ? model.pendingPages(s.space, s.links, s.ignored) : [];
    var approvals = waiting.slice(0, 3).map(function(tab){
      return '<div class="mia-space-invite"><span title="' + esc(tab.url) + '">Open <b>' + esc(model.hostOf(tab.url)) + '</b>' + (tab.title ? ' · ' + esc(tab.title) : '') + '?</span>' +
        '<span class="mia-space-choices"><button type="button" class="mia-space-btn primary" data-space-open="' + esc(tab.k) + '">Open</button>' +
        '<button type="button" class="mia-space-btn" data-space-ignore="' + esc(tab.k) + '">Ignore</button></span></div>';
    }).join('') + (waiting.length > 3 ? '<span class="mia-space-hint">' + (waiting.length - 3) + ' more waiting</span>' : '');
    var mapToggle = '<button type="button" class="mia-space-map-toggle" data-space-map="' + (s.mapHidden ? 'show' : 'hide') + '" aria-label="' + (s.mapHidden ? 'Show' : 'Hide') + ' minimap" title="' + (s.mapHidden ? 'Show' : 'Hide') + ' minimap" aria-expanded="' + !s.mapHidden + '">' + MAP_TOGGLE_ICON + '</button>';
    var map = s.mapHidden ? '<div class="mia-space-map-row collapsed">' + mapToggle + '</div>' : '<div class="mia-space-map-row"><div class="mia-space-map" role="list" aria-label="Minimap">' + tiles.map(function(tile){
      var presenter = s.follow && tile.people.some(function(person){ return person.id === s.follow; });
      var who = tile.people.filter(function(person){ return !person.me; }).map(function(person){ return person.name; }).concat(tile.bots.map(function(bot){ return bot.name + ' · ' + bot.owner; })).join(', ');
      return '<button type="button" role="listitem" class="mia-space-tile' + (tile.mine ? ' mine' : '') + (presenter ? ' presenter' : '') +
        '" data-space-tab="' + esc(tile.k) + '" title="' + esc(tile.title + (who ? ' · ' + who : '')) + '">' +
        '<span class="mia-space-tile-view"><img class="mia-space-frame" alt="" hidden><span class="mia-space-marks"></span></span>' +
        '<span class="mia-space-tile-label"><span class="mia-space-tile-title">' + esc(tile.title) + '</span><span class="mia-space-tile-check" aria-label="Done">✓</span></span></button>';
    }).join('') + '</div>' + mapToggle + '</div>';
    bar.hidden = !(approvals || map);
    paint(approvals + map);
    if(s.mesh) s.mesh.sync(others.map(function(person){ return person.id; }));
    syncLive();
  }

  function onClick(event){
    var target = event.target.closest('button');
    if(!target) return;
    if(target.hasAttribute('data-space-dismiss')){ s.notice = null; render(); }
    else if(target.hasAttribute('data-space-pick-cancel')){ s.sharePicking = null; render(); }
    else if(target.hasAttribute('data-space-map')){
      s.mapHidden = target.getAttribute('data-space-map') === 'hide';
      writeStored(MAP_KEY, s.mapHidden ? true : null);
      s.callMenu = null;
      render();
    }
    else if(target.hasAttribute('data-space-share')) share();
    // Joining someone else's session: warn first, nothing opens until they choose.
    else if(target.hasAttribute('data-space-join')){ s.confirming = target.getAttribute('data-space-join'); render(); }
    else if(target.hasAttribute('data-space-allow')) join(target.getAttribute('data-space-allow'), false);
    else if(target.hasAttribute('data-space-approve')) join(target.getAttribute('data-space-approve'), true);
    else if(target.hasAttribute('data-space-decline')) declineInvite(target.getAttribute('data-space-decline'));
    else if(target.hasAttribute('data-space-open')) openPage(target.getAttribute('data-space-open'));
    else if(target.hasAttribute('data-space-ignore')){ s.ignored[target.getAttribute('data-space-ignore')] = true; render(); }
    else if(target.hasAttribute('data-space-leave')) leave(false);
    else if(target.hasAttribute('data-space-look')){ s.callMenu = null; lookHere(); renderCall(); }
    else if(target.hasAttribute('data-space-invite')){ s.callMenu = s.callMenu === 'invite' ? null : 'invite'; renderCall(); }
    else if(target.hasAttribute('data-space-more')){ s.callMenu = s.callMenu === 'more' ? null : 'more'; renderCall(); }
    else if(target.hasAttribute('data-space-ring')) ring([target.getAttribute('data-space-ring')]);
    else if(target.hasAttribute('data-space-ring-all')) ring(invitePeople().filter(function(person){ return !person.here; }).map(function(person){ return person.id; }));
    else if(target.hasAttribute('data-space-return')) enterRoom();
    else if(target.hasAttribute('data-space-back')){ var back = host(); if(back && back.leaveRoom) back.leaveRoom(); }
    else if(target.hasAttribute('data-space-follow')) followPerson(target.getAttribute('data-space-follow'));
    else if(target.hasAttribute('data-space-tab')){
      var tab = s.space && s.space.tabs.filter(function(item){ return item.k === target.getAttribute('data-space-tab'); })[0];
      s.follow = null;
      if(tab) goTo(tab.k, '');
      sendPresence(true); render();
    }
  }
  bar.addEventListener('click', onClick);
  if(callBar) callBar.addEventListener('click', onClick);
  // The Invite and More lists close like any menu. A click on the page itself
  // never reaches this window, it only takes the focus away.
  function closeCallMenu(){ if(s.callMenu){ s.callMenu = null; renderCall(); } }
  if(callBar && document.addEventListener){
    // Before the bar redraws, while the clicked button is still inside it.
    document.addEventListener('click', function(event){ if(!callBar.contains(event.target)) closeCallMenu(); }, true);
    document.addEventListener('keydown', function(event){ if(event.key === 'Escape') closeCallMenu(); });
    window.addEventListener('blur', closeCallMenu);
  }
  if(chatInvites) chatInvites.addEventListener('click', onClick);
  if(inviteBtn) inviteBtn.addEventListener('click', inviteFromToolbar);
  bar.addEventListener('change', function(event){
    if(event.target.hasAttribute('data-space-channel')) s.shareChannelId = event.target.value;
  });
  setInterval(function(){
    var clock = callBar && callBar.querySelector('.mia-space-clock');
    if(clock && bound()) clock.textContent = clockText();
  }, 1000);
  // Any way out of the browser or back into it, not only the bar's buttons.
  if(window.MutationObserver) new MutationObserver(syncZoom).observe(document.body, {attributes: true, attributeFilter: ['class']});
  setInterval(render, 3000);
  setInterval(tickFrames, FRAME_MS);
  setInterval(tickPointers, POINTER_MS);
  bridge.onState(onBrowser);
  command('state').then(function(state){ if(state && state.tabs) onBrowser(state); }).catch(function(){});
  window.MiaSpaceUI = {receive: receive, render: render,
    isSharedGroup: function(groupId){ return bound() && !!groupId && s.groupId === groupId; },
    // The group this computer's tab strip narrows to while in a session.
    sessionGroup: function(){ return bound() ? s.groupId || '' : null; },
    startInChannel: startInChannel,
    inChannel: function(channelId){ return bound() && s.channelId === channelId; },
    // The toolbar line for a tab in this session; null on any other tab.
    activity: function(tab){
      if(!bound() || !tab || tab.groupId !== s.groupId) return null;
      var line = toolbarLine();
      if(!line) return null;
      return {lead: line.lead, rest: line.rest, canFollow: !!workerToFollow() || !!s.follow, following: !!s.follow};
    },
    // Everyone you could follow, for the picker beside the Follow switch.
    followPeople: function(){
      if(!bound()) return [];
      return othersHere().map(function(person){
        var tab = s.presence[person.id].tab;
        return {id: person.id, name: person.name, where: tab ? tabTitle(tab) : '', color: tone(person.id), following: s.follow === person.id};
      });
    },
    followPerson: function(id){ if(bound()) followPerson(id); },
    followWorker: function(){
      var id = s.follow || workerToFollow();
      if(id) followPerson(id);
    }};
})();
