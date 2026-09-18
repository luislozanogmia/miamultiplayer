/* Mia mark — the animated dot-diamond logo.
   41 identical dots; a wave front sweeps across, and dots inside it swell to
   150% and turn gold. Every dot runs the same keyframes — the only thing that
   differs per dot is its animation-delay (its position along the travel axis),
   so the whole effect is phase offset, no per-frame JS.
   Modes (picked at random per mark, re-rolled every few cycles while at rest):
     diag / diag-rev   upper-right → lower-left and back, 3.2s, tight front
     wide / wide-rev   same axis, 5s, wide front (a tide)
     horiz / horiz-rev left → right and back, 3.2s
     activity          D4 random pops and occasional wave passes while working
   Reference page with all takes: the external Mia logo reference folder. */
(function(){
  var MODES = [
    {dir:[-0.7071, 0.7071], period:3.2, width:0.22},
    {dir:[ 0.7071,-0.7071], period:3.2, width:0.22},
    {dir:[-0.7071, 0.7071], period:5.0, width:0.40},
    {dir:[ 0.7071,-0.7071], period:5.0, width:0.40},
    {dir:[ 1, 0], period:3.2, width:0.22},
    {dir:[-1, 0], period:3.2, width:0.22}
  ];
  var CROSS = 0.78; // share of the cycle the front spends crossing; the rest is quiet
  var injected = {};
  function keyframes(width){
    var W = width * 100, key = 'miaw' + Math.round(W);
    if(injected[key]) return key; injected[key] = true;
    var q1 = (W * 0.12).toFixed(1), half = (W / 2).toFixed(1), q3 = (W * 0.88).toFixed(1), full = W.toFixed(1);
    // colour snaps in the first/last 12% of the lit window so the black→gold
    // interpolation (which passes through brown) is too brief to see.
    var css = '@keyframes ' + key + '{0%{transform:scale(1);fill:var(--mia-dot)} ' + q1 + '%{fill:var(--mia-gold)} ' +
      half + '%{transform:scale(1.5);fill:var(--mia-gold-hi)} ' + q3 + '%{fill:var(--mia-gold)} ' +
      full + '%{transform:scale(1);fill:var(--mia-dot)} 100%{transform:scale(1);fill:var(--mia-dot)}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    return key;
  }
  function dots(cut){
    var out = [];
    for(var y = -4; y <= 4; y++) for(var x = -4; x <= 4; x++){
      var r = Math.abs(x) + Math.abs(y); if(r > cut) continue;
      out.push({x:x, y:y, size: r === 4 ? 5.2 : 6});
    }
    return out;
  }
  function svg(px, mode, iterations){
    var cut = px >= 48 ? 4 : px >= 28 ? 3 : 2;
    var unit = 24, grow = px >= 48 ? 1 : px >= 28 ? 1.15 : 1.3;
    var S = 2 * cut * unit + (px >= 48 ? 40 : 24);
    var key = keyframes(mode.width), d = mode.dir;
    var s = '<svg class="mia-mark" viewBox="' + (-S/2) + ' ' + (-S/2) + ' ' + S + ' ' + S + '" width="' + px + '" height="' + px + '" aria-hidden="true">';
    dots(cut).forEach(function(p){
      var proj = (p.x * d[0] + p.y * d[1] + cut * 1.42) / (cut * 2.84);
      var delay = (-(1 - proj) * mode.period * CROSS).toFixed(3);
      s += '<circle cx="' + (p.x * unit) + '" cy="' + (p.y * unit) + '" r="' + (p.size * grow).toFixed(1) +
        '" style="animation:' + key + ' ' + mode.period + 's cubic-bezier(.4,0,.2,1) ' + delay + 's ' + (iterations || 'infinite') + '"/>';
    });
    return s + '</svg>';
  }
  function activitySvg(px){
    var cut = px >= 48 ? 4 : px >= 28 ? 3 : 2;
    var unit = 24, grow = px >= 48 ? 1 : px >= 28 ? 1.15 : 1.3;
    var S = 2 * cut * unit + (px >= 48 ? 40 : 24);
    var s = '<svg class="mia-mark pop" data-cut="' + cut + '" viewBox="' + (-S/2) + ' ' + (-S/2) + ' ' + S + ' ' + S + '" width="' + px + '" height="' + px + '" aria-hidden="true">';
    dots(cut).forEach(function(p){
      s += '<circle cx="' + (p.x * unit) + '" cy="' + (p.y * unit) + '" r="' + (p.size * grow).toFixed(1) +
        '" data-x="' + p.x + '" data-y="' + p.y + '"/>';
    });
    return s + '</svg>';
  }
  function staticSvg(px){
    var cut = px >= 48 ? 4 : px >= 28 ? 3 : 2;
    var unit = 24, grow = px >= 48 ? 1 : px >= 28 ? 1.15 : 1.3;
    var S = 2 * cut * unit + (px >= 48 ? 40 : 24);
    var s = '<svg class="mia-mark" viewBox="' + (-S/2) + ' ' + (-S/2) + ' ' + S + ' ' + S + '" width="' + px + '" height="' + px + '" aria-hidden="true">';
    dots(cut).forEach(function(p){
      s += '<circle cx="' + (p.x * unit) + '" cy="' + (p.y * unit) + '" r="' + (p.size * grow).toFixed(1) + '"/>';
    });
    return s + '</svg>';
  }
  function clearActivity(el){
    if(el._miaPopTimer) clearTimeout(el._miaPopTimer);
    el._miaPopTimer = null;
    (el._miaPopTimers || []).forEach(function(timer){ clearTimeout(timer); });
    el._miaPopTimers = [];
  }
  // D4 from mia-logo.html: sparse irregular pops plus an occasional wave pass.
  function runActivity(el){
    var circles = Array.prototype.slice.call(el.querySelectorAll('circle'));
    var phases = [0.2, 0.4, 0.6, 1.0, 'wave', 'wave'];
    var last = null;
    function fire(circle, delay){
      var timer = setTimeout(function(){
        var idx = el._miaPopTimers.indexOf(timer);
        if(idx !== -1) el._miaPopTimers.splice(idx, 1);
        circle.classList.remove('on');
        void circle.getBBox();
        circle.classList.add('on');
      }, delay);
      el._miaPopTimers.push(timer);
    }
    function phase(){
      var pick;
      do { pick = phases[Math.floor(Math.random() * phases.length)]; } while(pick === last && phases.length > 1);
      last = pick;
      var len = 3000;
      if(pick === 'wave'){
        var dirs = [[-0.7071,0.7071],[0.7071,-0.7071],[1,0],[-1,0]];
        var d = dirs[Math.floor(Math.random() * dirs.length)];
        var cut = parseInt(el.querySelector('svg').getAttribute('data-cut') || '2', 10);
        var period = 2600;
        circles.forEach(function(circle){
          var x = parseFloat(circle.getAttribute('data-x') || '0');
          var y = parseFloat(circle.getAttribute('data-y') || '0');
          var proj = (x * d[0] + y * d[1] + cut * 1.42) / (cut * 2.84);
          fire(circle, proj * period * 0.78);
        });
        len = period + 600;
      }else if(pick === 1.0){
        circles.forEach(function(circle){ fire(circle, Math.random() * 180); });
        len = 2200;
      }else{
        var count = Math.round(circles.length * pick);
        var order = circles.slice().sort(function(){ return Math.random() - 0.5; }).slice(0, count);
        order.forEach(function(circle){ fire(circle, Math.random() * 2200); });
        len = 3200;
      }
      el._miaPopTimer = setTimeout(phase, len);
    }
    phase();
  }
  function clearRenderTimers(el){
    if(el._miaTimer) clearTimeout(el._miaTimer);
    el._miaTimer = null;
    clearActivity(el);
  }
  function pick(prev){
    var i; do { i = Math.floor(Math.random() * MODES.length); } while(MODES.length > 1 && MODES[i] === prev);
    return MODES[i];
  }
  // Mount into `el`, re-rolling the mode every ~4 cycles. The swap happens at
  // the tail of a cycle, when every dot is at rest, so it never pops mid-wave.
  function render(el, px, modeName){
    if(!el) return;
    clearRenderTimers(el);
    if(modeName === 'static'){
      el.innerHTML = staticSvg(px);
      return;
    }
    if(modeName === 'activity'){
      el.innerHTML = activitySvg(px);
      runActivity(el);
      return;
    }
    if(modeName === 'sidebar'){
      // One Mia in the sidebar stays alive without repainting the GPU all day:
      // play one complete wave, then remain still until the next 30-second turn.
      function pulseSidebar(){
        var sidebarMode = pick(null);
        el.innerHTML = svg(px, sidebarMode, 1);
        el._miaTimer = setTimeout(pulseSidebar, 30000);
      }
      pulseSidebar();
      return;
    }
    var mode = null;
    function go(){
      mode = pick(mode);
      el.innerHTML = svg(px, mode);
      var cycles = 3 + Math.floor(Math.random() * 3);
      // rest begins when the last dot's lit window ends: (CROSS + width) of a period in
      var wait = (cycles - 1 + CROSS + mode.width + 0.05) * mode.period * 1000;
      el._miaTimer = setTimeout(go, wait);
    }
    go();
  }
  function destroy(el){
    if(!el) return;
    clearRenderTimers(el);
    el._miaMarkMounted = false;
  }
  window.MiaMark = { render: render, svg: svg, destroy: destroy };
})();
