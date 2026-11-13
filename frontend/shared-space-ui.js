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
  var FRAME_MS = 1000, IDLE_FRAME_EVERY = 5, FRAME_WIDTH = 360, POINTER_MS = 250, POINTER_FRESH_MS = 15000, VIEW_RESEND_MS = 2000, MAX_FRAME_CHARS = 200000;
  var pageHead = document.getElementById('miaSpacePageHead');
  // In the chat beside the browser: the call controls, and invitations for this person.
  var callBar = document.getElementById('miaSpaceCall'), chatInvites = document.getElementById('miaSpaceChatInvites');
  var inviteBtn = document.getElementById('localBrowserInviteBtn');
  // Switching workspace reloads this page, so the session lives in storage:
  // coming back within this long puts you back in it without asking again.
  var MAP_TOGGLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6l5 5 5-5M7 13l5 5 5-5"/></svg>';
  var MAP_KEY = 'miaSharedMapHidden', SESSION_KEY = 'miaSharedSession', LEFTOVERS_KEY = 'miaSharedLeftoverGroups', RESUME_MS = 3600000;

  var s = {space:null, teamKey:null, channelId:null, groupId:null, links:{}, presence:{}, participants:{}, invites:{},
    follow:null, browser:null, pendingOpens:0, sent:{}, timers:{}, shareChannelId:null, ended:{}, notice:null,
    confirming:null, approveEach:false, approved:{}, approving:{}, ignored:{}, joined:false, resumeChecked:false, dismissed:{}, rung:{}, invited:{}, callMenu:null, joinedAt:0,
    sharePicking:null, activeAt:0, aloneSince:0, ending:null, endingCard:null, zoomed:false, covered:false, mapHidden:false, mesh:null, frames:{}, pointers:{}, botPoints:{}, worked:{}, done:{}, lastBot:{}, frameBusy:false, frameTick:0, cursorSig:'', cursorTab:null, pillSig:'', sendQueue:null, joinReady:false,
    talk: window.MiaSpaceTalk ? window.MiaSpaceTalk.createTranscript() : null, listener:null, listening:false, listenStarting:false,
    ideas: window.MiaSpaceTalk ? window.MiaSpaceTalk.createIdeas() : null, suggester:null};

  function key(){ return Array.from(crypto.getRandomValues(new Uint8Array(8)), function(b){ return b.toString(16).padStart(2, '0'); }).join(''); }
  function esc(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){ return '&#' + ch.charCodeAt(0) + ';'; }); }
  function me(){ var h = host(); return h && h.me(); }
  function teamKey(){ var h = host(); return h ? h.teamKey() : null; }
  function bound(){ return !!(s.space && s.teamKey && s.teamKey === teamKey()); }
  // Every shared-space command names the company on screen; the browser
  // refuses it unless its own tabs are that company's.
  function command(action, extra){
    var key = teamKey();
    return bridge.command(Object.assign({action: action}, extra || {}, key ? {workspace: key} : {}));
  }
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
      follow: s.follow, approveEach: s.approveEach, approved: s.approved, ignored: s.ignored, joined: s.joined, user: me().id, at: Date.now(), activeAt: s.activeAt});
  }
  function resumeSession(){
    var team = teamKey(), self = me();
    if(s.resumeChecked || s.space || !team || !self) return;
    s.resumeChecked = true;
    var saved = readStored(SESSION_KEY);
    if(!saved || saved.teamKey !== team) return;
    if(saved.user !== self.id || !saved.space || Date.now() - Number(saved.at || 0) >= RESUME_MS){ writeStored(SESSION_KEY, null); return; }
    // One left unused (Mia closed, or open with nobody at it) ends instead of coming back.
    if(!model.resumable(saved, Date.now())){
      writeStored(SESSION_KEY, null);
      toast('Your shared browser session ended because it wasn\'t used for a while.');
      return;
    }
    start(saved.channelId, saved.space, saved.groupId || null, saved.links);
    if(saved.activeAt) s.activeAt = Number(saved.activeAt);
    enterRoom();
    s.follow = saved.follow || null; s.approveEach = !!saved.approveEach; s.ignored = saved.ignored || {}; s.joined = !!saved.joined;
    s.approved = saved.approved || {};
    if(s.approveEach && !saved.approved) Object.keys(s.links).forEach(function(k){
      var local = s.browser && s.browser.tabs.filter(function(tab){ return tab.id === s.links[k]; })[0];
      if(local) s.approved[k] = model.shareableUrl(local.url);
    });
    announceJoin();
  }

  // ---- Sending -------------------------------------------------------------
  function post(message){
    var h = host(), self = me();
    if(!h || !self || !s.channelId || !s.space) return Promise.resolve(false);
    var payload = Object.assign({space: s.space.id, at: Date.now()}, message);
    var channelId = s.channelId, body = model.encode(payload);
    // Preserve Join -> presence -> Leave order even when requests finish at
    // different speeds. Otherwise an old Join could arrive after Leave.
    function send(){
      try { return Promise.resolve(h.send(channelId, body)).then(function(){ return true; }, function(){ return false; }); }
      catch(_sendError) { return Promise.resolve(false); }
    }
    var result = s.sendQueue ? s.sendQueue.then(send) : send();
    s.sendQueue = result.then(function(){}, function(){});
    return result;
  }
  // Each kind of update goes out at most this often; the latest one wins.
  function later(kind, delay, fn){
    clearTimeout(s.timers[kind]);
    s.timers[kind] = setTimeout(fn, delay);
  }
  function sendSpace(){ return bound() ? post({t: 'space', name: s.space.name, rev: s.space.rev, startedAt: s.space.startedAt, host: s.space.host,
    tabs: s.space.tabs.map(function(tab){ return {k:tab.k,url:tab.url}; })}) : Promise.resolve(false); }
  // Hub records this authenticated user's Join message in the channel. A
  // presence ping or a WebRTC offer alone never grants access to live pages.
  function announceJoin(){
    if(!bound()) return Promise.resolve(false);
    var spaceId = s.space.id;
    return post({t: 'join'}).then(function(sent){
      if(sent && bound() && s.space.id === spaceId){ s.joinReady = true; sendPresence(true); }
      return sent;
    });
  }
  function myPresence(){
    var state = s.browser, linksByLocal = {};
    Object.keys(s.links).forEach(function(k){ linksByLocal[s.links[k]] = k; });
    var active = state && state.tabs.filter(function(tab){ return tab.active; })[0];
    var bots = [];
    (state ? state.tabs : []).forEach(function(tab){
      if(tab.botActivity && linksByLocal[tab.id]) bots.push({tab: linksByLocal[tab.id], name: tab.botActivity.name || (tab.botActivity.mia ? 'Mia' : 'Bot'), mia: !!tab.botActivity.mia});
    });
    return {t: 'here', tab: active && linksByLocal[active.id] || null, url: active ? model.shareableUrl(active.url) : '', follow: s.follow, away: !inRoom(), listen: s.listening, bots: bots};
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
    if(!bound() || !s.joinReady) return;
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
        var next = model.localTabList(s.space, s.links, groupTabs(), key, s.approveEach, s.approved, s.approving);
        if(s.approveEach) groupTabs().forEach(function(tab){
          var k = Object.keys(next.links).filter(function(item){ return next.links[item] === tab.id; })[0];
          var url = model.shareableUrl(tab.url);
          if(k && url && (!s.approving[k] || s.approving[k] === url) && s.approved[k] !== url) s.approved[k] = url;
          if(k && s.approving[k] === url) delete s.approving[k];
        });
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
    return command('spaceOpenTab', {url: tab.url, groupId: s.groupId, name: callName(s.channelId, s.space.name), activate: activate}).then(function(result){
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
    if(row.author_type !== 'user' || typeof row.author_id !== 'string' || !row.author_id) return;
    message.from = {id: row.author_id, name: row.author_name || row.author_email || message.from && message.from.name || 'Colleague'};
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
    if(bound() && message.space === s.space.id && channelId === s.channelId){
      if(message.t === 'join'){
        if(message.to && (!me() || message.to !== me().id)) return;
        var firstJoin = !s.participants[message.from.id];
        s.participants[message.from.id] = true;
        if(firstJoin) post({t: 'join', to: message.from.id}).then(function(){
          if(bound() && s.participants[message.from.id]){ sendSpace(); sendPresence(true); }
        });
        render();
        return;
      }
      if(!s.participants[message.from.id]) return;
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
        if(message.t === 'leave'){
          delete s.participants[message.from.id];
          if(s.follow === message.from.id) s.follow = hostToFollow();
        }
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
      var text = 'An admin ended ' + callName(s.channelId, s.space.name) + ' for everyone. Your tabs stay open on this computer.';
      s.notice = {text: text, at: Date.now()};
      leave(false);
      toast(text);
    }
    render();
  }
  // A private chat is called something different on each computer, so its call
  // takes the name this person knows it by rather than the host's.
  function callName(channelId, name){
    var channel = (host() ? host().channels() : []).filter(function(item){ return item.id === channelId; })[0];
    return channel && channel.private ? channel.name : name;
  }
  function tabTitle(tabKey){
    var tab = s.space && shownSpace().tabs.filter(function(item){ return item.k === tabKey; })[0];
    return tab ? tab.title || model.hostOf(tab.url) : '';
  }

  // ---- Ending an unused session -------------------------------------------
  // Someone really using the session: the page's pointer moving or scrolling,
  // or a click, key or scroll in Mia. Being followed to a new page is not.
  function touch(){
    if(!bound()) return;
    s.activeAt = Date.now();
    if(s.ending && s.ending.kind === 'idle') closeEnding();
  }
  function closeEnding(){
    s.ending = null;
    if(s.endingCard){ s.endingCard.remove(); s.endingCard = null; }
  }
  function othersInSession(){
    var self = me(), live = model.livePresence(s.presence, Date.now());
    return Object.keys(live).filter(function(id){ return !self || id !== self.id; }).length;
  }
  function endingText(){
    var seconds = Math.max(0, Math.ceil((s.ending.endsAt - Date.now()) / 1000));
    return s.ending.kind === 'idle'
      ? 'You haven\'t used the shared browser for ' + Math.round(model.IDLE_MS / 60000) + ' minutes. Leaving in ' + seconds + ' s.'
      : 'Nobody else has been in this session for ' + Math.round(model.ALONE_MS / 60000) + ' minutes. Ending in ' + seconds + ' s.';
  }
  // Asks like a video call does: a countdown, and one button to stay.
  function showEnding(due){
    s.ending = due;
    var overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay open mia-space-ending';
    overlay.setAttribute('role', 'presentation');
    var idle = due.kind === 'idle';
    overlay.innerHTML = '<div class="app-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="miaSpaceEndingTitle" aria-describedby="miaSpaceEndingText">'
      + '<div class="mia-space-ending-title" id="miaSpaceEndingTitle">' + (idle ? 'Are you still sharing?' : 'Nobody else is here') + '</div>'
      + '<div class="app-confirm-msg" id="miaSpaceEndingText"></div>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-ending="end">' + (idle ? 'Leave now' : 'End now') + '</button>'
      + '<button type="button" class="btn primary" data-ending="stay">' + (idle ? 'Keep sharing' : 'Extend ' + Math.round(model.EXTEND_MS / 60000) + ' min') + '</button></div></div>';
    overlay.querySelector('#miaSpaceEndingText').textContent = endingText();
    overlay.addEventListener('click', function(event){
      var button = event.target.closest('[data-ending]');
      if(!button) return;
      if(button.getAttribute('data-ending') === 'end') return endUnused();
      stay();
    });
    overlay.addEventListener('keydown', function(event){ if(event.key === 'Escape'){ event.preventDefault(); stay(); } });
    document.body.appendChild(overlay);
    s.endingCard = overlay;
    overlay.querySelector('[data-ending="stay"]').focus();
  }
  function stay(){
    var now = Date.now();
    if(s.ending && s.ending.kind === 'alone') s.aloneSince = now;
    s.activeAt = now;
    closeEnding();
    saveSession();
  }
  function endUnused(){
    var kind = s.ending && s.ending.kind, name = bound() ? callName(s.channelId, s.space.name) : 'the session';
    closeEnding();
    if(!bound()) return;
    leave(false);
    toast(kind === 'alone' ? 'Ended ' + name + ': nobody else was in it. Your tabs stay open.' : 'You left ' + name + '. Your tabs stay open.');
  }
  // Runs every second while a session is on this computer.
  function checkEnding(){
    if(!bound()){ closeEnding(); return; }
    var now = Date.now(), others = othersInSession();
    if(others) s.aloneSince = 0;
    else if(!s.aloneSince) s.aloneSince = now;
    if(s.ending){
      if(s.ending.kind === 'alone' && others) return closeEnding();
      if(now >= s.ending.endsAt) return endUnused();
      var text = s.endingCard && s.endingCard.querySelector('#miaSpaceEndingText');
      if(text) text.textContent = endingText();
      return;
    }
    var due = model.endingDue({activeAt: s.activeAt, aloneSince: s.aloneSince}, now);
    if(due) showEnding(due);
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
    s.presence = {}; s.participants = {}; s.follow = null; s.sent = {}; s.confirming = null; s.approveEach = false; s.approved = {}; s.approving = {}; s.ignored = {}; s.joined = false;
    s.sendQueue = null; s.joinReady = false;
    if(me()) s.participants[me().id] = true;
    s.sharePicking = null; s.invited = {}; s.callMenu = null; s.joinedAt = Date.now();
    s.activeAt = s.aloneSince = Date.now(); closeEnding();
    delete s.rung[space.id]; delete s.dismissed[space.id];
    command('spaceSession', {groupId: groupId}).catch(function(){});
    announce(true);
    startLive();
    clearInterval(s.timers.beat);
    s.timers.beat = setInterval(function(){
      if(!bound()) return;
      announce(true);
      s.presence = model.livePresence(s.presence, Date.now());
      announceJoin(); sendSpace(); render();
    }, HEARTBEAT_MS);
  }
  function share(){
    var group = selectedGroup(), self = me(), channelId = s.shareChannelId || defaultChannel();
    if(!group || !self || !channelId) return;
    var tabs = s.browser.tabs.filter(function(tab){ return tab.groupId === group.id; });
    var list = model.localTabList(null, {}, tabs, key);
    if(!list.tabs.length){ toast('Open a web page in this group first.'); return; }
    start(channelId, {id: key(), name: group.name || 'Shared tabs', rev: 1, by: self.id, host: self.id, startedAt: Date.now(), tabs: list.tabs}, group.id, list.links);
    list.tabs.forEach(function(tab){ s.approved[tab.k] = tab.url; });
    enterRoom();
    sendSpace().then(announceJoin); render();
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
      start(channelId, {id: key(), name: channel.name, rev: 1, by: self.id, host: self.id, startedAt: Date.now(), tabs: [{k: tabKey, url: START_PAGE, title: 'Google'}]}, result.groupId, links);
      s.approved[tabKey] = START_PAGE;
      enterRoom();
      sendSpace().then(announceJoin); render();
      s.callMenu = 'invite'; renderCall();
    }).catch(function(){ toast('Could not start the session. Try again.'); });
  }
  // The toolbar's Invite: inside a session it opens the people list, otherwise
  // it starts one from the page in front.
  function inviteFromToolbar(){
    if(bound()){ s.callMenu = 'invite'; renderCall(); return; }
    var state = s.browser, active = state && state.tabs.filter(function(tab){ return tab.active; })[0];
    var group = selectedGroup();
    if(active && active.private){ toast('This tab is private. Open a shared page to invite your company.'); return; }
    if(!active || !model.shareableUrl(active.url)){ toast('Open a web page first, then invite your company.'); return; }
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
    Object.keys(reuse.links).forEach(function(k){
      var local = s.browser && s.browser.tabs.filter(function(tab){ return tab.id === reuse.links[k]; })[0];
      if(local) s.approved[k] = model.shareableUrl(local.url);
    });
    enterRoom();
    s.follow = invite.space.host || invite.from.id;
    var reusedFirst = invite.space.tabs.filter(function(tab){ return tab.url && reuse.links[tab.k]; })[0];
    if(reusedFirst) command('select', {id: reuse.links[reusedFirst.k]}).catch(function(){});
    if(approveEach){
      s.approveEach = true;
      announceJoin(); render();
      return;
    }
    s.pendingOpens++;
    var first = invite.space.tabs.filter(function(tab){ return tab.url && !reuse.links[tab.k]; });
    first.reduce(function(chain, tab, index){
      return chain.then(function(){ return openLinked(tab, index === 0 && !reusedFirst); });
    }, Promise.resolve()).then(function(){
      s.pendingOpens--;
      if(!s.space) return render();
      announceJoin(); render();
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
    var same = groupId && s.browser && s.browser.groups.some(function(group){ return group.id === groupId && group.name === callName(invite.channelId, invite.space.name); });
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
    closeEnding();
    announce(false);
    clearInterval(s.timers.beat);
    stopLive();
    s.space = null; s.groupId = null; s.links = {}; s.presence = {}; s.participants = {}; s.follow = null;
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
    if(!tab || !tab.url) return;
    var spaceId = s.space.id, target = tab.url, id = s.links[tab.k];
    if(id){
      var local = s.browser && s.browser.tabs.filter(function(item){ return item.id === id; })[0];
      s.approving[tab.k] = target;
      command('select', {id: id}).then(function(){
        if(!bound() || s.space.id !== spaceId || !s.space.tabs.some(function(item){ return item.k === tab.k && item.url === target; })) return false;
        if(local && model.shareableUrl(local.url) === target) return true;
        return command('navigate', {value: target}).then(function(result){
          if(result && Array.isArray(result.tabs)) onBrowser(result);
          return true;
        });
      }).then(function(opened){
        if(!bound() || s.space.id !== spaceId) return;
        if(!opened) delete s.approving[tab.k];
        else if(local && model.shareableUrl(local.url) === target){ s.approved[tab.k] = target; delete s.approving[tab.k]; }
        if(opened) delete s.ignored[tab.k];
        sendPresence(true); render();
      }).catch(function(){ delete s.approving[tab.k]; toast('Could not open that page. Try again.'); });
      return;
    }
    openLinked(tab, true).then(function(){
      if(bound() && s.space.id === spaceId && s.links[tab.k]){ s.approved[tab.k] = target; delete s.ignored[tab.k]; sendPresence(true); }
      render();
    });
  }
  function lookHere(){
    var here = myPresence();
    if(!here.tab){ toast('Open one of the space’s tabs first.'); return; }
    post({t: 'look', tab: here.tab, url: here.url});
    toast('Everyone in the space is coming to this tab.');
  }
  // Everyone follows the host unless they choose someone else.
  function hostToFollow(){
    var hostId = s.space && s.space.host, self = me();
    return hostId && (!self || hostId !== self.id) && s.presence[hostId] ? hostId : null;
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
      signal: function(to, payload){ if(bound() && s.joinReady && s.participants[to]) post(Object.assign({t: 'rtc', to: to}, payload)); },
      onMessage: onLive,
      // Someone who connects late gets what this person has said so far.
      onOpen: function(id){
        if(s.talk && s.mesh) s.talk.by(self.id).slice(-200).forEach(function(line){ s.mesh.sendKept({t: 's', id: line.id, text: line.text, at: line.at}, id); });
        if(s.ideas && s.mesh) s.ideas.waiting(self.id).forEach(function(idea){ s.mesh.sendKept({t: 'g', id: idea.id, title: idea.title, ask: idea.ask, at: idea.at}, id); });
      }
    });
    if(s.mesh && s.ideas) s.suggester = window.MiaSpaceTalk.createSuggester({should: suggesting, ask: askForIdeas, onIdeas: propose});
  }
  function stopLive(){
    stopListening(true);
    if(s.talk) s.talk.clear();
    if(s.suggester) s.suggester.stop();
    s.suggester = null;
    if(s.ideas) s.ideas.clear();
    if(s.mesh) s.mesh.close();
    s.mesh = null; s.frames = {}; s.pointers = {}; s.botPoints = {}; s.worked = {}; s.done = {}; s.lastBot = {};
    s.cursorSig = ''; s.frameTick = 0; s.viewSig = ''; s.viewAt = 0;
    if(s.cursorTab){ command('spaceCursors', {id: s.cursorTab, cursors: []}).catch(function(){}); s.cursorTab = null; }
    if(pageHead){ pageHead.hidden = true; pageHead.textContent = ''; }
    syncToolbar();
  }
  function onLive(fromId, message){
    if(!bound() || !s.participants[fromId] || !s.presence[fromId] || !message) return;
    // The name comes from the connection the line arrived on, never from the line itself.
    if(message.t === 's'){
      heard(s.talk && s.talk.add({id: message.id, by: fromId, name: s.presence[fromId].name, text: message.text, at: message.at}));
      return;
    }
    if(message.t === 'g'){
      if(s.ideas && s.ideas.add({id: message.id, by: fromId, name: s.presence[fromId].name, title: message.title, ask: message.ask, at: message.at})) render();
      return;
    }
    if(message.t === 'ga'){
      if(s.ideas && typeof message.by === 'string' && typeof message.id === 'string' && s.ideas.take(message.by + '|' + message.id, {id: fromId, name: s.presence[fromId].name})) render();
      return;
    }
    if(typeof message.tab !== 'string') return;
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
      if(message.t === 'p') s.pointers[fromId].a = message.a;
      syncLive();
    } else if(message.t === 'v' && fromId === s.follow){
      followScroll(fromId, message);
    }
  }
  // ---- Transcript -----------------------------------------------------------
  // Each person turns listening on for themselves. Their own Mia writes down
  // what they say, on their computer, and sends only the words to the others.
  function stopListening(quiet){
    var was = s.listening || s.listenStarting;
    if(s.listener) s.listener.stop();
    s.listener = null; s.listening = false; s.listenStarting = false;
    if(was && !quiet){ sendPresence(true); render(); }
  }
  function said(text, at){
    var self = me();
    if(!bound() || !self || !s.listening) return;
    var line = s.talk.add({id: key(), by: self.id, name: self.name, text: text, at: at});
    if(!line) return;
    if(s.mesh) s.mesh.sendKept({t: 's', id: line.id, text: line.text, at: line.at});
    heard(line);
  }
  function heard(line){
    if(!line) return;
    if(s.suggester) s.suggester.heard(line);
    render();
  }
  // ---- Ideas ----------------------------------------------------------------
  // From what was said, Mia proposes things to do. Only one computer asks the
  // model, so a session gets one set of ideas: the first, by id, of the people
  // being written down.
  function suggesting(){
    var self = me(), h = host();
    if(!bound() || !self || !h || !h.suggest) return false;
    return listeners().map(function(person){ return person.id; }).sort()[0] === self.id;
  }
  function askForIdeas(){
    var self = me();
    return host().suggest(s.talk.lines().slice(-30).map(function(line){ return {name: self && line.by === self.id ? self.name : line.name, text: line.text}; }), s.ideas.titles());
  }
  function propose(list){
    var self = me();
    if(!bound() || !self) return;
    list.slice(0, 2).forEach(function(item){
      var idea = s.ideas.add({id: key(), by: self.id, name: self.name, title: item && item.title, ask: item && item.ask, at: Date.now()});
      if(idea && s.mesh) s.mesh.sendKept({t: 'g', id: idea.id, title: idea.title, ask: idea.ask, at: idea.at});
    });
    render();
  }
  // Taking an idea asks this person's own Mia to do it, and tells the others it is taken.
  function takeIdea(ideaKey){
    var self = me(), h = host();
    if(!bound() || !self || !h || !h.ask) return;
    var idea = s.ideas.take(ideaKey, {id: self.id, name: self.name});
    if(!idea) return render();
    if(s.mesh) s.mesh.sendKept({t: 'ga', by: idea.by, id: idea.id});
    render();
    h.ask(idea.ask);
  }
  function ideasHtml(){
    if(!s.ideas) return '';
    var self = me(), h = host(), mote = h && h.moteSrc ? h.moteSrc('Mia') : '';
    return s.ideas.open().map(function(idea){
      var taker = idea.taken && (self && idea.taken.id === self.id ? 'You asked Mia to do this' : idea.taken.name + ' asked Mia to do this');
      return '<div class="mia-space-slim mia-space-idea' + (taker ? ' taken' : '') + '">' + (mote ? '<img class="mia-space-idea-mote" alt="" src="' + esc(mote) + '">' : '') +
        '<span class="mia-space-text" title="' + esc(idea.ask) + '"><b>' + esc(idea.title) + '</b><span class="mia-space-hint">' + esc(taker || 'Mia suggests, from what was said') + '</span></span>' +
        (taker ? '' : '<span class="mia-space-choices"><button type="button" class="mia-space-btn primary" data-space-idea-do="' + esc(idea.key) + '">Do it</button>' +
          '<button type="button" class="mia-space-btn icon" data-space-idea-no="' + esc(idea.key) + '" aria-label="Dismiss" title="Dismiss">×</button></span>') + '</div>';
    }).join('');
  }
  function toggleListening(){
    if(s.listening || s.listenStarting) return stopListening();
    var speech = window.MiaSpeech, talk = window.MiaSpaceTalk, dictation = window.MiaDictation;
    var media = window.navigator && window.navigator.mediaDevices, Context = window.AudioContext || window.webkitAudioContext;
    if(!speech || !talk || !dictation || !media || !Context) return toast('Mia can\'t listen on this computer.');
    var spaceId = s.space.id;
    s.listenStarting = true;
    renderCall();
    speech.ready({
      confirm: function(text){ return window.confirm(text); },
      onDownloading: function(){ toast('Downloading the speech model… (one time, about 142 MB)'); }
    }).then(function(ok){
      if(!ok || !s.listenStarting || !bound() || s.space.id !== spaceId) return false;
      s.listener = talk.createListener({media: media, AudioContext: Context, onLine: said,
        toWav: function(samples, rate){ return dictation.toWav16k([samples], rate); },
        transcribe: speech.transcribe,
        onError: function(){ stopListening(); toast('Mia stopped listening: the words could not be written down.'); }});
      return s.listener.start().then(function(){ return true; });
    }).then(function(started){
      if(!started || !s.listenStarting){ if(!s.listening) stopListening(); return; }
      s.listenStarting = false; s.listening = true;
      sendPresence(true);
      toast('Mia is writing down what you say. Everyone in the session can read it, and Mia suggests what to do next.');
      render();
    }).catch(function(error){
      stopListening();
      var denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      toast(denied ? 'Microphone access is blocked. Allow Mia to use the microphone in your computer\'s privacy settings.' : (error && error.message) || 'Mia could not start listening.');
    });
  }
  function listeners(){
    var self = me(), live = model.livePresence(s.presence, Date.now());
    return (s.listening && self ? [{id: self.id, name: 'you'}] : []).concat(Object.keys(live).filter(function(id){ return live[id].listen && s.participants[id]; })
      .map(function(id){ return {id: id, name: live[id].name}; }));
  }
  function lineHtml(line, withTime){
    var self = me(), time = withTime ? '<time>' + esc(new Date(line.at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})) + '</time>' : '';
    return '<p class="mia-space-line">' + time + '<b style="color:' + tone(line.by) + '">' + esc(self && line.by === self.id ? 'You' : line.name) + '</b> ' + esc(line.text) + '</p>';
  }
  // The last few lines sit above the minimap; the whole transcript opens from there.
  function talkHtml(){
    if(!s.talk) return '';
    var lines = s.talk.lines(), who = listeners();
    if(!lines.length && !who.length) return '';
    var names = who.map(function(person){ return person.name; });
    var status = !names.length ? 'Nobody is being written down now' :
      'Mia is writing down what ' + (names.length > 2 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join(' and ')) + (names.length === 1 && names[0] !== 'you' ? ' says' : ' say');
    return '<div class="mia-space-talk"><div class="mia-space-talk-head"><span class="mia-space-hint">' + (names.length ? '<i class="mia-space-live-dot" aria-hidden="true"></i>' : '') + esc(status) + '</span>' +
      (lines.length ? '<button type="button" class="mia-space-btn" data-space-transcript>Transcript</button>' : '') + '</div>' +
      '<div class="mia-space-lines" role="log" aria-live="polite" aria-label="What was just said">' + lines.slice(-3).map(function(line){ return lineHtml(line); }).join('') + '</div></div>';
  }
  // Only the person you follow moves your page; everyone else's pointer just shows on it.
  function followScroll(fromId, message){
    var person = s.presence[fromId], self = me(), id = s.links[message.tab];
    var local = s.browser && s.browser.tabs.filter(function(tab){ return tab.id === id && tab.active; })[0];
    if(!s.zoomed || !local || !person || person.tab !== message.tab) return;
    // Two people following each other would push each other's pages around.
    if(self && person.follow === self.id) return;
    if(model.shareableUrl(local.url) !== person.url) return;
    command('spaceScroll', {id: id, view: {a: message.a, top: message.top === true}}).catch(function(){});
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
        var mine = s.pointers[me().id], spot = now.pointer && JSON.stringify(now.pointer.a);
        // Scrolling moves what the pointer is over, even when the mouse stays still.
        if(link.tab.active && now.pointer && (!mine || mine.stamp !== now.pointer.at || mine.spot !== spot)){
          if(mine) touch();
          s.pointers[me().id] = {k: link.k, x: now.pointer.x, y: now.pointer.y, a: now.pointer.a, at: Date.now(), stamp: now.pointer.at, spot: spot};
          if(s.mesh) s.mesh.send({t: 'p', tab: link.k, x: now.pointer.x, y: now.pointer.y, a: now.pointer.a});
        }
        if(link.tab.active && now.view) sendView(link.k, now.view);
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
  // Sent again now and then: these messages can be lost, and someone may start following at any time.
  function sendView(tabKey, view){
    var sig = tabKey + JSON.stringify(view), time = Date.now();
    if(!s.mesh || (sig === s.viewSig && time - s.viewAt < VIEW_RESEND_MS)) return;
    s.viewSig = sig; s.viewAt = time;
    s.mesh.send({t: 'v', tab: tabKey, a: view.a, top: view.top});
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
      var frame = model.pickFrame(tile, s.frames, self && self.id, now, s.follow), img = node.querySelector('.mia-space-frame');
      if(img && frame && img.getAttribute('src') !== frame.url){ img.src = frame.url; img.hidden = false; }
      // Nobody's view has arrived for a tab someone else is on: say so instead of an old picture.
      if(img && !frame && !img.hidden){ img.hidden = true; img.removeAttribute('src'); }
      node.classList.toggle('no-view', !frame && (tile.people.some(function(person){ return !self || person.id !== self.id; }) || tile.bots.length > 0));
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
        cursors.push({id: 'p' + id, label: person.name, x: point.x, y: point.y, a: point.a, color: tone(id)});
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
    var followed = s.follow && (s.presence[s.follow] ? s.presence[s.follow].name : 'colleague');
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
  var MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"></path></svg>';
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
      return '<div class="mia-space-invite' + (rung ? ' ringing' : '') + '"><span class="mia-space-live-dot" aria-hidden="true"></span><span class="mia-space-text"><b>' + esc(invite.from.name) + (rung ? ' invited you to browse together' : ' is browsing with the company') +
        '</b><span class="mia-space-hint">' + esc(callName(invite.channelId, invite.space.name)) + ' · ' + invite.space.tabs.length + ' tab' + (invite.space.tabs.length === 1 ? '' : 's') +
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
      html += '<div class="mia-space-invite"><span class="mia-space-icon">' + PEOPLE_ICON + '</span><span class="mia-space-text"><b>Browse ' + esc(group.name || 'this group') + ' with your company' +
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
    if(s.callMenu === 'transcript'){
      return '<div class="mia-space-call-menu transcript" role="dialog" aria-label="Transcript"><b>Transcript</b><span class="mia-space-hint">Written on each person\'s own computer. It is kept only while this session is open.</span>' +
        '<div class="mia-space-lines full">' + (s.talk ? s.talk.lines() : []).map(function(line){ return lineHtml(line, true); }).join('') + '</div></div>';
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
      html = '<button type="button" class="mia-space-call-return" data-space-return title="Return to ' + esc(callName(s.channelId, s.space.name)) + '"><i class="mia-space-live-dot" aria-hidden="true"></i>In a call <b class="mia-space-clock">' + clockText() + '</b><span aria-hidden="true">·</span> Return</button>';
    } else {
      callBar.className = 'mia-space-call';
      var self = me(), live = model.livePresence(s.presence, Date.now());
      var faces = (self ? chip({name: self.name}, 'me' + (s.listening ? ' listening' : '')) : '') + Object.keys(live).map(function(id){
        var person = live[id], where = person.tab ? tabTitle(person.tab) : '';
        return '<button type="button" class="mia-space-person' + (s.follow === id ? ' following' : '') + (person.away ? ' away' : '') + (person.listen ? ' listening' : '') + '" data-space-follow="' + esc(id) +
          '" title="' + (person.away ? esc(person.name) + ' is away · ' : '') + (s.follow === id ? 'Stop following ' : 'Follow ') + esc(person.name) + (where ? ' · on ' + esc(where) : '') + (person.listen ? ' · Mia is writing down what they say' : '') + '">' + chip({name: person.name}, 'tone', ' style="background:' + tone(id) + '"') + '</button>';
      }).join('');
      html = '<button type="button" class="mia-space-btn" data-space-back><span aria-hidden="true">←</span> Back to Mia</button>' +
        '<span class="mia-space-call-title"><i class="mia-space-live-dot" aria-hidden="true"></i><span class="mia-space-call-name">In a call: ' + esc(callName(s.channelId, s.space.name)) + '</span><b class="mia-space-clock">' + clockText() + '</b></span>' +
        '<span class="mia-space-faces">' + faces + '</span><span class="mia-space-call-follow-slot"></span>' +
        '<span class="mia-space-call-actions">' + (s.talk ? '<button type="button" class="mia-space-btn listen' + (s.listening ? ' on' : '') + '" data-space-listen aria-pressed="' + s.listening + '"' + (s.listenStarting ? ' disabled' : '') +
          ' title="' + (s.listening ? 'Stop writing down what you say' : 'Mia writes down what you say, on this computer. Everyone in the session can read it, and Mia suggests what to do next.') + '">' + MIC_ICON + (s.listening ? 'Mia is listening' : s.listenStarting ? 'Starting…' : 'Mia listens') + '</button>' : '') +
        '<button type="button" class="mia-space-btn" data-space-invite>Invite</button>' +
        '<button type="button" class="mia-space-btn icon" data-space-more aria-label="More" title="More">⋯</button>' +
        '<button type="button" class="mia-space-btn leave" data-space-leave>Leave</button></span>' + callMenuHtml();
    }
    [callBar, bar].forEach(function(el){ if(el.style && el.style.setProperty) el.style.setProperty('--mia-call-color', callColor()); });
    if(html.replace(/mia-space-clock">[^<]*/, '') !== paintedCall){
      paintedCall = html.replace(/mia-space-clock">[^<]*/, '');
      callBar.innerHTML = html;
      placeFollow();
      var transcript = callBar.querySelector('.mia-space-lines.full');
      if(transcript) transcript.scrollTop = transcript.scrollHeight;
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
    var others = Object.keys(live).filter(function(id){ return !!s.participants[id]; }).map(function(id){ return live[id]; });
    // One line per page waiting for a yes; the rest follow as these are answered.
    var waiting = s.approveEach ? model.pendingPages(s.space, s.links, s.ignored, s.approved) : [];
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
    paint(approvals + talkHtml() + ideasHtml() + map);
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
    else if(target.hasAttribute('data-space-ignore')){
      var ignoredKey = target.getAttribute('data-space-ignore');
      var ignoredTab = s.space && s.space.tabs.filter(function(tab){ return tab.k === ignoredKey; })[0];
      if(ignoredTab) s.ignored[ignoredKey] = ignoredTab.url;
      render();
    }
    else if(target.hasAttribute('data-space-leave')) leave(false);
    else if(target.hasAttribute('data-space-look')){ s.callMenu = null; lookHere(); renderCall(); }
    else if(target.hasAttribute('data-space-listen')) toggleListening();
    else if(target.hasAttribute('data-space-idea-do')) takeIdea(target.getAttribute('data-space-idea-do'));
    else if(target.hasAttribute('data-space-idea-no')){ s.ideas.dismiss(target.getAttribute('data-space-idea-no')); render(); }
    else if(target.hasAttribute('data-space-transcript')){
      // The same click has already closed an open menu; pressing the button again leaves it closed.
      var reopened = s.closedMenu && s.closedMenu.event === event && s.closedMenu.menu === 'transcript';
      s.callMenu = reopened ? null : 'transcript';
      renderCall();
    }
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
  function closeCallMenu(event){ if(s.callMenu){ s.closedMenu = {event: event, menu: s.callMenu}; s.callMenu = null; renderCall(); } }
  if(callBar && document.addEventListener){
    // Before the bar redraws, while the clicked button is still inside it.
    document.addEventListener('click', function(event){ if(!callBar.contains(event.target)) closeCallMenu(event); }, true);
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
    checkEnding();
  }, 1000);
  ['pointerdown', 'keydown', 'wheel'].forEach(function(type){
    document.addEventListener(type, function(event){
      if(!s.endingCard || !s.endingCard.contains(event.target)) touch();
    }, {capture: true, passive: true});
  });
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
        return {id: person.id, name: person.name, host: s.space.host === person.id, where: tab ? tabTitle(tab) : '', color: tone(person.id), following: s.follow === person.id};
      });
    },
    followPerson: function(id){ if(bound()) followPerson(id); },
    followWorker: function(){
      var id = s.follow || workerToFollow();
      if(id) followPerson(id);
    }};
})();
