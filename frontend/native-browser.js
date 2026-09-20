/* Native desktop browser UI. Page rendering stays outside the Mia renderer. */
(function () {
  'use strict';
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
  if (tabsRow) tabsRow.insertBefore(strip, tabsRow.firstChild);
  else overlay.querySelector('.local-browser-toolbar').before(strip);
  // Tier 2 "browser apps": quick-launch chips for web equivalents of
  // desktop apps this machine actually has installed (macos/src/detected-
  // web-apps.cjs). Only ever populated when the desktop bridge exposes
  // detectedApps (native Electron shell); a web build has no `bridge` at
  // all (see the guard at the top of this file) so the row never renders.
  var emptyState = document.getElementById('localBrowserEmpty');
  var quickApps = document.createElement('div');
  quickApps.className = 'native-browser-quick-apps'; quickApps.hidden = true;
  if (emptyState) emptyState.append(quickApps);
  function renderQuickApps(apps) {
    if (!emptyState || !apps || !apps.length) return;
    quickApps.replaceChildren();
    apps.forEach(function (app) {
      var chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'native-browser-quick-app'; chip.textContent = app.name;
      chip.onclick = function () { window.miaNativeBrowser.openTab(app.url); };
      quickApps.append(chip);
    });
    quickApps.hidden = false;
  }
  if (bridge.detectedApps) {
    bridge.detectedApps().then(function (result) { renderQuickApps(result && result.apps); }).catch(function () {});
  }
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
  var state = { tabs: [], activeId: null };
  // The Files app (frontend/files.html) is served by the same backend as
  // the rest of Mia, so it opens same-origin, same-session, no external URL.
  var FILES_APP_URL = window.location.origin + '/files.html';
  function filesTabOpen() {
    return state.tabs.find(function (t) { return t.url && t.url.indexOf(FILES_APP_URL) === 0; });
  }
  function openFilesTab() {
    var existing = filesTabOpen();
    if (existing) return command('select', { id: existing.id });
    return command('new').then(function () { return command('navigate', { value: FILES_APP_URL }); });
  }
  var open = false;
  var scheduled = false;
  var lastLayout = '';
  var lastTabs = '';
  input.placeholder = 'Search or enter a web address';
  input.setAttribute('aria-label', 'Search or web address');
  function selected() { return state.tabs.find(function (tab) { return tab.id === state.activeId; }); }
  function developerModeEnabled() { return document.documentElement.getAttribute('data-theme') === 'developer'; }
  function closeFind() { findBar.hidden = true; command('find', { value: '' }); layout(); }
  function focusLocation() { input.focus(); input.select(); }
  function command(action, extra) {
    return bridge.command(Object.assign({ action: action }, extra)).then(function (next) {
      if (next && next.error) { status.textContent = next.error; input.setAttribute('aria-invalid', 'true'); }
      else if (next && next.tabs) render(next);
      return next;
    }).catch(function () { status.textContent = 'Browser unavailable'; });
  }
  function layout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      var rect = screen.getBoundingClientRect();
      // Native views sit above HTML; hide them while the sidebar drawer covers it.
      var visible = open && !overlay.hidden && !document.body.classList.contains('browser-sidebar-open');
      var payload = { action: 'layout', visible: visible, panelOpen: open,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      var key = JSON.stringify(payload);
      if (key !== lastLayout) { lastLayout = key; bridge.command(payload).catch(function () {}); }
    });
  }
  function render(next) {
    var changedTab = state.activeId !== next.activeId;
    state = next;
    var tab = selected();
    var url = tab && tab.url || '';
    if (changedTab || document.activeElement !== input) input.value = url;
    if (changedTab) { findBar.hidden = true; findResult.textContent = ''; }
    input.setAttribute('aria-invalid', tab && tab.error ? 'true' : 'false');
    document.getElementById('localBrowserBackBtn').disabled = !tab || !tab.canGoBack;
    document.getElementById('localBrowserForwardBtn').disabled = !tab || !tab.canGoForward;
    var reload = document.getElementById('localBrowserReloadBtn');
    reload.disabled = !url;
    reload.textContent = tab && tab.loading ? '\u00d7' : '\u21bb';
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
    foot.textContent = parts.join(' \u00b7 ') || 'Native browser \u00b7 Mia is available on the right';
    if (state.download) foot.textContent += ' \u00b7 ' + state.download;
    var signature = JSON.stringify([state.activeId, state.tabs.map(function (t) { return [t.id, t.title, t.favicon, t.url]; })]);
    if (signature !== lastTabs) {
      lastTabs = signature;
      strip.replaceChildren();
      var filesTab = filesTabOpen();
      var filesGroup = document.createElement('div');
      filesGroup.className = 'native-browser-tab native-browser-tab-pinned' + (filesTab && filesTab.id === state.activeId ? ' active' : '');
      var filesButton = document.createElement('button');
      filesButton.type = 'button'; filesButton.title = 'Files';
      filesButton.setAttribute('role', 'tab');
      filesButton.setAttribute('aria-selected', String(!!(filesTab && filesTab.id === state.activeId)));
      var filesGlyph = document.createElement('span');
      filesGlyph.className = 'native-browser-tab-glyph'; filesGlyph.textContent = '📁'; filesGlyph.setAttribute('aria-hidden', 'true');
      var filesLabel = document.createElement('span');
      filesLabel.className = 'native-browser-tab-label'; filesLabel.textContent = 'Files';
      filesButton.append(filesGlyph, filesLabel);
      filesButton.onclick = openFilesTab;
      filesGroup.append(filesButton);
      strip.append(filesGroup);
      state.tabs.forEach(function (t) {
        // The pinned Files button above already represents this tab.
        if (t.url && t.url.indexOf(FILES_APP_URL) === 0) return;
        var group = document.createElement('div');
        group.className = 'native-browser-tab' + (t.id === state.activeId ? ' active' : '');
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
        button.onclick = function () { command('select', { id: t.id }); };
        var close = document.createElement('button');
        close.type = 'button'; close.textContent = '\u00d7'; close.className = 'native-browser-tab-close';
        close.setAttribute('aria-label', 'Close tab ' + button.textContent);
        close.onclick = function () { command('close', { id: t.id }); };
        group.append(button, close); strip.append(group);
      });
      var add = document.createElement('button');
      add.type = 'button'; add.textContent = '+'; add.className = 'native-browser-new-tab';
      add.setAttribute('aria-label', 'New browser tab');
      add.onclick = function () { command('new').then(focusLocation); };
      strip.append(add);
    }
    layout();
  }
  new ResizeObserver(layout).observe(screen);
  new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function syncNativeTheme() {
    render(state);
    return command('theme', { dark: developerModeEnabled() });
  }
  new MutationObserver(syncNativeTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', layout);
  bridge.onState(render);
  bridge.onFocus(focusLocation);
  if (bridge.onLayoutRequest) bridge.onLayoutRequest(function () { lastLayout = ''; layout(); });
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
    navigate: function (value) { input.blur(); command('navigate', { value: value }); return true; },
    openTab: function (value) {
      input.blur();
      return command('new').then(function () { return command('navigate', { value: value }); });
    },
    action: function (action) {
      command(action === 'reload' && selected() && selected().loading ? 'stop' : action);
    },
    menuAction: function (key) {
      if (key === 't') command('new').then(focusLocation);
      else if (key === 'l') focusLocation();
    },
  };
  syncNativeTheme().then(function () { return command('state'); });
})();
