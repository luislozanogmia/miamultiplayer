// One tooltip for Mia's icon buttons. A control names itself with
// data-tip="…" (and keeps its aria-label); hovering or keyboard-focusing it
// shows the label almost at once, always in the same place and style. The
// native title tooltip waits about a second and appears inconsistently, so
// controls that use this one carry no title.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MiaTooltip = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // The first tip of a hover shows after a short pause so a pointer passing
  // over the bar does not flash labels; moving along the bar to the next
  // control shows its tip at once.
  var SHOW_DELAY = 80;
  var WARM_WINDOW = 400;
  var GAP = 6;
  var EDGE = 8;

  function delayFor(lastHiddenAt, now) {
    return lastHiddenAt && now - lastHiddenAt < WARM_WINDOW ? 0 : SHOW_DELAY;
  }

  // Below the control, centred, kept inside the window; above it when there
  // is no room below.
  function place(rect, tip, viewport) {
    var left = rect.left + rect.width / 2 - tip.width / 2;
    left = Math.max(EDGE, Math.min(left, viewport.width - tip.width - EDGE));
    var top = rect.bottom + GAP;
    if (top + tip.height > viewport.height - EDGE) top = Math.max(EDGE, rect.top - GAP - tip.height);
    return { left: Math.round(left), top: Math.round(top) };
  }

  function install(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body || doc.__miaTooltip) return null;
    var tip = doc.createElement('div');
    tip.className = 'mia-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(tip);
    var current = null, timer = null, lastHiddenAt = 0;

    function targetOf(node) {
      return node && node.closest ? node.closest('[data-tip]') : null;
    }
    function show(target) {
      var text = target.getAttribute('data-tip');
      if (!text || !target.isConnected) return;
      tip.textContent = text;
      tip.classList.add('is-visible');
      var rect = target.getBoundingClientRect();
      var spot = place(rect, { width: tip.offsetWidth, height: tip.offsetHeight },
        { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight });
      tip.style.left = spot.left + 'px';
      tip.style.top = spot.top + 'px';
    }
    function hide() {
      clearTimeout(timer); timer = null;
      if (current) lastHiddenAt = Date.now();
      current = null;
      tip.classList.remove('is-visible');
    }
    function enter(target) {
      if (target === current) return;
      clearTimeout(timer);
      current = target;
      var wait = delayFor(lastHiddenAt, Date.now());
      if (tip.classList.contains('is-visible')) wait = 0;
      if (!wait) show(target);
      else timer = setTimeout(function () { if (current === target) show(target); }, wait);
    }
    doc.addEventListener('pointerover', function (event) {
      var target = targetOf(event.target);
      if (target) enter(target); else if (current) hide();
    }, true);
    doc.addEventListener('pointerout', function (event) {
      if (!current) return;
      var to = targetOf(event.relatedTarget);
      if (to !== current) hide();
    }, true);
    doc.addEventListener('focusin', function (event) {
      var target = targetOf(event.target);
      if (target && target.matches && target.matches(':focus-visible')) enter(target);
    }, true);
    doc.addEventListener('focusout', hide, true);
    doc.addEventListener('pointerdown', hide, true);
    doc.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(); }, true);
    doc.addEventListener('scroll', hide, true);
    // A label that changes while showing (Mix → Separate) updates in place.
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { if (current && tip.classList.contains('is-visible')) show(current); })
        .observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['data-tip'] });
    }
    doc.__miaTooltip = { hide: hide };
    return doc.__miaTooltip;
  }

  if (typeof document !== 'undefined') {
    if (document.body) install(document);
    else document.addEventListener('DOMContentLoaded', function () { install(document); });
  }
  return { SHOW_DELAY: SHOW_DELAY, delayFor: delayFor, place: place, install: install };
});
