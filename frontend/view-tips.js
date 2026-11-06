// First-run tips for Mia's four views (Chat, Automations, Artifacts,
// Browser), in Mia's motion style: a colored Mote throws a curved arrow at a
// real control, with a short bold label in a rounded pill. Each view shows
// its tips once, the first time it is opened; Settings > View tips replays
// them. The tips never block the app: only their small card takes clicks,
// and Escape or Skip puts them away.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MiaViewTips = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var STORAGE_KEY = 'miaViewTips:v1';
  // The motion palette: pink 337, blue 211, orange 27, green 145.
  var COLORS = {
    pink: { hue: 337, css: '#e9407f' },
    blue: { hue: 211, css: '#1084fe' },
    orange: { hue: 27, css: '#f47a2e' },
    green: { hue: 145, css: '#2fa866' }
  };
  var MOTE_SRC = 'assets/mote/mote.svg';
  var MOTE_BASE_HUE = 337; // mote.svg is the pink plate
  var MOTE = 56;           // mote size, px
  var CARD_W = 248;
  var EDGE = 12;
  var REACH = 150;         // how far the Mote stands from its control

  // Two to four steps per view, each on a control that is always there in
  // that view. A step whose control is missing or hidden is left out.
  var TIPS = {
    chat: [
      { target: '#ccInput', color: 'pink', label: 'Ask here', body: 'Ask Mia, or @ a bot. Each chat keeps its own draft.' },
      { target: '#chatStarterBots', color: 'blue', label: 'Start a bot', body: 'Pick a starter bot to set one up in a few words.' },
      { target: '#sidebarMixBtn', color: 'orange', label: 'Mix every tab', body: 'Chats, automations, artifacts and pages in one strip.' }
    ],
    automations: [
      { target: '#automationsAddBtn', color: 'pink', label: 'New automation', body: 'Pick a bot, then say what it should do and when.' },
      { target: '#automationsSummary', color: 'green', label: 'Runs on its own', body: 'Every scheduled task shows below, with its last run.' },
      { target: '[data-sidebar-view="chat"]', color: 'blue', label: 'Or just ask', body: 'In a bot’s chat, ask it to do something every day.' }
    ],
    artifacts: [
      { target: '#artifactsChips', color: 'green', label: 'What bots made', body: 'Pages, files and apps from your chats. Pick a kind to narrow it.' },
      { target: '#artifactsSearch', color: 'blue', label: 'Find anything', body: 'Filter by name across everything your bots made.' },
      { target: '#artifactsAddBtn', color: 'pink', label: 'Add a live app', body: 'Keep a web app you use next to your bots’ work.' }
    ],
    browser: [
      { target: '#localBrowserUrl', color: 'blue', label: 'Go anywhere', body: 'Your sign-ins stay in Mia’s browser.' },
      { target: '#localBrowserTabsRow', color: 'orange', label: 'Bots get their own tabs', body: 'Each bot works in its own tab group; yours stays put.' }
    ]
  };

  function rotationFor(color) {
    var hue = (COLORS[color] || COLORS.pink).hue;
    return ((hue - MOTE_BASE_HUE + 540) % 360) - 180;
  }

  function readSeen(storage) {
    try {
      var value = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) { return {}; }
  }
  function markSeen(storage, view) {
    var seen = readSeen(storage);
    seen[view] = true;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(seen)); } catch (_) {}
  }
  function resetSeen(storage) {
    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function visibleRect(node) {
    if (!node || !node.getBoundingClientRect || !node.isConnected) return null;
    if (node.closest && node.closest('[hidden]')) return null;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }
  // An arrow needs a control to land on, not a whole panel.
  function pointable(rect, viewport) {
    return !!rect && rect.width <= viewport.width * 0.6 && rect.height <= viewport.height * 0.4;
  }

  // Where the Mote stands, where its arrow lands and how it bends. The Mote
  // stands toward the middle of the window from the control, its card sits
  // on the far side of the Mote from the control (so the arrow is never
  // covered), and both stay inside the window.
  function layout(rect, viewport, cardH) {
    cardH = cardH || 120;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var dx = viewport.width / 2 - cx, dy = viewport.height / 2 - cy;
    var vertical = Math.abs(dy) >= Math.abs(dx);
    var dl = Math.hypot(dx, dy) || 1;
    var reach = REACH + (vertical ? rect.height : rect.width) / 2;
    var half = MOTE / 2 + EDGE;
    var mote = {
      x: Math.max(half, Math.min(cx + dx / dl * reach, viewport.width - half)),
      y: Math.max(half, Math.min(cy + dy / dl * reach, viewport.height - half))
    };
    var card;
    if (vertical) {
      card = { left: mote.x - CARD_W / 2, top: dy < 0 ? mote.y - MOTE / 2 - 8 - cardH : mote.y + MOTE / 2 + 8 };
    } else {
      card = { left: dx < 0 ? mote.x - MOTE / 2 - 8 - CARD_W : mote.x + MOTE / 2 + 8, top: mote.y - cardH / 2 };
    }
    card.left = Math.round(Math.max(EDGE, Math.min(card.left, viewport.width - CARD_W - EDGE)));
    card.top = Math.round(Math.max(EDGE, Math.min(card.top, viewport.height - cardH - EDGE)));
    // The arrow leaves the Mote and stops just short of the control's edge.
    var ex = Math.max(rect.left - 6, Math.min(mote.x, rect.right + 6));
    var ey = Math.max(rect.top - 6, Math.min(mote.y, rect.bottom + 6));
    if (mote.x >= rect.left && mote.x <= rect.right && mote.y >= rect.top && mote.y <= rect.bottom) { ex = cx; ey = cy; }
    var ax = ex - mote.x, ay = ey - mote.y, al = Math.hypot(ax, ay) || 1;
    var start = { x: mote.x + ax / al * (MOTE / 2 + 6), y: mote.y + ay / al * (MOTE / 2 + 6) };
    var end = { x: ex, y: ey };
    // Bend to one side, like a throw.
    var bend = Math.min(60, al * 0.3);
    var control = { x: (start.x + end.x) / 2 - ay / al * bend, y: (start.y + end.y) / 2 + ax / al * bend };
    var angle = Math.atan2(end.y - control.y, end.x - control.x) * 180 / Math.PI;
    return { card: card, mote: mote, start: start, control: control, end: end, angle: angle };
  }

  function install(doc, options) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    options = options || {};
    if (!doc || !doc.body || doc.__miaViewTips) return doc && doc.__miaViewTips;
    var win = doc.defaultView || {};
    var storage = options.storage || win.localStorage;
    var currentView = options.view || function () { return 'chat'; };
    var blocked = options.blocked || function () { return false; };
    // Told when a view's tips appear and go: (view) then (null).
    var onShown = options.onShown || function () {};
    var NS = 'http://www.w3.org/2000/svg';

    var layer = doc.createElement('div');
    layer.className = 'mia-tips';
    layer.hidden = true;
    layer.innerHTML =
      '<svg class="mia-tips-arrow" aria-hidden="true"><path class="mia-tips-path" fill="none" stroke-linecap="round"></path><path class="mia-tips-head" d="M6 0 L-14 -11 L-9 0 L-14 11 Z" stroke-linejoin="round"></path></svg>' +
      '<img class="mia-tips-mote" src="' + MOTE_SRC + '" alt="" draggable="false">' +
      '<div class="mia-tips-card" role="dialog" aria-live="polite">' +
          '<span class="mia-tips-pill"></span>' +
          '<p class="mia-tips-body"></p>' +
          '<div class="mia-tips-actions"><span class="mia-tips-count"></span>' +
            '<button type="button" class="mia-tips-skip">Skip tips</button>' +
            '<button type="button" class="mia-tips-next">Next</button></div>' +
      '</div>';
    doc.body.appendChild(layer);
    var path = layer.querySelector('.mia-tips-path'), head = layer.querySelector('.mia-tips-head');
    var card = layer.querySelector('.mia-tips-card'), mote = layer.querySelector('.mia-tips-mote');
    var pill = layer.querySelector('.mia-tips-pill'), body = layer.querySelector('.mia-tips-body');
    var count = layer.querySelector('.mia-tips-count'), next = layer.querySelector('.mia-tips-next');
    var skip = layer.querySelector('.mia-tips-skip');
    var state = { view: null, steps: [], index: 0, timer: null };

    function stepsFor(view) {
      var viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
      return (TIPS[view] || []).filter(function (step) { return pointable(visibleRect(doc.querySelector(step.target)), viewport); });
    }
    function place() {
      var step = state.steps[state.index];
      var target = step && doc.querySelector(step.target);
      var rect = visibleRect(target);
      if (!rect) return close(false);
      var viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
      var spot = layout(rect, viewport, card.offsetHeight);
      card.style.left = spot.card.left + 'px';
      card.style.top = spot.card.top + 'px';
      mote.style.left = Math.round(spot.mote.x - MOTE / 2) + 'px';
      mote.style.top = Math.round(spot.mote.y - MOTE / 2) + 'px';
      path.setAttribute('d', 'M' + spot.start.x + ',' + spot.start.y + ' Q' + spot.control.x + ',' + spot.control.y + ' ' + spot.end.x + ',' + spot.end.y);
      head.setAttribute('transform', 'translate(' + spot.end.x + ',' + spot.end.y + ') rotate(' + spot.angle + ')');
      var length = path.getTotalLength ? path.getTotalLength() : 0;
      path.style.setProperty('--len', String(Math.ceil(length)));
    }
    function show(index) {
      state.index = index;
      var step = state.steps[index];
      var color = COLORS[step.color] || COLORS.pink;
      layer.style.setProperty('--tip-color', color.css);
      mote.style.filter = 'hue-rotate(' + rotationFor(step.color) + 'deg) saturate(1.08)';
      pill.textContent = step.label;
      body.textContent = step.body;
      count.textContent = (index + 1) + ' of ' + state.steps.length;
      next.textContent = index === state.steps.length - 1 ? 'Got it' : 'Next';
      skip.hidden = index === state.steps.length - 1;
      layer.hidden = false;
      // Restart the throw for every step.
      layer.classList.remove('is-in');
      void layer.offsetWidth;
      place();
      layer.classList.add('is-in');
    }
    function close(done) {
      if (state.view && done) markSeen(storage, state.view);
      var was = state.view;
      state.view = null; state.steps = []; state.index = 0;
      layer.hidden = true;
      if (was) onShown(null);
      layer.classList.remove('is-in');
    }
    // Shows the open view's tips if they have not been seen. The view must
    // have settled and nothing (sign-in, loading, a dialog, the guided tour)
    // may be on top of it.
    function maybeShow(force) {
      clearTimeout(state.timer);
      state.timer = setTimeout(function () {
        var view = currentView();
        if (!view || !TIPS[view]) return;
        if (state.view === view) return;
        if (!force && readSeen(storage)[view]) return;
        if (blocked()) return;
        var steps = stepsFor(view);
        if (steps.length < 2) return;
        close(false);
        state.view = view;
        state.steps = steps;
        onShown(view);
        show(0);
      }, force ? 0 : 450);
    }

    next.addEventListener('click', function () {
      if (state.index < state.steps.length - 1) show(state.index + 1);
      else close(true);
    });
    skip.addEventListener('click', function () { close(true); });
    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !layer.hidden) close(true);
    }, true);
    if (win.addEventListener) win.addEventListener('resize', function () { if (!layer.hidden) place(); });
    // A view change is a body class change (chat, automations-mode, …).
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        if (!layer.hidden && state.view !== currentView()) close(false);
        maybeShow(false);
      }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    }

    doc.__miaViewTips = {
      maybeShow: function () { maybeShow(false); },
      replay: function () { resetSeen(storage); close(false); maybeShow(true); },
      close: function () { close(false); }
    };
    return doc.__miaViewTips;
  }

  return { TIPS: TIPS, COLORS: COLORS, STORAGE_KEY: STORAGE_KEY, layout: layout, pointable: pointable, rotationFor: rotationFor,
    readSeen: readSeen, markSeen: markSeen, resetSeen: resetSeen, install: install };
});
