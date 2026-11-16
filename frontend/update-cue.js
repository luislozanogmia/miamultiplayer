/* The sidebar's sign that a new version of Mia is on its way: a small pill
   that fills while the update downloads and turns into "Restart to update"
   once it can install. Without it a download ran with nothing on screen. */
(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaUpdateCue = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  // What the pill shows for a state from the desktop app, or null for nothing.
  // -> {text: "Downloading Mia 0.3.9", detail: "42%", percent: 42, ready: false}
  function view(state){
    var phase = state && state.phase, name = 'Mia' + (state && state.version ? ' ' + String(state.version).slice(0, 20) : '');
    if(phase === 'downloading'){
      var percent = Math.max(0, Math.min(100, Math.round(Number(state.percent) || 0)));
      return {text: 'Downloading ' + name, detail: percent + '%', percent: percent, ready: false};
    }
    if(phase === 'preparing') return {text: 'Preparing ' + name, detail: '', percent: 100, ready: false};
    if(phase === 'ready') return {text: 'Restart to update', detail: name, percent: 100, ready: true};
    return null;
  }

  function render(node, state){
    var shown = view(state);
    node.hidden = !shown;
    if(!shown) return;
    node.classList.toggle('is-ready', shown.ready);
    node.disabled = !shown.ready;
    node.setAttribute('aria-label', shown.text + (shown.detail ? ', ' + shown.detail : ''));
    node.title = shown.ready ? 'Restart Mia to finish the update' : 'Mia keeps working while the update downloads';
    node.querySelector('[data-update-text]').textContent = shown.text;
    node.querySelector('[data-update-detail]').textContent = shown.detail;
    node.querySelector('[data-update-bar]').style.width = shown.percent + '%';
  }

  // updates is the desktop bridge: state(), onState(callback), install().
  function mount(node, updates){
    if(!node || !updates) return;
    updates.onState(function(state){ render(node, state); });
    Promise.resolve(updates.state()).then(function(state){ render(node, state); }, function(){});
    node.addEventListener('click', function(){ updates.install(); });
  }

  return {view: view, render: render, mount: mount};
});
