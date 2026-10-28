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

  var s = {space:null, teamKey:null, channelId:null, groupId:null, links:{}, presence:{}, invites:{},
    follow:null, browser:null, pendingOpens:0, sent:{}, timers:{}, shareChannelId:null};

  function key(){ return Array.from(crypto.getRandomValues(new Uint8Array(8)), function(b){ return b.toString(16).padStart(2, '0'); }).join(''); }
  function esc(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){ return '&#' + ch.charCodeAt(0) + ';'; }); }
  function me(){ var h = host(); return h && h.me(); }
  function teamKey(){ var h = host(); return h ? h.teamKey() : null; }
  function bound(){ return !!(s.space && s.teamKey && s.teamKey === teamKey()); }
  function command(action, extra){ return bridge.command(Object.assign({action: action}, extra || {})); }

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
  function sendSpace(){ if(bound()) post({t: 'space', name: s.space.name, rev: s.space.rev, tabs: s.space.tabs}); }
  function myPresence(){
    var state = s.browser, linksByLocal = {};
    Object.keys(s.links).forEach(function(k){ linksByLocal[s.links[k]] = k; });
    var active = state && state.tabs.filter(function(tab){ return tab.active; })[0];
    var bots = [];
    (state ? state.tabs : []).forEach(function(tab){
      if(tab.botActivity && linksByLocal[tab.id]) bots.push({tab: linksByLocal[tab.id], name: tab.botActivity.name || (tab.botActivity.mia ? 'Mia' : 'Bot'), mia: !!tab.botActivity.mia});
    });
    return {t: 'here', tab: active && linksByLocal[active.id] || null, url: active ? model.shareableUrl(active.url) : '', follow: s.follow, bots: bots};
  }
  function sendPresence(force){
    if(!bound()) return;
    var here = myPresence(), sig = JSON.stringify(here);
    if(!force && sig === s.sent.here) return;
    s.sent.here = sig; post(here);
  }

  // ---- Browser -------------------------------------------------------------
  function groupTabs(){ return s.browser ? s.browser.tabs.filter(function(tab){ return tab.groupId === s.groupId; }) : []; }
  function onBrowser(state){
    s.browser = state;
    if(bound()){
      var groupGone = !state.groups.some(function(group){ return group.id === s.groupId; });
      if(groupGone && state.tabs.length && !s.pendingOpens){ leave(true); return render(); }
      if(!s.pendingOpens){
        // Tabs opened, closed or moved in this group change the space for everyone.
        var next = model.localTabList(s.space, s.links, groupTabs(), key);
        s.links = next.links;
        if(!model.sameTabs(s.space.tabs, next.tabs)){
          s.space = Object.assign({}, s.space, {tabs: next.tabs, rev: s.space.rev + 1, by: me().id});
          later('space', 600, sendSpace);
        }
      }
      later('here', 350, function(){ sendPresence(false); });
    }
    render();
  }
  function goTo(tabKey, url){
    var id = s.links[tabKey];
    if(!id) return Promise.resolve();
    var local = s.browser && s.browser.tabs.filter(function(tab){ return tab.id === id; })[0];
    return command('select', {id: id}).then(function(){
      if(url && local && model.shareableUrl(url) && local.url !== url) return command('navigate', {value: url});
    }).catch(function(){});
  }
  // Opens the tabs the space has and this computer lacks, in the background,
  // and closes the ones the space dropped.
  function applyRemoteTabs(){
    var plan = model.reconcile(s.space, s.links, s.browser ? s.browser.tabs : []);
    plan.close.forEach(function(id){ command('close', {id: id}).catch(function(){}); });
    plan.close.forEach(function(id){ Object.keys(s.links).forEach(function(k){ if(s.links[k] === id) delete s.links[k]; }); });
    return plan.open.reduce(function(chain, tab){
      return chain.then(function(){ return openLinked(tab, false); });
    }, Promise.resolve());
  }
  function openLinked(tab, activate){
    s.pendingOpens++;
    return command('spaceOpenTab', {url: tab.url, groupId: s.groupId, name: s.space.name, activate: activate}).then(function(result){
      if(result && result.openedId){ s.links[tab.k] = result.openedId; s.groupId = result.groupId || s.groupId; }
    }).catch(function(){}).then(function(){ s.pendingOpens--; });
  }

  // ---- Receiving -----------------------------------------------------------
  function receive(channelId, row){
    var message = model.decode(row && row.body);
    if(!message) return;
    message.from = {id: row.author_id, name: message.from && message.from.name || row.author_name || row.author_email || 'Teammate'};
    if(bound() && message.space === s.space.id){
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
        if(s.follow === message.from.id && now && (!before || before.tab !== now.tab || before.url !== now.url)) goTo(now.tab, now.url);
        if(message.t === 'leave' && s.follow === message.from.id) s.follow = null;
      }
    } else if(message.t === 'space' && !bound()){
      var invite = s.invites[message.space];
      s.invites[message.space] = {channelId: channelId, teamKey: teamKey(), from: message.from, space: model.applySpace(invite && invite.space, message), at: Date.now()};
    } else if(message.t === 'leave' && s.invites[message.space] && s.invites[message.space].from.id === message.from.id){
      delete s.invites[message.space];
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
  function start(channelId, space, groupId, links){
    s.space = space; s.teamKey = teamKey(); s.channelId = channelId; s.groupId = groupId; s.links = links || {};
    s.presence = {}; s.follow = null; s.sent = {};
    clearInterval(s.timers.beat);
    s.timers.beat = setInterval(function(){
      if(!bound()) return;
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
    start(channelId, {id: key(), name: group.name || 'Shared tabs', rev: 1, by: self.id, tabs: list.tabs}, group.id, list.links);
    sendSpace(); sendPresence(true); render();
  }
  function join(spaceId){
    var invite = s.invites[spaceId];
    if(!invite || !invite.space || !invite.space.tabs.length) return;
    delete s.invites[spaceId];
    start(invite.channelId, invite.space, null, {});
    s.pendingOpens++;
    var first = invite.space.tabs.filter(function(tab){ return tab.url; });
    first.reduce(function(chain, tab, index){
      return chain.then(function(){ return openLinked(tab, index === 0); });
    }, Promise.resolve()).then(function(){
      s.pendingOpens--;
      s.follow = invite.from.id;
      sendPresence(true); render();
    });
    render();
  }
  function leave(silent){
    if(s.space && !silent) post({t: 'leave'});
    clearInterval(s.timers.beat);
    s.space = null; s.groupId = null; s.links = {}; s.presence = {}; s.follow = null;
    render();
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
    if(s.follow && person) goTo(person.tab, person.url);
    sendPresence(true); render();
  }
  function defaultChannel(){
    var h = host(), channels = h ? h.channels() : [];
    var test = channels.filter(function(channel){ return /space-test/i.test(channel.name); })[0];
    return (test && test.id) || (h && h.activeChannelId()) || (channels[0] && channels[0].id) || null;
  }
  function toast(text){ var h = host(); if(h && h.toast) h.toast(text); }

  // ---- Rendering -----------------------------------------------------------
  var BOT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8" width="14" height="10" rx="3"></rect><path d="M12 4v4M9.5 13h.01M14.5 13h.01"></path></svg>';
  function chip(person, extraClass, attrs){
    return '<span class="mia-space-chip ' + (extraClass || '') + '" title="' + esc(person.name) + '"' + (attrs || '') + '>' + esc(person.initials || model.initials(person.name)) + '</span>';
  }
  function render(){
    var team = teamKey();
    var visibleInvites = Object.keys(s.invites).map(function(id){ return s.invites[id]; })
      .filter(function(invite){ return invite.teamKey === team && Date.now() - invite.at < 120000; });
    var group = selectedGroup();
    var show = !!team && (bound() || visibleInvites.length || group);
    bar.hidden = !show;
    if(!show){ paint(''); return; }
    if(bound()) return renderSpace();
    var html = '';
    visibleInvites.slice(0, 2).forEach(function(invite){
      html += '<div class="mia-space-invite"><span class="mia-space-icon">' + BOT_ICON + '</span><span><b>' + esc(invite.from.name) + '</b> is sharing <b>' +
        esc(invite.space.name) + '</b> · ' + invite.space.tabs.length + ' tab' + (invite.space.tabs.length === 1 ? '' : 's') +
        '</span><button type="button" class="mia-space-btn primary" data-space-join="' + esc(invite.space.id) + '">Join</button></div>';
    });
    if(group && !visibleInvites.length){
      var h = host(), channels = h ? h.channels() : [], chosen = s.shareChannelId || defaultChannel();
      var pages = s.browser.tabs.some(function(tab){ return tab.groupId === group.id && model.shareableUrl(tab.url); });
      if(!pages){ paint('<div class="mia-space-invite"><span class="mia-space-hint">Open a web page in <b>' + esc(group.name || 'this group') + '</b> to share it with your team.</span></div>'); return; }
      html += '<div class="mia-space-invite"><span>Work in <b>' + esc(group.name || 'this group') + '</b> together with your team in</span>' +
        '<select class="mia-space-select" data-space-channel aria-label="Channel to share with">' + channels.map(function(channel){
          return '<option value="' + esc(channel.id) + '"' + (channel.id === chosen ? ' selected' : '') + '>' + esc(channel.name) + '</option>';
        }).join('') + '</select><button type="button" class="mia-space-btn primary" data-space-share>Share group</button></div>';
    }
    paint(html);
  }
  var painted = null;
  function paint(html){ if(html !== painted){ painted = html; bar.innerHTML = html; } }
  function renderSpace(){
    var self = me(), live = model.livePresence(s.presence, Date.now()), here = myPresence();
    var mine = self ? {id: self.id, name: self.name, tab: here.tab, bots: here.bots} : null;
    var tiles = model.tiles(s.space, live, mine);
    var others = Object.keys(live).map(function(id){ return live[id]; });
    var followName = s.follow && live[s.follow] ? live[s.follow].name : '';
    var channel = (host() ? host().channels() : []).filter(function(item){ return item.id === s.channelId; })[0];
    paint(
      '<div class="mia-space-head"><span class="mia-space-title">' + esc(s.space.name) + '</span>' +
        '<span class="mia-space-sub">' + esc(channel ? channel.name : '') + '</span>' +
        '<span class="mia-space-people">' + (self ? chip({name: self.name}, 'me') : '') + others.map(function(person){
          return '<button type="button" class="mia-space-person' + (s.follow === person.id ? ' following' : '') + '" data-space-follow="' + esc(person.id) +
            '" title="' + (s.follow === person.id ? 'Stop following ' : 'Follow ') + esc(person.name) + '">' + chip({name: person.name}) + '</button>';
        }).join('') + '</span></div>' +
      '<div class="mia-space-map" role="list" aria-label="Minimap">' + tiles.map(function(tile){
        var presenter = s.follow && tile.people.some(function(person){ return person.id === s.follow; });
        return '<button type="button" role="listitem" class="mia-space-tile' + (tile.mine ? ' mine' : '') + (presenter ? ' presenter' : '') +
          (tile.bots.length ? ' working' : '') + '" data-space-tab="' + esc(tile.k) + '" title="' + esc(tile.title) + '">' +
          '<span class="mia-space-tile-title">' + esc(tile.title) + '</span><span class="mia-space-tile-dots">' +
          tile.people.map(function(person){ return chip(person, person.me ? 'me' : (person.id === s.follow ? 'lead' : '')); }).join('') +
          tile.bots.map(function(bot){ return '<span class="mia-space-bot" title="' + esc(bot.name + ' · ' + bot.owner) + '">' + BOT_ICON + '</span>'; }).join('') +
          '</span></button>';
      }).join('') + '</div>' +
      '<div class="mia-space-actions">' +
        (followName ? '<button type="button" class="mia-space-btn" data-space-follow="' + esc(s.follow) + '">Stop following ' + esc(followName.split(' ')[0]) + '</button>'
          : '<span class="mia-space-hint">' + (others.length ? 'Click a person to follow them' : 'Waiting for teammates') + '</span>') +
        '<button type="button" class="mia-space-btn" data-space-look>Everyone look here</button>' +
        '<button type="button" class="mia-space-btn" data-space-leave>Leave</button></div>');
  }

  bar.addEventListener('click', function(event){
    var target = event.target.closest('button');
    if(!target) return;
    if(target.hasAttribute('data-space-share')) share();
    else if(target.hasAttribute('data-space-join')) join(target.getAttribute('data-space-join'));
    else if(target.hasAttribute('data-space-leave')) leave(false);
    else if(target.hasAttribute('data-space-look')) lookHere();
    else if(target.hasAttribute('data-space-follow')) followPerson(target.getAttribute('data-space-follow'));
    else if(target.hasAttribute('data-space-tab')){
      var tab = s.space && s.space.tabs.filter(function(item){ return item.k === target.getAttribute('data-space-tab'); })[0];
      s.follow = null;
      if(tab) goTo(tab.k, '');
      sendPresence(true); render();
    }
  });
  bar.addEventListener('change', function(event){
    if(event.target.hasAttribute('data-space-channel')) s.shareChannelId = event.target.value;
  });
  window.addEventListener('beforeunload', function(){ if(s.space) post({t: 'leave'}); });
  setInterval(render, 3000);
  bridge.onState(onBrowser);
  command('state').then(function(state){ if(state && state.tabs) onBrowser(state); }).catch(function(){});
  window.MiaSpaceUI = {receive: receive, render: render};
})();
