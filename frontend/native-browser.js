/* Native desktop browser UI. Page rendering stays outside the Mia renderer. */
(function () {
  'use strict';
  // The Mac desktop window has no title bar, so the top row of the app
  // leaves room for the window buttons and works as the drag handle.
  if (window.miaDesktop && /Mac/i.test(navigator.platform || '')) document.documentElement.classList.add('mac-inset-titlebar');
  var bridge = window.miaDesktop && window.miaDesktop.browser;
  if (!bridge) return;
  var screen = document.getElementById('localBrowserScreen');
  var overlay = document.getElementById('localBrowserOverlay');
  if (!screen || !overlay) return;
  var input = document.getElementById('localBrowserUrl');
  var dot = document.getElementById('localBrowserDot');
  var status = document.getElementById('localBrowserStatus');
  var foot = overlay.querySelector('.local-browser-foot');
  var strip = document.createElement('div');
  strip.className = 'native-browser-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Browser tabs');
  // Tabs row also hosts the close-browser button (moved here from the
  // url-bar row so the window closes like a tab strip, not a toolbar).
  var tabsRow = document.getElementById('localBrowserTabsRow');
  // The mote (bots menu) button leads the row, then the tabs, then the
  // close button at the far right — like a browser profile button.
  if (tabsRow) tabsRow.insertBefore(strip, document.getElementById('localBrowserCloseBtn'));
  else overlay.querySelector('.local-browser-toolbar').before(strip);
  // New-tab button follows the last tab, like Chrome, and sticks to the
  // strip's edge once the tabs overflow so it is always in reach.
  var add = document.createElement('button');
  add.type = 'button'; add.className = 'native-browser-new-tab';
  add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
  add.title = 'New tab'; add.setAttribute('aria-label', 'New browser tab');
  add.onclick = function () { command('new').then(focusLocation); };
  strip.append(add);
  // » lists the groups a crowded strip had no room for. It sits outside the
  // scrolling strip so it is always in reach.
  var more = document.createElement('button');
  more.type = 'button'; more.className = 'native-browser-groups-more'; more.hidden = true;
  more.textContent = '\u00bb';
  more.onclick = function () { command('groupOverflowMenu', { groupIds: (more.groupIds || []).slice() }); };
  strip.after(more);
  var findBar = document.createElement('div');
  findBar.className = 'native-browser-find'; findBar.hidden = true;
  var findInput = document.createElement('input');
  findInput.type = 'search'; findInput.placeholder = 'Find in page'; findInput.setAttribute('aria-label', 'Find in page');
  var findResult = document.createElement('span');
  findResult.setAttribute('aria-live', 'polite');
  findBar.append(findInput, findResult);
  [['Previous match', '\u2191', false], ['Next match', '\u2193', true], ['Close find', '\u00d7', null]].forEach(function (item) {
    var button = document.createElement('button'); button.type = 'button';
    button.textContent = item[1]; button.setAttribute('aria-label', item[0]);
    button.onclick = function () {
      if (item[2] === null) closeFind();
      else command('find', { value: findInput.value, next: true, forward: item[2] });
    };
    findBar.append(button);
  });
  screen.before(findBar);
  // Mia's side pane: hide it for a full-width browser, or drag its left edge
  // to resize it. Both choices are remembered on this device.
  var MIA_PANE_KEY = 'mia.browser.miaPane';
  var MIA_PANE_MIN = 320;
  var miaToggle = document.getElementById('localBrowserMiaToggle');
  var miaPane = { width: null, collapsed: false };
  try { Object.assign(miaPane, JSON.parse(localStorage.getItem(MIA_PANE_KEY) || '{}')); } catch (_paneReadError) {}
  function miaPaneMax() { return Math.max(MIA_PANE_MIN, Math.min(720, Math.round(window.innerWidth * 0.6))); }
  function saveMiaPane() { try { localStorage.setItem(MIA_PANE_KEY, JSON.stringify(miaPane)); } catch (_paneWriteError) {} }
  function applyMiaPane() {
    if (miaPane.width) {
      miaPane.width = Math.min(miaPaneMax(), Math.max(MIA_PANE_MIN, miaPane.width));
      document.body.style.setProperty('--browser-mia-pane-width', miaPane.width + 'px');
    } else {
      document.body.style.removeProperty('--browser-mia-pane-width');
    }
    document.body.classList.toggle('browser-mia-collapsed', !!miaPane.collapsed);
    if (miaToggle) {
      var label = miaPane.collapsed ? 'Show Mia' : 'Hide Mia';
      miaToggle.title = label; miaToggle.setAttribute('aria-label', label);
      miaToggle.setAttribute('aria-pressed', String(!miaPane.collapsed));
    }
  }
  if (miaToggle) miaToggle.onclick = function () { miaPane.collapsed = !miaPane.collapsed; applyMiaPane(); saveMiaPane(); };
  var miaResize = document.createElement('div');
  miaResize.className = 'local-browser-mia-resize';
  miaResize.setAttribute('role', 'separator');
  miaResize.setAttribute('aria-orientation', 'vertical');
  miaResize.setAttribute('aria-label', 'Resize Mia panel');
  miaResize.title = 'Drag to resize. Double-click to reset.';
  document.body.append(miaResize);
  miaResize.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    miaResize.setPointerCapture(event.pointerId);
    document.body.classList.add('browser-mia-resizing');
    function move(e) {
      miaPane.width = window.innerWidth - e.clientX;
      applyMiaPane();
    }
    function end() {
      miaResize.removeEventListener('pointermove', move);
      miaResize.removeEventListener('pointerup', end);
      miaResize.removeEventListener('pointercancel', end);
      document.body.classList.remove('browser-mia-resizing');
      saveMiaPane();
    }
    miaResize.addEventListener('pointermove', move);
    miaResize.addEventListener('pointerup', end);
    miaResize.addEventListener('pointercancel', end);
  });
  miaResize.addEventListener('dblclick', function () { miaPane.width = null; applyMiaPane(); saveMiaPane(); });
  window.addEventListener('resize', function () { if (miaPane.width) applyMiaPane(); });
  applyMiaPane();
  var downloadsBtn = document.getElementById('localBrowserDownloadsBtn');
  var downloadsView = document.getElementById('localBrowserDownloads');
  var downloadsList = document.getElementById('localBrowserDownloadsList');
  var downloadsEmpty = document.getElementById('localBrowserDownloadsEmpty');
  var downloadsClear = document.getElementById('localBrowserDownloadsClear');
  var downloadsOpen = false;
  // The address-bar suggestions also drop over the page, so they get the
  // same still-of-the-page treatment as the Downloads menu.
  var suggestCovered = false;
  var lastDownloads = '';
  var state = { tabs: [], groups: [], activeId: null, downloads: [] };
  var editingGroupId = null;
  var pendingEditGroupId = null;
  var open = false;
  var scheduled = false;
  var lastLayout = '';
  var lastTabs = '';
  input.placeholder = 'Search or enter a web address';
  input.setAttribute('aria-label', 'Search or web address');
  var draggingTabId = null;
  function els(selector) { return Array.prototype.slice.call(strip.querySelectorAll(selector)); }
  function selected() { return state.tabs.find(function (tab) { return tab.id === state.activeId; }); }
  function developerModeEnabled() { return document.documentElement.getAttribute('data-theme') === 'developer'; }
  function closeFind() { findBar.hidden = true; command('find', { value: '' }); layout(); }
  function focusLocation() { input.focus(); input.select(); }
  var RELOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4"></path></svg>';
  var STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
  // Show the address without its scheme or "www." until the
  // field is focused; editing always starts from the full address.
  function displayUrl(url) {
    if (!/^https?:\/\//i.test(url)) return url;
    return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  }
  function showUrl(url) {
    var focused = document.activeElement === input;
    input.value = focused ? url : displayUrl(url);
    input.classList.toggle('is-display-url', !focused && input.value !== url);
  }
  input.addEventListener('focus', function () {
    var tab = selected();
    if (input.classList.contains('is-display-url') && tab && tab.url) { showUrl(tab.url); input.select(); }
  });
  input.addEventListener('blur', function () {
    var tab = selected();
    if (tab && tab.url && (input.value === tab.url || input.value === displayUrl(tab.url))) showUrl(tab.url);
  });
  function command(action, extra) {
    return bridge.command(Object.assign({ action: action }, extra)).then(function (next) {
      if (next && next.error) { status.textContent = next.error; input.setAttribute('aria-invalid', 'true'); }
      else if (next && next.tabs) render(next);
      return next;
    }).catch(function () { status.textContent = 'Browser unavailable'; });
  }
  // While a bot drives the tab in front, the toolbar says so and offers to
  // take over, which stops that bot's reply.
  var botControl = document.createElement('div');
  botControl.className = 'local-browser-bot-control'; botControl.hidden = true;
  botControl.setAttribute('role', 'status');
  var botControlLabel = document.createElement('span');
  var takeOver = document.createElement('button');
  takeOver.type = 'button'; takeOver.className = 'local-browser-take-over'; takeOver.textContent = 'Take over';
  botControl.append(botControlLabel, takeOver);
  var urlWrap = overlay.querySelector('.local-browser-url-wrap');
  if (urlWrap) urlWrap.after(botControl);
  takeOver.onclick = function () {
    var botId = botControl.getAttribute('data-bot-id');
    var agents = window.miaBrowserAgents;
    if (!botId || takeOver.disabled || !agents || !agents.takeOver) return;
    takeOver.disabled = true;
    takeOver.textContent = 'Stopping…';
    return Promise.resolve().then(function () { return agents.takeOver(botId); }).then(function (stopped) {
      if (stopped !== true) return;
      // Control stays with the bot until every cancellation is acknowledged.
      botReleasedAt[botId] = Date.now();
      Object.keys(botHolds).forEach(function (id) { if (botHolds[id].botId === botId) delete botHolds[id]; });
      render(state);
    }).catch(function () {
      botControlLabel.textContent = 'Could not stop. The bot may still be working.';
    }).finally(function () {
      takeOver.disabled = false;
      takeOver.textContent = 'Take over';
    });
  };
  // A tab stays marked from a bot's first command until that bot's reply
  // ends, so the marks don't blink off while it thinks between steps.
  var botHolds = {};
  var lastHeldKey = '';
  var lastHuesKey = '';
  // Tells main which pages stay lit through a running reply, and each bot's
  // color for the glow around the page it works on.
  function syncGlowHolds(working) {
    var agents = window.miaBrowserAgents;
    var hues = agents && agents.hues ? agents.hues() : {};
    var huesKey = JSON.stringify(hues);
    if (huesKey !== lastHuesKey) {
      lastHuesKey = huesKey;
      command('botColors', { hues: hues }).catch(function () {});
    }
    var heldKey = Object.keys(working).sort().join(',');
    if (heldKey !== lastHeldKey) {
      lastHeldKey = heldKey;
      command('botHeld', { ids: Object.keys(working).map(Number) }).catch(function () {});
    }
  }
  var botReleasedAt = {};
  var botHoldTimer = null;
  function botWorking(t) {
    var agents = window.miaBrowserAgents;
    var fresh = t.botActivity && !(Date.now() - (botReleasedAt[t.botActivity.botId] || 0) < 3000) ? t.botActivity : null;
    if (fresh) botHolds[t.id] = fresh;
    var hold = botHolds[t.id];
    if (!hold) return null;
    if (fresh) return hold;
    if (agents && agents.isRunning && agents.isRunning(hold.botId)) return hold;
    delete botHolds[t.id];
    return null;
  }
  function refreshBotHolds() {
    if (botHoldTimer) clearTimeout(botHoldTimer);
    botHoldTimer = null;
    if (!Object.keys(botHolds).length) return;
    // Recheck after the reply may have ended; render() reschedules.
    botHoldTimer = setTimeout(function () { render(state); }, 1000);
  }
  function renderBotControl(tab) {
    var activity = tab && botWorking(tab);
    botControl.hidden = !activity;

    if (!activity) { botControl.removeAttribute('data-bot-id'); return; }
    botControl.setAttribute('data-bot-id', activity.botId);
    var name = document.createElement('strong');
    name.textContent = activity.name || 'A bot';
    botControlLabel.replaceChildren(name, document.createTextNode(' has control'));
  }
  function layout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      var rect = screen.getBoundingClientRect();
      // Native views sit above HTML; hide them while the sidebar drawer covers it.
      var visible = open && !overlay.hidden && !downloadsOpen && !suggestCovered &&
        !document.body.classList.contains('browser-sidebar-open') &&
        !document.body.classList.contains('native-browser-occluded-about') &&
        !document.body.classList.contains('native-browser-occluded-conversation');
      var payload = { action: 'layout', visible: visible, panelOpen: open,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      // The Downloads menu sits over a still of the page, so the live view
      // steps aside without pausing what it plays.
      if (downloadsOpen || suggestCovered) payload.menu = true;
      var key = JSON.stringify(payload);
      if (key !== lastLayout) { lastLayout = key; bridge.command(payload).catch(function () {}); }
    });
  }
  function render(next) {
    var changedTab = state.activeId !== next.activeId;
    state = next;
    syncStillPage();
    var tab = selected();
    var url = tab && tab.url || '';
    if (changedTab || document.activeElement !== input) showUrl(url);
    if (changedTab) { findBar.hidden = true; findResult.textContent = ''; }
    input.setAttribute('aria-invalid', tab && tab.error ? 'true' : 'false');
    document.getElementById('localBrowserBackBtn').disabled = !tab || !tab.canGoBack;
    document.getElementById('localBrowserForwardBtn').disabled = !tab || !tab.canGoForward;
    var reload = document.getElementById('localBrowserReloadBtn');
    reload.disabled = !url;
    reload.innerHTML = tab && tab.loading ? STOP_ICON : RELOAD_ICON;
    overlay.setAttribute('data-loading', tab && tab.loading ? 'true' : 'false');
    reload.title = tab && tab.loading ? 'Stop loading' : 'Reload';
    reload.setAttribute('aria-label', reload.title);
    document.getElementById('localBrowserEmpty').hidden = !!url;
    var blocked = document.getElementById('localBrowserBlocked');
    blocked.hidden = !(tab && tab.error);
    if (tab && tab.error) {
      document.getElementById('localBrowserBlockedTitle').textContent = 'Could not load this page';
      document.getElementById('localBrowserBlockedMessage').textContent = tab.error;
      document.getElementById('localBrowserBlockedLink').hidden = true;
    }
    if (dot) {
      dot.setAttribute('data-status', tab && tab.loading ? 'loading' : tab && tab.error ? 'disconnected' : 'connected');
      dot.title = tab && tab.loading ? 'Loading\u2026' : tab && tab.error ? 'Load failed' : 'Connected';
    }
    var timing = tab && tab.timing;
    var parts = [];
    if (developerModeEnabled() && timing) {
      if (timing.fcp) parts.push('First paint ' + (timing.fcp / 1000).toFixed(2) + ' s');
      if (timing.dom) parts.push('DOM ready ' + (timing.dom / 1000).toFixed(2) + ' s');
      if (timing.load) parts.push('Page load ' + (timing.load / 1000).toFixed(2) + ' s');
    }
    // The status line only appears when it has something to say.
    if (state.download) parts.push(state.download);
    foot.textContent = parts.join(' \u00b7 ');
    foot.hidden = !parts.length;
    renderDownloads();
    if (window.MiaBrowserWork) window.MiaBrowserWork.updateBrowserState(state);
    var groups = {};
    (state.groups || []).forEach(function (g) { groups[g.id] = g; });
    var owners = (state.groups || []).map(function (g) {
      return window.miaBrowserAgents && g.botId ? window.miaBrowserAgents.name(g.botId) + '|' + window.miaBrowserAgents.moteHtml(g.botId) : '';
    });
    var working = {};
    state.tabs.forEach(function (t) { var w = botWorking(t); if (w) working[t.id] = w; });
    Object.keys(botHolds).forEach(function (id) { if (!state.tabs.some(function (t) { return String(t.id) === id; })) delete botHolds[id]; });
    renderBotControl(tab);
    refreshBotHolds();
    syncGlowHolds(working);
    var crowd = crowdedStrip(groups, working);
    var signature = JSON.stringify([state.activeId, state.groups, owners, crowd, setupGroupPending(groups[setupGroupId]) ? setupGroupId : null, state.tabs.map(function (t) { return [t.id, t.title, t.favicon, t.groupId, working[t.id] ? working[t.id].botId : '']; })]);
    // Redrawing mid-drag or mid-rename would drop what the user is doing;
    // catch up once it ends.
    if (signature !== lastTabs && draggingTabId === null && editingGroupId === null) {
      lastTabs = signature;
      strip.replaceChildren();
      var previousGroupId = null;
      state.tabs.forEach(function (t, index) {
        var tabGroup = groups[t.groupId] || null;
        if (tabGroup && crowd.hidden.indexOf(tabGroup.id) >= 0) return;
        var folded = tabGroup && crowd.folded.indexOf(tabGroup.id) >= 0;
        if (tabGroup && t.groupId !== previousGroupId) strip.append(groupHead(tabGroup, index, folded));
        previousGroupId = t.groupId || null;
        if (tabGroup && (tabGroup.collapsed || folded)) return;
        var group = document.createElement('div');
        group.setAttribute('data-tab-id', t.id);
        group.className = 'native-browser-tab' + (t.id === state.activeId ? ' active' : '') + (tabGroup ? ' in-group' : '') + (working[t.id] ? ' bot-working' : '');
        if (tabGroup) {
          paintGroup(group, tabGroup);
          // The active tab in a group is outlined in the group color, so the
          // group's line visibly runs around it.
          if (t.id === state.activeId) {
            var ring = document.createElement('span');
            ring.className = 'native-browser-tab-group-ring';
            group.append(ring);
          }
        }
        group.addEventListener('contextmenu', function (event) {
          event.preventDefault();
          command('tabMenu', { id: t.id });
        });
        // Drag a tab onto another to put it in that tab's place.
        group.setAttribute('data-tab-id', String(t.id));
        group.draggable = true;
        group.addEventListener('dragstart', function (event) {
          draggingTabId = t.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(t.id));
          group.classList.add('dragging');
        });
        group.addEventListener('dragend', function () {
          draggingTabId = null;
          if (state) render(state);
          group.classList.remove('dragging');
          els('.native-browser-tab.drop-target').forEach(function (node) { node.classList.remove('drop-target'); });
        });
        group.addEventListener('dragover', function (event) {
          if (draggingTabId === null || draggingTabId === t.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          group.classList.add('drop-target');
        });
        group.addEventListener('dragleave', function () { group.classList.remove('drop-target'); });
        group.addEventListener('drop', function (event) {
          event.preventDefault();
          group.classList.remove('drop-target');
          if (draggingTabId === null || draggingTabId === t.id) return;
          command('move', { id: draggingTabId, index: index, groupId: t.groupId || null });
        });
        var button = document.createElement('button');
        button.type = 'button'; button.title = t.title || 'New tab';
        button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(t.id === state.activeId));
        if (t.favicon) {
          var icon = document.createElement('img');
          icon.className = 'native-browser-tab-icon'; icon.src = t.favicon; icon.alt = '';
          icon.onerror = function () { icon.remove(); };
          button.append(icon);
        }
        var label = document.createElement('span');
        label.className = 'native-browser-tab-label'; label.textContent = t.title || 'New tab';
        button.append(label);
        // The same working dot the chat shows beside a busy bot.
        if (working[t.id]) {
          var dotEl = document.createElement('span');
          dotEl.className = 'chat-task-dot native-browser-tab-working';
          dotEl.title = (working[t.id].name || 'A bot') + ' is working here';
          button.append(dotEl);
        }
        button.onclick = function () { command('select', { id: t.id }); };
        var close = document.createElement('button');
        close.type = 'button'; close.textContent = '\u00d7'; close.className = 'native-browser-tab-close';
        close.setAttribute('aria-label', 'Close tab ' + button.textContent);
        close.onclick = function () { command('close', { id: t.id }); };
        group.append(button, close); strip.append(group);
      });
      strip.append(add);
      more.groupIds = crowd.hidden;
      more.hidden = !crowd.hidden.length;
      more.title = crowd.hidden.length + ' more group' + (crowd.hidden.length === 1 ? '' : 's');
      more.setAttribute('aria-label', 'Show ' + more.title);
    }
    // A bot that starts working in a tab off-screen brings it into view.
    Object.keys(working).forEach(function (id) {
      if (scrolledToWork[id]) return;
      scrolledToWork[id] = true;
      var node = strip.querySelector('[data-tab-id="' + id + '"]');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    Object.keys(scrolledToWork).forEach(function (id) { if (!working[id]) delete scrolledToWork[id]; });
    if (pendingEditGroupId && strip.querySelector('[data-group-id="' + pendingEditGroupId + '"]')) {
      var editId = pendingEditGroupId;
      pendingEditGroupId = null;
      editGroup(editId);
    }
    if (window.MiaBrowserWork) window.MiaBrowserWork.decorateTabs(strip, state);
    layout();
  }
  // A group opens with the bot that works in it, then the name chip. The
  // group's line starts under the bot and runs along its tabs.
  function groupHead(g, index, folded) {
    var head = document.createElement('span');
    head.className = 'native-browser-group-head' + (g.name ? '' : ' unnamed') + (g.collapsed || folded ? ' collapsed' : '');
    paintGroup(head, g);
    head.append(groupOwner(g), groupChip(g, index, folded));
    return head;
  }
  // When every tab would shrink past readable, idle groups fold to their
  // chip, least recently used first; the group in front and groups a bot is
  // working in stay open. If even the chips don't fit, the oldest go into
  // the » menu. Folding is only how the strip is drawn right now: it is not
  // saved, and groups open again when there is room.
  var TAB_MIN_WIDTH = 96, GROUP_HEAD_WIDTH = 118;
  var groupUsedAt = {};
  var scrolledToWork = {};
  function crowdedStrip(groups, working) {
    var now = Date.now();
    var active = state.tabs.filter(function (t) { return t.id === state.activeId; })[0];
    var busy = {};
    if (active && active.groupId) { busy[active.groupId] = true; groupUsedAt[active.groupId] = now; }
    state.tabs.forEach(function (t) { if (working[t.id] && t.groupId) { busy[t.groupId] = true; groupUsedAt[t.groupId] = now; } });
    var counts = {}, ungrouped = 0;
    state.tabs.forEach(function (t) { if (groups[t.groupId]) counts[t.groupId] = (counts[t.groupId] || 0) + 1; else ungrouped += 1; });
    var ids = Object.keys(counts);
    ids.forEach(function (id) { if (!groupUsedAt[id]) groupUsedAt[id] = 0; });
    var oldestFirst = ids.slice().sort(function (a, b) { return groupUsedAt[a] - groupUsedAt[b]; });
    var width = Math.max(0, (strip.clientWidth || 0) - (add.offsetWidth || 0));
    var folded = [], hidden = [];
    if (!width) return { folded: folded, hidden: hidden };
    var shown = function (id) { return groups[id].collapsed || folded.indexOf(id) >= 0 ? 0 : counts[id]; };
    var needed = function () {
      var total = ungrouped * TAB_MIN_WIDTH;
      ids.forEach(function (id) { if (hidden.indexOf(id) < 0) total += GROUP_HEAD_WIDTH + shown(id) * TAB_MIN_WIDTH; });
      return total;
    };
    oldestFirst.forEach(function (id) {
      if (needed() > width && !busy[id] && !groups[id].collapsed) folded.push(id);
    });
    oldestFirst.forEach(function (id) {
      if (needed() > width && !busy[id]) hidden.push(id);
    });
    return { folded: folded, hidden: hidden };
  }
  // A group's label sits before its tabs. Click collapses or expands it;
  // right-click opens the group menu; dropping a tab on it joins the group.
  function groupChip(g, index, folded) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'native-browser-group' + (g.name ? '' : ' unnamed') + (g.collapsed || folded ? ' collapsed' : '');
    paintGroup(chip, g);
    chip.setAttribute('data-group-id', g.id);
    chip.setAttribute('aria-expanded', String(!g.collapsed));
    chip.title = (g.name || 'Unnamed group') + (g.collapsed ? ' (collapsed)' : folded ? ' (folded to make room)' : '');
    chip.textContent = g.name;
    chip.onclick = function () {
      // A folded group opens by bringing its last tab to the front.
      var last = folded && state.tabs.filter(function (t) { return t.groupId === g.id; }).pop();
      if (last) command('select', { id: last.id });
      else command('groupUpdate', { groupId: g.id, collapsed: !g.collapsed });
    };
    chip.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      command('groupMenu', { groupId: g.id });
    });
    chip.addEventListener('dragover', function (event) {
      if (draggingTabId === null) return;
      event.preventDefault();
      chip.classList.add('drop-target');
    });
    chip.addEventListener('dragleave', function () { chip.classList.remove('drop-target'); });
    chip.addEventListener('drop', function (event) {
      event.preventDefault();
      chip.classList.remove('drop-target');
      if (draggingTabId !== null) command('move', { id: draggingTabId, index: index, groupId: g.id });
    });
    return chip;
  }
  // The group's owner leads its chip: the bot's mote, or Mia's
  // mark while Mia handles it. Click to choose the bot.
  function groupOwner(g) {
    var agents = window.miaBrowserAgents;
    var owner = document.createElement('button');
    owner.type = 'button';
    owner.className = 'native-browser-group-owner';
    paintGroup(owner, g);
    var settingUp = setupGroupPending(g);
    var name = settingUp ? 'New Bot' : agents && g.botId ? agents.name(g.botId) : '';
    var mote = settingUp ? agents.setupMoteHtml() : agents && g.botId ? agents.moteHtml(g.botId) : '';
    if (mote) owner.innerHTML = mote;
    else { owner.classList.add('mia'); owner.innerHTML = '<img src="assets/favicon.svg" alt="">'; }
    owner.title = name ? name + ' works in this group. Click to change.' : 'Mia works in this group. Click to choose a bot.';
    owner.setAttribute('aria-label', owner.title);
    owner.onclick = function (event) {
      event.stopPropagation();
      chooseGroupBot(g);
    };
    return owner;
  }
  // A group is drawn in its owner's color: the bot's own color, the New Bot
  // pink while "+ New bot" setup runs, and black while Mia handles it.
  var setupGroupId = null;
  function setupGroupPending(g) {
    var agents = window.miaBrowserAgents;
    return Boolean(g && g.id === setupGroupId && !g.botId && agents && agents.setupPending && agents.setupPending());
  }
  function paintGroup(node, g) {
    var agents = window.miaBrowserAgents;
    var color = setupGroupPending(g) ? agents.setupColor()
      : g.botId && agents && agents.groupColor ? agents.groupColor(g.botId) : '';
    node.setAttribute('data-group-color', color ? g.color : 'mia');
    if (color) node.style.setProperty('--tab-group-color', color);
    else node.style.removeProperty('--tab-group-color');
  }
  // "+ New bot" in a group's bot menu: a new tab in a new group, then the
  // "create a bot" chat, and the bot it creates takes that group.
  function newBotGroup() {
    var agents = window.miaBrowserAgents;
    if (!agents || !agents.startBotSetup) return;
    return command('new').then(function (next) {
      var tabId = next && next.activeId;
      if (!tabId) return;
      return command('groupCreate', { id: tabId, name: '' }).then(function (after) {
        var tab = after && (after.tabs || []).find(function (item) { return item.id === tabId; });
        var groupId = tab && tab.groupId;
        if (!groupId) return;
        setupGroupId = groupId;
        agents.startBotSetup(function (bot) {
          setupGroupId = null;
          command('groupAssignBot', { groupId: groupId, bot: bot });
        });
        render(state);
      });
    });
  }
  function chooseGroupBot(g) {
    var agents = window.miaBrowserAgents;
    var list = agents && agents.menuBots ? agents.menuBots() : Promise.resolve({ bots: agents ? agents.bots() : [] });
    var busy = agents && g.botId && agents.isRunning && agents.isRunning(g.botId)
      ? { botId: g.botId, name: agents.name(g.botId) } : null;
    list.catch(function () { return { bots: agents ? agents.bots() : [] }; }).then(function (menu) {
      command('groupBotMenu', { groupId: g.id, bots: menu.bots, miaIcon: menu.miaIcon || '', busy: busy });
    });
  }
  function editGroup(groupId) {
    var g = (state.groups || []).find(function (item) { return item.id === groupId; });
    var chip = strip.querySelector('[data-group-id="' + groupId + '"]');
    if (!g || !chip) return;
    editingGroupId = groupId;
    var field = document.createElement('input');
    field.type = 'text'; field.className = 'native-browser-group-name';
    field.value = g.name; field.maxLength = 80;
    field.placeholder = 'Name this group';
    field.setAttribute('aria-label', 'Group name');
    paintGroup(field, g);
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      editingGroupId = null;
      lastTabs = '';
      if (save) command('groupUpdate', { groupId: groupId, name: field.value });
      else render(state);
    }
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    field.addEventListener('blur', function () { finish(true); });
    chip.replaceWith(field);
    field.focus(); field.select();
  }
  function formatBytes(bytes) {
    if (!bytes) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var index = 0;
    while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
    return (index ? bytes.toFixed(1) : String(bytes)) + ' ' + units[index];
  }
  var downloadsSearch = document.getElementById('localBrowserDownloadsSearch');
  var DOWNLOAD_KINDS = {
    sheet: ['xlsx', 'xls', 'csv', 'numbers', 'ods'], doc: ['doc', 'docx', 'pages', 'rtf', 'txt', 'md', 'odt'],
    pdf: ['pdf'], slides: ['ppt', 'pptx', 'key', 'odp'], image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'],
    archive: ['zip', 'gz', 'tgz', 'rar', '7z', 'dmg', 'tar'], media: ['mp4', 'mov', 'mp3', 'wav', 'm4a', 'webm'],
  };
  function downloadKind(filename) {
    var ext = (String(filename || '').match(/\.([a-z0-9]{1,8})$/i) || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var kind = Object.keys(DOWNLOAD_KINDS).find(function (key) { return DOWNLOAD_KINDS[key].indexOf(ext) >= 0; });
    return { kind: kind || 'file', ext: ext.slice(0, 4) };
  }
  function downloadHost(item) {
    try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }
  function downloadMeta(item) {
    var parts = [];
    if (item.state === 'progressing') {
      parts.push(item.total ? formatBytes(item.received) + ' of ' + formatBytes(item.total) : formatBytes(item.received));
    } else if (item.state === 'completed') {
      if (!item.exists) parts.push('Moved or deleted');
      if (item.total || item.received) parts.push(formatBytes(item.total || item.received));
    } else {
      parts.push(item.state === 'cancelled' ? 'Cancelled' : 'Failed');
    }
    var host = downloadHost(item);
    if (host) parts.push(host);
    return parts.join(' · ');
  }
  function downloadDay(timestamp) {
    if (!timestamp) return 'Earlier';
    var day = new Date(timestamp); day.setHours(0, 0, 0, 0);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return day.toLocaleDateString(undefined, day.getFullYear() === today.getFullYear()
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  var DOWNLOAD_ICONS = {
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path>',
    copied: '<path d="m5 12.5 4.5 4.5L19 7.5"></path>',
    folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"></path>',
    remove: '<path d="M7 7l10 10M17 7 7 17"></path>',
  };
  function downloadIconButton(icon, label, onClick) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'local-browser-downloads-icon-btn';
    button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + DOWNLOAD_ICONS[icon] + '</svg>';
    button.onclick = onClick;
    return button;
  }
  function downloadRow(item) {
    var row = document.createElement('li');
    row.className = 'local-browser-download';
    row.setAttribute('data-state', item.state);
    var type = downloadKind(item.filename);
    var icon = document.createElement('span');
    icon.className = 'local-browser-download-icon';
    icon.setAttribute('data-kind', type.kind);
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type.ext || 'file';
    var text = document.createElement('div');
    text.className = 'local-browser-download-text';
    var safety = item.safety && item.safety.verdict;
    var openable = item.state === 'completed' && item.exists && safety !== 'blocked';
    var name = document.createElement(openable ? 'button' : 'span');
    name.className = 'local-browser-download-name' + (item.state === 'completed' && !item.exists ? ' missing' : '');
    name.textContent = item.filename; name.title = item.path || item.filename;
    if (openable) {
      name.type = 'button';
      name.setAttribute('aria-label', 'Open ' + item.filename);
      name.onclick = function () { command('downloadOpen', { id: item.id }); };
    }
    var meta = document.createElement('span');
    meta.className = 'local-browser-download-meta';
    meta.textContent = downloadMeta(item);
    text.append(name, meta);
    // The safety check on a finished file: a program, or a file that is not
    // what its name says, is flagged here before anyone opens it.
    if (item.exists && (safety === 'review' || safety === 'blocked')) {
      var warning = document.createElement('span');
      warning.className = 'local-browser-download-warning';
      warning.setAttribute('data-verdict', safety);
      warning.textContent = (safety === 'blocked' ? 'Blocked. ' : 'Check before opening. ') + (item.safety.reason || '');
      text.append(warning);
    }
    if (item.state === 'progressing') {
      var bar = document.createElement('span');
      bar.className = 'local-browser-download-progress';
      var fill = document.createElement('span');
      fill.style.width = item.total ? Math.min(100, Math.round(item.received / item.total * 100)) + '%' : '35%';
      if (!item.total) bar.classList.add('indeterminate');
      bar.append(fill);
      text.append(bar);
    }
    var actions = document.createElement('div');
    actions.className = 'local-browser-download-actions';
    if (item.url) {
      var copy = downloadIconButton('link', 'Copy download link', function () {
        Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(item.url)).then(function () {
          copy.querySelector('svg').innerHTML = DOWNLOAD_ICONS.copied;
          copy.title = 'Copied';
          setTimeout(function () { copy.querySelector('svg').innerHTML = DOWNLOAD_ICONS.link; copy.title = 'Copy download link'; }, 1200);
        }).catch(function () {});
      });
      actions.append(copy);
    }
    if (openable) actions.append(downloadIconButton('folder', 'Show in Finder', function () { command('downloadShow', { id: item.id }); }));
    actions.append(item.state === 'progressing'
      ? downloadIconButton('remove', 'Cancel download', function () { command('downloadCancel', { id: item.id }); })
      : downloadIconButton('remove', 'Remove from list', function () { command('downloadRemove', { id: item.id }); }));
    row.append(icon, text, actions);
    return row;
  }
  function renderDownloads() {
    var items = Array.isArray(state.downloads) ? state.downloads : [];
    downloadsBtn.setAttribute('data-active', String(items.some(function (item) { return item.state === 'progressing'; })));
    var query = downloadsSearch.value.trim().toLowerCase();
    var signature = JSON.stringify([items, query]);
    if (signature === lastDownloads) return;
    lastDownloads = signature;
    var shown = query ? items.filter(function (item) {
      return (String(item.filename || '') + ' ' + downloadHost(item)).toLowerCase().indexOf(query) >= 0;
    }) : items;
    downloadsList.replaceChildren();
    downloadsEmpty.hidden = shown.length > 0;
    downloadsEmpty.textContent = items.length ? 'No downloads match your search.' : "Files you download in Mia's browser appear here.";
    downloadsClear.disabled = !items.some(function (item) { return item.state !== 'progressing'; });
    var group = null;
    var label = '';
    shown.forEach(function (item) {
      var day = downloadDay(item.startedAt);
      if (!group || day !== label) {
        label = day;
        var heading = document.createElement('h3');
        heading.className = 'local-browser-downloads-day';
        heading.textContent = day;
        group = document.createElement('ul');
        group.className = 'local-browser-downloads-group';
        group.setAttribute('aria-label', day);
        downloadsList.append(heading, group);
      }
      group.append(downloadRow(item));
    });
  }
  var snapshot = document.getElementById('localBrowserSnapshot');
  var downloadsToken = 0;
  var snapshotTimer = null;
  function pageShowing() {
    var tab = selected();
    return Boolean(open && !overlay.hidden && tab && tab.url && !tab.error);
  }
  var stillGeneration = 0;
  var stillPage = '';
  var stillPending = null;
  var suggestRequested = false;
  var downloadsRequested = false;
  function stillPageKey() {
    var tab = selected();
    return JSON.stringify([open, overlay.hidden, tab && tab.id, tab && tab.url,
      tab && tab.loading, tab && tab.error, tab && tab.timing]);
  }
  function discardStill() {
    ++stillGeneration;
    stillPending = null;
    clearTimeout(snapshotTimer);
    snapshot.hidden = true;
    snapshot.removeAttribute('src');
  }
  function syncStillPage() {
    var key = stillPageKey();
    if (key === stillPage) return;
    stillPage = key;
    discardStill();
  }
  function showStill() {
    clearTimeout(snapshotTimer);
    syncStillPage();
    if (!snapshot.hidden && (suggestCovered || downloadsOpen)) return Promise.resolve(true);
    if (!suggestCovered && !downloadsOpen) { snapshot.hidden = true; snapshot.removeAttribute('src'); }
    if (stillPending) return stillPending;
    if (!pageShowing()) return Promise.resolve(true);
    var generation = stillGeneration;
    var key = stillPage;
    function current() {
      return generation === stillGeneration && key === stillPageKey() &&
        (suggestRequested || downloadsRequested);
    }
    var pending = command('snapshot').then(function (result) {
      if (!current()) return false;
      if (!result || !result.dataUrl) return true;
      // Decode away from the displayed image: a dismissed capture must not
      // mutate its source or become visible after a later page takes over.
      var image = new Image();
      image.src = result.dataUrl;
      return image.decode().then(function () {
        if (!current()) return false;
        snapshot.src = result.dataUrl;
        snapshot.hidden = false;
        return true;
      });
    }).catch(function () { return current(); });
    stillPending = pending;
    pending.then(function () { if (stillPending === pending) stillPending = null; });
    return pending;
  }
  function hideStill() {
    if (downloadsRequested || suggestRequested) return;
    // Invalidate capture/decode immediately, even before either menu has
    // committed its cover. Keep only an already visible still for the
    // native view's short return transition; a reopen always captures anew.
    ++stillGeneration;
    stillPending = null;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(function () {
      snapshot.hidden = true;
      snapshot.removeAttribute('src');
    }, 150);
  }
  var suggestToken = 0;
  function setSuggestCover(next) {
    var token = ++suggestToken;
    suggestRequested = next;
    if (!next) {
      suggestCovered = false;
      layout();
      hideStill();
      return;
    }
    if (suggestCovered) return;
    showStill().then(function (ready) {
      if (token !== suggestToken) return;
      if (!ready) { if (suggestRequested) setSuggestCover(true); return; }
      suggestCovered = true;
      layout();
    });
  }
  function setDownloadsOpen(next) {
    var token = ++downloadsToken;
    downloadsRequested = next;
    if (!next) {
      downloadsOpen = false;
      downloadsView.hidden = true;
      downloadsBtn.setAttribute('aria-expanded', 'false');
      if (downloadsSearch.value) downloadsSearch.value = '';
      layout();
      hideStill();
      return Promise.resolve();
    }
    return showStill().then(function (ready) {
      if (token !== downloadsToken) return;
      if (!ready) return downloadsRequested ? setDownloadsOpen(true) : undefined;
      var screenRect = screen.getBoundingClientRect();
      var buttonRect = downloadsBtn.getBoundingClientRect();
      downloadsView.style.setProperty('--downloads-right', Math.max(8, Math.round(screenRect.right - buttonRect.right)) + 'px');
      downloadsOpen = true;
      downloadsView.hidden = false;
      downloadsBtn.setAttribute('aria-expanded', 'true');
      lastDownloads = ''; renderDownloads();
      layout();
      downloadsSearch.focus({ preventScroll: true });
    });
  }
  // Like a menu: a click anywhere else closes it.
  document.addEventListener('mousedown', function (event) {
    if (!downloadsOpen || downloadsView.contains(event.target) || downloadsBtn.contains(event.target)) return;
    setDownloadsOpen(false);
  }, true);
  downloadsBtn.addEventListener('click', function () { setDownloadsOpen(!downloadsOpen); });
  document.getElementById('localBrowserDownloadsClose').addEventListener('click', function () { setDownloadsOpen(false); });
  downloadsClear.addEventListener('click', function () { command('downloadsClear'); });
  downloadsSearch.addEventListener('input', renderDownloads);
  downloadsView.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    setDownloadsOpen(false);
    downloadsBtn.focus({ preventScroll: true });
  });
  new ResizeObserver(layout).observe(screen);
  new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function syncNativeTheme() {
    render(state);
    return command('theme', { dark: developerModeEnabled() });
  }
  new MutationObserver(syncNativeTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', function () { layout(); if (state) render(state); });
  bridge.onState(render);
  window.addEventListener('mia-bots-changed', function () { render(state); });
  bridge.onFocus(focusLocation);
  if (bridge.onLayoutRequest) bridge.onLayoutRequest(function () { lastLayout = ''; layout(); });
  if (bridge.onGroupBot) bridge.onGroupBot(function (payload) {
    var agents = window.miaBrowserAgents;
    if (!payload) return;
    if (payload.action === 'stop' && agents && agents.stopQuietly) agents.stopQuietly(payload.botId);
    if (payload.action === 'new-bot') newBotGroup();
    // The person clicked into the page a bot is working on: take it over.
    if (payload.action === 'page-click') {
      var tab = selected();
      if (tab && tab.id === payload.tabId && !botControl.hidden && botControl.getAttribute('data-bot-id')) takeOver.onclick();
    }
    if (payload.action === 'choose') {
      var g = (state.groups || []).find(function (item) { return item.id === payload.groupId; });
      if (g) chooseGroupBot(g);
    }
  });
  if (bridge.onGroupEdit) bridge.onGroupEdit(function (payload) {
    // The new group's chip may arrive with the next state; render() retries.
    pendingEditGroupId = payload && payload.groupId || null;
    if (pendingEditGroupId) command('state');
  });
  bridge.onFind(function () { findBar.hidden = false; findInput.focus(); findInput.select(); layout(); });
  bridge.onFindResult(function (result) { findResult.textContent = result.activeMatchOrdinal + ' / ' + result.matches; });
  findInput.addEventListener('input', function () { command('find', { value: findInput.value }); });
  findInput.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeFind();
    if (event.key === 'Enter') { event.preventDefault(); command('find', { value: findInput.value, next: true, forward: !event.shiftKey }); }
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { input.value = selected() && selected().url || ''; input.blur(); }
  });
  window.miaNativeBrowser = {
    render: function (visible) {
      var opening = visible && !open;
      open = visible;
      if (!visible) {
        setSuggestCover(false);
        setDownloadsOpen(false);
        discardStill();
        // The native WebContentsView sits above the HTML renderer. Hiding the
        // overlay first can prevent a deferred animation-frame layout from
        // running, leaving the last browser pixels over chat. Hide the native
        // surface immediately and invalidate the cached layout for reopen.
        lastLayout = '';
        bridge.command({ action: 'layout', visible: false, panelOpen: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 } }).catch(function () {});
        return;
      }
      render(state);
      if (opening) {
        if (!state.tabs.length) command('new');
        if (!selected() || !selected().url) focusLocation();
      }
    },
    navigate: function (value) { input.blur(); setDownloadsOpen(false); command('navigate', { value: value }); return true; },
    openTab: function (value) {
      input.blur();
      return command('new').then(function () { return command('navigate', { value: value }); });
    },
    action: function (action) {
      command(action === 'reload' && selected() && selected().loading ? 'stop' : action);
    },
    // The page the user is looking at, for the chat to attach as context.
    // Only while the browser panel is open and showing a web page.
    currentPage: function () {
      var tab = open && selected();
      if (!tab || !/^https?:\/\//i.test(tab.url || '')) return null;
      return { url: tab.url, title: tab.title || '' };
    },
    // While address-bar suggestions are open, a still of the page stands in
    // for the live view so the list can draw over it.
    coverForSuggestions: function (covered) { setSuggestCover(covered === true); },
    menuAction: function (key) {
      if (key === 't') command('new').then(focusLocation);
      else if (key === 'l') focusLocation();
    },
  };
  syncNativeTheme().then(function () { return command('state'); });
})();
