// AI mode intro: a short full-window animation that plays over Mia. The app is
// drawn as a small stylised copy of itself; its panels soften, lift and
// dissolve into the AI mode stage. It ends on "AI mode" (a preview), one line
// about where collaboration is going, and two choices. The app is not replaced:
// this only shows where it is heading.
//
//   MiaAiModeIntro.play(opts) -> Promise<'try' | 'skip'>
//
// It never enters AI mode itself; the caller does that on 'try'.
// opts (all optional): parent (default document.body), reducedMotion (force
// true/false; default follows the system), speed (timeline multiplier, 1).
//
// Drawn in its own shadow root, CSS transitions and one small canvas only.
(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.MiaAiModeIntro = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';

  var COPY = {
    label: 'AI mode preview',
    title: 'AI mode',
    tag: 'Preview',
    line: 'Our take on where collaboration between people and AI is going.',
    note: 'Mia stays just as it is. You can switch between the two at any time.',
    skip: 'Skip',
    later: 'Not now',
    go: 'Try AI mode',
    typed: 'Plan next week\'s launch',
    placeholder: 'Say what you want',
    captions: {
      app: 'Mia, as you know it.',
      soften: 'It stays right where it is.',
      dissolve: 'Now, just say what you want.',
      work: 'Mia and your bots do the work.',
      final: ''
    },
    cards: [
      {title: 'Launch checklist', text: 'Drafted and ready to review', mote: 'research'},
      {title: 'Team update', text: 'Written from this week\'s chats', mote: 'inbox'},
      {title: 'Friday review', text: 'Booked with everyone free', mote: 'calendar'}
    ],
    chats: ['Launch plan', 'Team notes', 'Customer calls', 'Ideas'],
    bots: [{name: 'Scout', mote: 'research'}, {name: 'Ledger', mote: 'sales'}, {name: 'Inbox', mote: 'inbox'}]
  };

  // When each phase starts, in milliseconds. Phases stack: every phase keeps
  // the classes of the ones before it, so the CSS only says what changes.
  var STEPS = [
    {at: 0, phase: 'app'},
    {at: 3600, phase: 'soften'},
    {at: 6600, phase: 'dissolve'},
    {at: 10200, phase: 'work'},
    {at: 14800, phase: 'final'}
  ];
  var TOTAL_MS = 15800; // buttons are fully settled by here
  var LEAVE_MS = 240;

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function mote(kind){ return 'assets/mote/mote-' + kind + '-static.svg'; }

  // Phases up to and including this one, as class names.
  function classesFor(phase){
    var out = [];
    for(var i = 0; i < STEPS.length; i++){
      out.push('is-' + STEPS[i].phase);
      if(STEPS[i].phase === phase) return out;
    }
    return out;
  }

  var CSS = [
    ':host{position:fixed;inset:0;z-index:2147482900;display:block;font:14px/1.45 var(--sans,"Instrument Sans",system-ui,sans-serif);-webkit-font-smoothing:antialiased;color-scheme:dark;',
    '--void:#050504;--card:#14120F;--rule:#262320;--ink:#fff;--soft:rgba(255,255,255,.74);--muted:rgba(255,255,255,.55);--accent:#E3A61B;--accent-hover:#F2B833;--accent-text:#F0BC4A;--on-accent:#0B0A09;--mia-dot:rgba(255,255,255,.78)}',
    '*{box-sizing:border-box}button{font:inherit;color:inherit}',
    'button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '.stage{position:absolute;inset:0;overflow:hidden;background:#E9E6DF;color:var(--ink);opacity:0;transition:opacity .5s ease}',
    '.stage.on{opacity:1}.stage.leaving{opacity:0;transition-duration:.24s}',
    // light app, then the dark stage rises over it
    '.dark{position:absolute;inset:0;background:var(--void);opacity:0;transition:opacity 1.6s ease}',
    '.is-dissolve .dark{opacity:1}',
    '#rain{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 1.6s ease}',
    '.is-dissolve #rain{opacity:1}',
    // the miniature app
    '.app{position:absolute;left:50%;top:46%;width:min(860px,84vw);aspect-ratio:16/10;max-height:70vh;transform:translate(-50%,-50%);border-radius:16px;background:var(--sand-bg-base,#fff);border:1px solid rgba(20,20,20,.12);box-shadow:0 30px 80px -30px rgba(20,20,20,.35);display:grid;grid-template-columns:27% 1fr;overflow:hidden;color:var(--sand-text-primary,#141414);opacity:0;transform:translate(-50%,-47%) scale(.97);transition:opacity .9s ease,transform 1.2s cubic-bezier(.2,.7,.2,1),box-shadow 1.2s ease,background 1.2s ease,border-color 1.2s ease}',
    '.is-app .app{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    '.is-soften .app{transform:translate(-50%,-52%) scale(1.02);box-shadow:0 50px 90px -30px rgba(20,20,20,.5)}',
    '.is-dissolve .app{background:transparent;border-color:rgba(255,255,255,0);box-shadow:none;transform:translate(-50%,-54%) scale(1.06)}',
    '.panel{transition:transform 1.4s cubic-bezier(.4,0,.2,1),opacity 1.2s ease,filter 1.2s ease}',
    '.side{padding:16px 14px;background:var(--sand-bg-subtle,#f6f5f2);border-right:1px solid rgba(20,20,20,.08);display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.main{display:flex;flex-direction:column;min-width:0}',
    '.msgs{flex:1;padding:22px 24px;display:flex;flex-direction:column;gap:12px;min-height:0;overflow:hidden}',
    '.compose{margin:0 20px 18px;height:42px;border:1px solid rgba(20,20,20,.16);border-radius:12px;display:flex;align-items:center;padding:0 14px;color:rgba(20,20,20,.5);font-size:13px;background:var(--sand-bg-base,#fff)}',
    '.h{font:600 11px/1 var(--mono,ui-monospace,monospace);letter-spacing:.08em;text-transform:uppercase;color:rgba(20,20,20,.45);margin:8px 6px 4px}',
    '.row{height:30px;border-radius:8px;padding:0 10px;display:flex;align-items:center;gap:8px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.row.on{background:rgba(20,20,20,.07);font-weight:500}',
    '.row img{width:22px;height:22px;flex:none}',
    '.bub{max-width:70%;padding:10px 14px;border-radius:14px;background:rgba(20,20,20,.06);font-size:13px}',
    '.bub.me{align-self:flex-end;background:#141414;color:#fcfcfc}',
    '.bub i{display:block;height:7px;border-radius:4px;background:rgba(20,20,20,.14);margin:4px 0;font-style:normal}',
    '.bub.me i{background:rgba(255,255,255,.4)}',
    '.is-soften .p-side{transform:translate(-6px,-4px);filter:blur(.6px)}',
    '.is-soften .p-msgs{transform:translateY(-8px);filter:blur(.6px)}',
    '.is-soften .p-compose{transform:translateY(-3px)}',
    '.is-dissolve .p-side{transform:translate(-70px,-30px) scale(1.08);opacity:0;filter:blur(12px)}',
    '.is-dissolve .p-msgs{transform:translate(0,-60px) scale(1.08);opacity:0;filter:blur(12px);transition-delay:.12s}',
    '.is-dissolve .p-compose{transform:translate(0,60px) scale(1.04);opacity:0;filter:blur(10px);transition-delay:.24s}',
    // AI mode stage content
    '.ai{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;padding:48px 24px 96px;transition:opacity 1.2s ease,filter 1.2s ease,transform 1.2s cubic-bezier(.4,0,.2,1)}',
    '.mk{width:72px;height:72px;opacity:0;transform:scale(.8);transition:opacity 1.2s ease .5s,transform 1.4s cubic-bezier(.2,.7,.2,1) .5s}',
    '.is-dissolve .mk{opacity:1;transform:none}',
    '.mk circle{fill:var(--mia-dot)}',
    '.cards{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;max-width:min(900px,100%);min-height:150px}',
    '.card{width:210px;border:1px solid var(--rule);border-radius:16px;overflow:hidden;background:rgba(20,18,15,.86);opacity:0;transform:translateY(14px);transition:opacity .7s ease,transform .8s cubic-bezier(.2,.7,.2,1)}',
    '.card .pic{height:70px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(227,166,27,.22),rgba(255,255,255,.04))}',
    '.card .pic img{height:52px;width:auto}',
    '.card .t{padding:10px 14px 13px}.card b{display:block;font:600 14px/1.3 var(--sans,system-ui,sans-serif);color:var(--ink)}.card p{margin:3px 0 0;font-size:12px;color:var(--soft)}',
    '.is-work .card{opacity:1;transform:none}',
    '.card:nth-child(2){transition-delay:.9s}.card:nth-child(3){transition-delay:1.8s}',
    '.is-work .card img{animation:bob 2.6s ease-in-out infinite}.card:nth-child(2) img{animation-delay:-.9s}.card:nth-child(3) img{animation-delay:-1.7s}',
    '@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
    // the one input line, as in the real stage
    '.pill{position:absolute;left:50%;bottom:44px;width:min(560px,86vw);height:44px;transform:translate(-50%,10px);border:1px solid rgba(255,255,255,.28);border-radius:22px;background:rgba(11,10,9,.8);box-shadow:0 4px 12px -1px rgba(0,0,0,.5);display:flex;align-items:center;padding:0 16px;color:var(--muted);font-size:16px;opacity:0;transition:opacity 1.2s ease 1s,transform 1.2s cubic-bezier(.2,.7,.2,1) 1s;overflow:hidden;white-space:nowrap}',
    '.is-dissolve .pill{opacity:1;transform:translate(-50%,0)}',
    '.pill .ph,.pill .ty{position:absolute;left:16px}',
    '.pill .ty{color:var(--ink);opacity:0;clip-path:inset(0 100% 0 0)}',
    '.is-work .pill .ph{opacity:0}.is-work .pill .ty{opacity:1;animation:type 2.4s steps(22,end) .6s forwards}',
    '@keyframes type{to{clip-path:inset(0 0 0 0)}}',
    // captions
    '.cap{position:absolute;left:0;right:0;top:calc(50% + min(34vh,330px));text-align:center;font:500 clamp(19px,2.6vw,28px)/1.3 var(--sans,system-ui,sans-serif);color:rgba(20,20,20,.7);padding:0 24px;transition:color 1.2s ease,opacity .5s ease;min-height:1.3em}',
    '.is-dissolve .cap{color:var(--soft);top:auto;bottom:108px}',
    '.is-final .cap{opacity:0}',
    // the ending
    '.is-final .ai{opacity:.1;filter:blur(8px);transform:scale(.98)}.is-final .pill{opacity:0}',
    '.final{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;pointer-events:none}',
    '.final>*{opacity:0;transform:translateY(10px);transition:opacity .8s ease,transform .8s cubic-bezier(.2,.7,.2,1)}',
    '.is-final .final{pointer-events:auto}.is-final .final>*{opacity:1;transform:none}',
    '.is-final .final>:nth-child(2){transition-delay:.15s}.is-final .final>:nth-child(3){transition-delay:.3s}.is-final .final>:nth-child(4){transition-delay:.45s}.is-final .final>:nth-child(5){transition-delay:.6s}',
    '.ttl{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center}',
    '.ttl h2{margin:0;font:500 clamp(34px,6vw,60px)/1.05 var(--sans,system-ui,sans-serif);letter-spacing:-.025em}',
    '.tag{font:600 11px/1 var(--mono,ui-monospace,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-text);border:1px solid rgba(240,188,74,.45);background:rgba(227,166,27,.14);border-radius:999px;padding:6px 10px}',
    '.line{margin:0;max-width:30em;font-size:clamp(16px,2vw,20px);color:var(--soft);text-wrap:balance}',
    '.note{margin:0;max-width:30em;font-size:13px;color:var(--muted)}',
    '.acts{display:flex;gap:10px;margin-top:10px}',
    '.btn{appearance:none;height:40px;border-radius:8px;padding:0 22px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);font-size:14px;cursor:pointer;white-space:nowrap;transition:background .12s ease}',
    '.btn:hover{background:rgba(255,255,255,.12)}',
    '.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:500}.btn.primary:hover{background:var(--accent-hover)}',
    '.skip{position:absolute;top:16px;right:20px;height:32px;padding:0 12px;font-size:13px;background:transparent;border:1px solid transparent;border-radius:8px;cursor:pointer;color:rgba(20,20,20,.6);transition:opacity .4s ease,color 1.2s ease;z-index:2}',
    '.skip:hover{background:rgba(127,127,127,.15)}',
    '.is-dissolve .skip{color:var(--muted)}.is-final .skip{opacity:0;pointer-events:none}',
    '@media(max-width:1000px){.app{width:90vw}.card{width:176px}}',
    // reduced motion: only the final frame, nothing moves
    '.still *,.still{transition:none!important;animation:none!important}',
    '.still .app,.still .pill,.still .skip,.still .cap{display:none}',
    '.still .dark,.still #rain{opacity:1}',
    '.still .ai{opacity:.1;filter:blur(8px)}',
    '.still .final{pointer-events:auto}.still .final>*{opacity:1;transform:none}',
    '.still .mk{opacity:1;transform:none}.still .card{opacity:1;transform:none}'
  ].join('');

  function appHtml(){
    var chats = COPY.chats.map(function(name, i){
      return '<div class="row' + (i === 0 ? ' on' : '') + '">' + esc(name) + '</div>';
    }).join('');
    var bots = COPY.bots.map(function(b){
      return '<div class="row"><img alt="" draggable="false" src="' + mote(b.mote) + '">' + esc(b.name) + '</div>';
    }).join('');
    return '<div class="app" aria-hidden="true">'
      + '<div class="panel p-side side"><div class="h">Chats</div>' + chats + '<div class="h">Bots</div>' + bots + '</div>'
      + '<div class="main"><div class="panel p-msgs msgs">'
      + '<div class="bub me"><i style="width:150px"></i><i style="width:90px"></i></div>'
      + '<div class="bub"><i style="width:240px"></i><i style="width:200px"></i><i style="width:120px"></i></div>'
      + '<div class="bub me"><i style="width:110px"></i></div>'
      + '<div class="bub"><i style="width:210px"></i><i style="width:150px"></i></div>'
      + '</div><div class="panel p-compose compose">Message Mia</div></div></div>';
  }

  // The complete markup for the shadow root. Pure, so it can be tested.
  function markup(){
    var cards = COPY.cards.map(function(c){
      return '<div class="card"><div class="pic"><img alt="" draggable="false" src="' + mote(c.mote) + '"></div>'
        + '<div class="t"><b>' + esc(c.title) + '</b><p>' + esc(c.text) + '</p></div></div>';
    }).join('');
    return '<style>' + CSS + '</style>'
      + '<div class="stage" data-stage role="dialog" aria-modal="true" aria-label="' + esc(COPY.label) + '" aria-describedby="aiIntroLine">'
      + '<div class="dark"></div><canvas id="rain" aria-hidden="true"></canvas>'
      + appHtml()
      + '<div class="ai" aria-hidden="true"><div class="mk" data-mark></div><div class="cards">' + cards + '</div>'
      + '<div class="pill"><span class="ph">' + esc(COPY.placeholder) + '</span><span class="ty">' + esc(COPY.typed) + '</span></div></div>'
      + '<div class="cap" data-caption aria-live="polite"></div>'
      + '<div class="final"><div class="ttl"><h2>' + esc(COPY.title) + '</h2><span class="tag">' + esc(COPY.tag) + '</span></div>'
      + '<p class="line" id="aiIntroLine">' + esc(COPY.line) + '</p><p class="note">' + esc(COPY.note) + '</p>'
      + '<div class="acts"><button type="button" class="btn" data-act="skip-final">' + esc(COPY.later) + '</button>'
      + '<button type="button" class="btn primary" data-act="try">' + esc(COPY.go) + '</button></div></div>'
      + '<button type="button" class="skip" data-act="skip">' + esc(COPY.skip) + '</button>'
      + '</div>';
  }

  function prefersReduced(){
    try{ return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch(_e){ return false; }
  }

  var active = null;

  function play(opts){
    opts = opts || {};
    if(active) return active;
    var reduced = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : prefersReduced();
    var speed = opts.speed > 0 ? opts.speed : 1;
    var parent = opts.parent || document.body;
    var before = document.activeElement;

    var host = document.createElement('div');
    host.setAttribute('data-ai-mode-intro', '');
    var shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = markup();
    parent.appendChild(host);

    var stage = shadow.querySelector('[data-stage]');
    var caption = shadow.querySelector('[data-caption]');
    var skipBtn = shadow.querySelector('[data-act="skip"]');
    var laterBtn = shadow.querySelector('[data-act="skip-final"]');
    var tryBtn = shadow.querySelector('[data-act="try"]');
    var canvas = shadow.querySelector('#rain');
    var timers = [], raf = 0, done = false, atEnd = false, phase = '';

    active = new Promise(function(resolve){
      function setPhase(name){
        phase = name;
        classesFor(name).forEach(function(c){ stage.classList.add(c); });
        caption.textContent = COPY.captions[name] || '';
        if(name === 'dissolve') startRain();
        if(name === 'final'){
          atEnd = true;
          timers.push(setTimeout(function(){ if(!done) tryBtn.focus(); }, 500 / speed));
        }
      }

      function startRain(){
        var ctx = canvas && canvas.getContext && canvas.getContext('2d');
        if(!ctx) return;
        var drops = [], last = 0;
        function frame(t){
          if(done) return;
          if(canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight){
            canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
          }
          var W = canvas.width, H = canvas.height;
          ctx.clearRect(0, 0, W, H);
          if(t - last > 420){ drops.push({x: Math.random(), d: Math.random(), t: t}); last = t; }
          drops = drops.filter(function(p){ return t - p.t < 3000; });
          drops.forEach(function(p){
            var k = (t - p.t) / 3000, sc = 0.25 + 0.75 * p.d;
            var px = p.x * W, py = H * (0.12 + 0.86 * Math.pow(p.d, 1.4));
            for(var r = 0; r < 2; r++){
              var kk = k - r * 0.18; if(kk <= 0) continue;
              var rad = sc * (5 + kk * 70);
              ctx.strokeStyle = 'rgba(255,236,200,' + ((1 - kk) * 0.26 * sc) + ')';
              ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(px, py, rad, rad * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
            }
          });
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);
      }

      function finish(result){
        if(done) return;
        done = true;
        timers.forEach(clearTimeout);
        if(raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        document.removeEventListener('keydown', onKey, true);
        stage.classList.add('leaving');
        setTimeout(function(){
          host.remove();
          active = null;
          try{ if(before && before.focus) before.focus(); }catch(_e){}
          resolve(result);
        }, reduced ? 0 : LEAVE_MS);
      }

      function focusable(){ return atEnd ? [laterBtn, tryBtn] : [skipBtn]; }
      function onKey(event){
        if(event.key === 'Escape'){ event.preventDefault(); event.stopPropagation(); finish('skip'); return; }
        if(event.key === 'Tab'){
          var list = focusable(), cur = shadow.activeElement;
          var i = list.indexOf(cur);
          var n = event.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
          event.preventDefault();
          list[n].focus();
        }
      }

      skipBtn.addEventListener('click', function(){ finish('skip'); });
      laterBtn.addEventListener('click', function(){ finish('skip'); });
      tryBtn.addEventListener('click', function(){ finish('try'); });
      document.addEventListener('keydown', onKey, true);

      var mk = shadow.querySelector('[data-mark]');
      try{ if(root.MiaMark && mk) root.MiaMark.render(mk, 72, ''); }catch(_e){}

      stage.classList.add('on');
      if(reduced){
        stage.classList.add('still');
        setPhase('final');
        tryBtn.focus();
      }else{
        skipBtn.focus();
        STEPS.forEach(function(step){
          timers.push(setTimeout(function(){ setPhase(step.phase); }, step.at / speed));
        });
      }
    });
    return active;
  }

  return {play: play, markup: markup, classesFor: classesFor, COPY: COPY, STEPS: STEPS, TOTAL_MS: TOTAL_MS};
});
