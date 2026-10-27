// One tab strip for the browser and the chat: the same tab, hover, close
// button, middle-click close, right-click menu and drag to reorder. Each
// strip supplies its tabs and what selecting, closing and moving one does.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MiaTabStrip = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A tab's icon: its own image when it has one, else its type mark
  // (iconHtml), which also stands in if the image fails to load.
  function iconNode(t) {
    if (!t.iconUrl && !t.iconHtml) return null;
    var mark = document.createElement('span');
    mark.className = 'mia-tab-icon';
    if (!t.iconUrl) { mark.innerHTML = t.iconHtml; return mark; }
    var icon = document.createElement('img');
    icon.className = 'mia-tab-icon'; icon.src = t.iconUrl; icon.alt = '';
    icon.onerror = function () {
      if (t.iconHtml) { mark.innerHTML = t.iconHtml; icon.replaceWith(mark); } else icon.remove();
    };
    return icon;
  }
  // handlers: select(id), close(id), move(draggedId, targetTab, draggedTab),
  // menu(id, event) and dragEnd() — all but select are optional.
  function create(strip, handlers) {
    var dragging = null, draggingTab = null;
    var last = null;
    function clearTargets() {
      Array.prototype.forEach.call(strip.querySelectorAll('.mia-tab.drop-target'), function (node) { node.classList.remove('drop-target'); });
    }
    // t: { id, label, title, active, iconUrl or iconHtml, closable, className }
    function tab(t) {
      var label = t.label || 'New tab';
      var closable = t.closable !== false && !!handlers.close;
      var node = document.createElement('div');
      node.className = 'mia-tab' + (t.active ? ' active' : '') + (t.className ? ' ' + t.className : '');
      node.setAttribute('data-tab-id', String(t.id));
      node.draggable = true;
      node.addEventListener('dragstart', function (event) {
        dragging = t.id; draggingTab = t;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(t.id));
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', function () {
        dragging = null; draggingTab = null;
        node.classList.remove('dragging');
        clearTargets();
        // A redraw skipped mid-drag happens now.
        last = null;
        if (handlers.dragEnd) handlers.dragEnd();
      });
      node.addEventListener('dragover', function (event) {
        if (dragging === null || dragging === t.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        node.classList.add('drop-target');
      });
      node.addEventListener('dragleave', function () { node.classList.remove('drop-target'); });
      node.addEventListener('drop', function (event) {
        event.preventDefault();
        node.classList.remove('drop-target');
        if (dragging === null || dragging === t.id || !handlers.move) return;
        handlers.move(dragging, t, draggingTab);
      });
      if (handlers.menu) {
        node.addEventListener('contextmenu', function (event) {
          event.preventDefault();
          handlers.menu(t.id, event);
        });
      }
      if (closable) {
        node.addEventListener('auxclick', function (event) { if (event.button === 1) handlers.close(t.id); });
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.title = t.title || label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(!!t.active));
      var icon = iconNode(t);
      if (icon) button.append(icon);
      var text = document.createElement('span');
      text.className = 'mia-tab-label'; text.textContent = label;
      button.append(text);
      button.onclick = function () { handlers.select(t.id); };
      node.append(button);
      node.button = button;
      if (closable) {
        var close = document.createElement('button');
        close.type = 'button'; close.textContent = '×'; close.className = 'mia-tab-close';
        close.title = 'Close tab';
        close.setAttribute('aria-label', 'Close tab ' + label);
        close.onclick = function () { handlers.close(t.id); };
        node.append(close);
        node.closeButton = close;
      }
      return node;
    }
    // Redraw only when the tabs changed: replacing the row on every refresh
    // swaps the tab under the pointer and makes its hover flicker. A redraw
    // mid-drag waits for the drop.
    function redraw(signature, fill) {
      if (dragging !== null || signature === last) return false;
      last = signature;
      strip.replaceChildren();
      fill();
      return true;
    }
    return {
      tab: tab,
      redraw: redraw,
      reset: function () { last = null; },
      dragging: function () { return dragging; },
    };
  }
  // Mixed tabs: when on, every strip (chat, automations, browser) shows all
  // three views' tabs as one strip, in the order they were opened and as
  // dragged since, so it reads the same from any view; a tab from another
  // view opens that view at that tab. Each view registers
  // { tabs(), select(id), show(), render() }.
  var MIX_ORDER = ['chat', 'automations', 'browser'];
  var MIX_KEY = 'miaTabsMixed', ORDER_KEY = 'miaTabsMixOrder';
  var root = typeof window !== 'undefined' ? window : globalThis;
  var views = {};
  var mixed = false;
  // Remembered in the desktop app's state when there is one (it outlasts
  // the page's own storage there), else in local storage.
  function desktopState() { return root.miaDesktop && root.miaDesktop.state && typeof root.miaDesktop.state.get === 'function' ? root.miaDesktop.state : null; }
  try {
    var saved = desktopState() ? desktopState().get(MIX_KEY) : null;
    if (typeof saved !== 'string') saved = root.localStorage ? root.localStorage.getItem(MIX_KEY) : null;
    mixed = saved === '1';
  } catch (e) {}
  // The mixed order: one key per tab ("view:id"), oldest first.
  var order = [];
  try {
    var savedOrder = desktopState() ? desktopState().get(ORDER_KEY) : null;
    if (typeof savedOrder !== 'string') savedOrder = root.localStorage ? root.localStorage.getItem(ORDER_KEY) : null;
    order = savedOrder ? JSON.parse(savedOrder) : [];
    if (!Array.isArray(order)) order = [];
  } catch (e) { order = []; }
  function saveOrder() {
    var text = JSON.stringify(order);
    try { if (desktopState()) desktopState().set(ORDER_KEY, text); } catch (e) {}
    try { root.localStorage.setItem(ORDER_KEY, text); } catch (e) {}
  }
  function mixKey(view, id) { return view + ':' + String(id); }
  var mix = {
    on: function () { return mixed; },
    set: function (on) {
      mixed = !!on;
      try { if (desktopState()) desktopState().set(MIX_KEY, mixed ? '1' : '0'); } catch (e) {}
      try { root.localStorage.setItem(MIX_KEY, mixed ? '1' : '0'); } catch (e) {}
      if (typeof document !== 'undefined' && document.body) document.body.classList.toggle('tabs-mixed', mixed);
      mix.changed();
    },
    provider: function (view) { return views[view] || {}; },
    register: function (view, provider) { views[view] = Object.assign(views[view] || {}, provider); paintCounts(); },
    // How many tabs each view has open, for the badges on the view buttons.
  // A view whose strip holds a fixed page (the Automations board) counts
  // only its other tabs with count().
    counts: function () {
      var out = {};
      MIX_ORDER.forEach(function (view) {
        var provider = views[view] || {};
        try { out[view] = provider.count ? provider.count() : provider.tabs ? (provider.tabs() || []).length : 0; } catch (e) { out[view] = 0; }
      });
      return out;
    },
    changed: function () {
      MIX_ORDER.forEach(function (view) { if (views[view] && views[view].render) views[view].render(); });
    },
    // A view's own tabs changed. Every view's tabs are drawn by the
    // browser's strip, so it redraws. Only a real change notifies, so
    // redraws settle.
    notify: function (view, signature) {
      var provider = views[view] || (views[view] = {});
      if (provider.signature === signature) return;
      provider.signature = signature;
      paintCounts();
      // The browser's strip shows every view's tabs, so it redraws.
      if (view !== 'browser' && views.browser && views.browser.render) views.browser.render();
    },
    // Every tab to draw in this view's strip, in the mixed order: this
    // view's own tabs ({ own: true, tab }) and the other views' ({ view,
    // tab }). A tab not in the order yet was just opened, so it goes last.
    // A browser group's tabs stay together, where its first tab is, in the
    // browser's own order. When the other views' tabs need more than room
    // (the width this view's own tabs leave), the view with the most tabs
    // folds first into one head ({ head: true, section }), where its first
    // tab was; this view's own tabs never fold. Off, it is just the view's
    // own tabs.
    arrange: function (view, own, room) {
      var items = [];
      MIX_ORDER.forEach(function (v) {
        if (v !== view && !mixed) return;
        var tabs = v === view ? own : (views[v] && views[v].tabs ? views[v].tabs() || [] : []);
        tabs.forEach(function (t) { items.push({ own: v === view, view: v, key: mixKey(v, t.id), tab: t }); });
      });
      if (!mixed) return items;
      var byKey = {}, present = {};
      items.forEach(function (item) { byKey[item.key] = item; present[item.view] = true; });
      // A closed tab leaves the order, so reopening it puts it last; a view
      // with no tabs listed yet (still loading) keeps its place.
      var next = order.filter(function (key) { return byKey[key] || !present[key.slice(0, key.indexOf(':'))]; });
      items.forEach(function (item) { if (next.indexOf(item.key) < 0) next.push(item.key); });
      if (JSON.stringify(next) !== JSON.stringify(order)) { order = next; saveOrder(); }
      var grouped = {}, out = [];
      order.forEach(function (key) {
        var item = byKey[key];
        if (!item) return;
        var group = item.view === 'browser' && item.tab.groupId;
        if (!group) { out.push(item); return; }
        if (grouped[group]) return;
        grouped[group] = true;
        items.forEach(function (other) { if (other.view === 'browser' && other.tab.groupId === group) out.push(other); });
      });
      if (!(room > 0)) return out;
      var folded = {}, counts = {};
      out.forEach(function (item) { if (!item.own) counts[item.view] = (counts[item.view] || 0) + 1; });
      var needed = function () {
        var heads = {};
        return out.reduce(function (sum, item) {
          if (item.own) return sum;
          if (!folded[item.view]) return sum + TAB_WIDTH;
          if (heads[item.view]) return sum;
          heads[item.view] = true;
          return sum + HEAD_WIDTH;
        }, 0);
      };
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (v) { if (needed() > room) folded[v] = true; });
      var placed = {};
      return out.reduce(function (list, item) {
        if (!folded[item.view]) { list.push(item); return list; }
        if (placed[item.view]) return list;
        placed[item.view] = true;
        list.push({ head: true, view: item.view, key: 'head:' + item.view, section: { view: item.view, label: SECTIONS[item.view].label, iconHtml: SECTIONS[item.view].icon, folded: true,
          tabs: out.filter(function (other) { return other.view === item.view; }).map(function (other) { return Object.assign({}, other.tab, { view: item.view }); }) } });
        return list;
      }, []);
    },
    // Drag one tab onto another, from any view: it takes that tab's place.
    move: function (fromKey, toKey) {
      var from = order.indexOf(fromKey), to = order.indexOf(toKey);
      if (from < 0 || to < 0 || from === to) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      saveOrder();
      mix.changed();
    },
    // Opening a view with no tab named shows it as you left it.
    open: function (view, id) {
      var provider = views[view];
      if (!provider) return;
      closeMenu();
      if (provider.show) provider.show();
      if (id !== undefined && provider.select) provider.select(id);
    },
  };
  // The width a tab and a section head need to stay readable; the browser
  // folds its groups by the same measure.
  var TAB_WIDTH = 96, HEAD_WIDTH = 104;
  var SECTIONS = {
    chat: { label: 'Chats', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"></path></svg>' },
    automations: { label: 'Automations', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6h4"></path><circle cx="12" cy="12" r="10"></circle></svg>' },
    browser: { label: 'Browser', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>' },
  };
  // A chat or automation tab in the browser's strip. In its own view it is
  // that view's tab (active, closes, reorders); from another view it opens
  // its view there. Closing and moving go to its own view.
  // The count badge on each view button (Chat 2, Automations 3, ...).
  function paintCounts() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
    var counts = mix.counts();
    MIX_ORDER.forEach(function (view) {
      var button = document.querySelector('.sidebar-view-btn[data-sidebar-view="' + view + '"]');
      if (!button) return;
      var badge = button.querySelector('.sidebar-view-count');
      var count = counts[view] || 0;
      if (!count) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sidebar-view-count';
        badge.setAttribute('aria-hidden', 'true');
        button.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : String(count);
      button.setAttribute('aria-label', button.getAttribute('title') + ', ' + count + ' open');
    });
  }

  function foreignTab(strip, t) {
    var key = mixKey(t.view, t.id), provider = views[t.view] || {};
    var here = !!strip.host && strip.host() === t.view;
    var node = strip.tab({ id: key, mixKey: key, label: t.label, title: t.title, iconUrl: t.iconUrl, iconHtml: t.iconHtml,
      active: here && !!t.active, closable: !!provider.close && t.closable !== false, className: 'mix-foreign mix-' + t.view });
    node.button.onclick = function () {
      if (!here) mix.open(t.view, t.id);
      else if (t.active && provider.reselect) provider.reselect(t.id);
      else if (provider.select) provider.select(t.id);
    };
    return node;
  }
  // A folded section's tabs drop down from its head, drawn like a bot's
  // list in the browser. Picking one opens that view at that tab; the top
  // row opens the view as you left it. The view the strip belongs to may
  // need to cover what it shows first (the browser shows a still of its
  // page, since the live page draws over everything).
  var menu = null;
  function closeMenu() {
    if (!menu) return;
    var open = menu;
    menu = null;
    open.node.remove();
    open.head.setAttribute('aria-expanded', 'false');
    if (open.cover) open.cover(false);
  }
  function openMenu(head, section, hostView) {
    var again = menu && menu.view === section.view;
    closeMenu();
    if (again) return;
    var cover = views[hostView] && views[hostView].cover;
    // The browser's live page draws over any HTML; without a way to cover
    // it, the head opens the view instead, as before.
    if (hostView === 'browser' && !cover) { mix.open(section.view); return; }
    var node = document.createElement('div');
    node.className = 'native-browser-bot-tabs-list mia-mix-menu';
    var rows = document.createElement('div');
    rows.className = 'native-browser-bot-tabs-rows';
    rows.setAttribute('role', 'menu');
    var all = document.createElement('button');
    all.type = 'button'; all.setAttribute('role', 'menuitem');
    all.className = 'native-browser-bot-tabs-new';
    all.textContent = 'Open ' + section.label;
    all.onclick = function () { closeMenu(); mix.open(section.view); };
    rows.append(all);
    section.tabs.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'native-browser-bot-tabs-row';
      var button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.title = t.title || t.label;
      var icon = iconNode(t);
      if (icon) button.append(icon);
      var label = document.createElement('span');
      label.className = 'mia-tab-label'; label.textContent = t.label;
      button.append(label);
      button.onclick = function () { closeMenu(); mix.open(section.view, t.id); };
      row.append(button);
      rows.append(row);
    });
    node.append(rows);
    var rect = head.getBoundingClientRect();
    var width = Math.max(200, Math.round(rect.width));
    node.style.width = width + 'px';
    node.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))) + 'px';
    node.style.top = Math.round(rect.bottom - 2) + 'px';
    rows.style.maxHeight = Math.max(120, Math.round(window.innerHeight - rect.bottom - 12)) + 'px';
    var open = menu = { view: section.view, node: node, head: head, cover: cover };
    head.setAttribute('aria-expanded', 'true');
    Promise.resolve(cover ? cover(true) : true).then(function (ready) {
      if (menu !== open) return;
      if (ready === false) { closeMenu(); return; }
      document.body.append(node);
    });
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('mousedown', function (event) {
      if (!menu) return;
      // The strip may have redrawn its head since, so match the head by view.
      var onHead = event.target.closest && event.target.closest('.mia-mix-head.mix-' + menu.view);
      if (menu.node.contains(event.target) || onHead) return;
      closeMenu();
    }, true);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeMenu(); });
  }
  // An open section is just its tabs: their icons say which view they
  // belong to. A folded one is a head naming the view and counting the
  // tabs it stands in for; clicking it drops them down.
  function sectionNodes(strip, section, hostView) {
    if (!section.folded) return section.tabs.map(function (t) { return foreignTab(strip, t); });
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'mia-mix-head folded mix-' + section.view;
    head.title = section.label + ' \u00b7 ' + section.tabs.length + ' tab' + (section.tabs.length === 1 ? '' : 's');
    head.setAttribute('aria-label', 'Open ' + head.title);
    head.innerHTML = section.iconHtml;
    var label = document.createElement('span');
    label.className = 'mia-mix-head-label';
    label.textContent = section.label;
    head.append(label);
    var count = document.createElement('span');
    count.className = 'mia-mix-head-count';
    count.textContent = String(section.tabs.length);
    head.append(count);
    head.setAttribute('aria-haspopup', 'true');
    head.setAttribute('aria-expanded', String(!!menu && menu.view === section.view));
    head.onclick = function () { openMenu(head, section, hostView); };
    return [head];
  }
  // A head squeezed so far that only a letter or two of its name would
  // show drops the name and keeps its icon and count; a little shorter, the
  // name just ends in an ellipsis.
  var HEAD_LABEL_MIN = 28;
  // A browser group's head does the same: its name chip goes and the bot's
  // mote stands for the group.
  var HEADS = [['.mia-mix-head', '.mia-mix-head-label'], ['.native-browser-group-head:not(.unnamed)', '.native-browser-group']];
  function fitHeads(strip) {
    HEADS.forEach(function (kind) {
      var heads = strip.querySelectorAll(kind[0]);
      Array.prototype.forEach.call(heads, function (head) { head.classList.remove('icon-only'); });
      Array.prototype.forEach.call(heads, function (head) {
        var label = head.querySelector(kind[1]);
        if (label && label.scrollWidth > label.clientWidth + 1 && label.clientWidth < HEAD_LABEL_MIN) head.classList.add('icon-only');
      });
    });
  }
  function createWithMix(strip, handlers) {
    var api = create(strip, handlers);
    api.section = function (section) { return sectionNodes(api, section, api.host ? api.host() : handlers.view); };
    api.foreign = function (item) { return foreignTab(api, Object.assign({}, item.tab, { view: item.view })); };
    // Draw arrange()'s items, each own tab by the view's own drawing.
    api.place = function (items, ownNode) {
      items.forEach(function (item) {
        if (item.head) strip.append.apply(strip, api.section(item.section));
        else strip.append(item.own ? ownNode(item.tab) : api.foreign(item));
      });
    };
    // Room for the other views' sections: the strip's width less what this
    // view's own tabs need. A hidden strip has no width yet, so nothing
    // folds; it is drawn again once it shows.
    api.room = function (ownWidth) { return strip.clientWidth ? Math.max(1, strip.clientWidth - ownWidth) : 0; };
    api.TAB_WIDTH = TAB_WIDTH;
    if (!handlers.view) return api;
    var view = handlers.view;
    function provider() { return views[view] || (views[view] = {}); }
    // While mixed, a drag moves the tab in the mixed order; between two of
    // this view's own tabs it also moves it in the view's own order.
    // Another view's tab closes and reorders in that view.
    function routed(id) {
      var m = typeof id === 'string' && /^(chat|automations|browser):(.*)$/.exec(id);
      return m && m[1] !== view ? { view: m[1], id: m[2] } : null;
    }
    var ownClose = handlers.close, ownMenu = handlers.menu;
    handlers.close = function (id) {
      var r = routed(id);
      if (!r) { if (ownClose) ownClose(id); return; }
      if (views[r.view] && views[r.view].close) views[r.view].close(r.id);
    };
    if (ownMenu) handlers.menu = function (id, event) { if (!routed(id)) ownMenu(id, event); };
    var ownMove = handlers.move;
    handlers.move = function (id, target, dragged) {
      var from = routed(id), to = routed(target.id);
      if (from && to && from.view === to.view && views[from.view].move) views[from.view].move(from.id, to.id);
      if (!mixed) { if (!from && !to && ownMove) ownMove(id, target, dragged); return; }
      var draggedOwn = !(dragged && dragged.mixKey), targetOwn = !target.mixKey;
      if (draggedOwn && targetOwn && ownMove) ownMove(id, target, dragged);
      mix.move(draggedOwn ? mixKey(view, id) : dragged.mixKey, targetOwn ? mixKey(view, target.id) : target.mixKey);
    };
    // After drawing, fit the heads to what room they got.
    var redraw = api.redraw;
    api.redraw = function (signature, fill) {
      var drew = redraw(signature, fill);
      if (drew && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(function () { fitHeads(strip); });
      return drew;
    };
    // A strip that changes width may need to fold or open sections.
    if (typeof ResizeObserver !== 'undefined') {
      var width = 0;
      new ResizeObserver(function () {
        if (mixed && strip.clientWidth !== width) {
          width = strip.clientWidth;
          if (provider().render) provider().render();
        }
        fitHeads(strip);
      }).observe(strip);
    }
    return api;
  }
  if (typeof document !== 'undefined' && document.body && mixed) document.body.classList.add('tabs-mixed');
  return { create: createWithMix, mix: mix, fitHeads: fitHeads, icon: iconNode };
});
