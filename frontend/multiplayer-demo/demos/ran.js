// Adds a "Ran with" chip under each bot reply: a random provider (Grok, Claude or ChatGPT) per bot, per page load.
// The <script data-who> attribute names whose Mia ran it ("my" by default).
(function(){
  var LOGOS = {"Grok": "<svg viewBox=\"0 0 24 24\" width=\"12\" height=\"12\" aria-hidden=\"true\" fill=\"currentColor\"><path d=\"M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z\"/></svg>", "Claude": "<svg viewBox=\"0 0 24 24\" width=\"14\" height=\"14\" aria-hidden=\"true\" fill=\"#D97757\"><path d=\"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z\"/></svg>", "ChatGPT": "<svg viewBox=\"116 116 489 489\" width=\"14\" height=\"14\" aria-hidden=\"true\"><path d=\"M304.246 294.611V249.028C304.246 245.189 305.687 242.309 309.044 240.392L400.692 187.612C413.167 180.415 428.042 177.058 443.394 177.058C500.971 177.058 537.44 221.682 537.44 269.182C537.44 272.54 537.44 276.379 536.959 280.218L441.954 224.558C436.197 221.201 430.437 221.201 424.68 224.558L304.246 294.611ZM518.245 472.145V363.224C518.245 356.505 515.364 351.707 509.608 348.349L389.174 278.296L428.519 255.743C431.877 253.826 434.757 253.826 438.115 255.743L529.762 308.523C556.154 323.879 573.905 356.505 573.905 388.171C573.905 424.636 552.315 458.225 518.245 472.141V472.145ZM275.937 376.182L236.592 353.152C233.235 351.235 231.794 348.354 231.794 344.515V238.956C231.794 187.617 271.139 148.749 324.4 148.749C344.555 148.749 363.264 155.468 379.102 167.463L284.578 222.164C278.822 225.521 275.942 230.319 275.942 237.039V376.186L275.937 376.182ZM360.626 425.122L304.246 393.455V326.283L360.626 294.616L417.002 326.283V393.455L360.626 425.122ZM396.852 570.989C376.698 570.989 357.989 564.27 342.151 552.276L436.674 497.574C442.431 494.217 445.311 489.419 445.311 482.699V343.552L485.138 366.582C488.495 368.499 489.936 371.379 489.936 375.219V480.778C489.936 532.117 450.109 570.985 396.852 570.985V570.989ZM283.134 463.99L191.486 411.211C165.094 395.854 147.343 363.229 147.343 331.562C147.343 294.616 169.415 261.509 203.48 247.593V356.991C203.48 363.71 206.361 368.508 212.117 371.866L332.074 441.437L292.729 463.99C289.372 465.907 286.491 465.907 283.134 463.99ZM277.859 542.68C223.639 542.68 183.813 501.895 183.813 451.514C183.813 447.675 184.294 443.836 184.771 439.997L279.295 494.698C285.051 498.056 290.812 498.056 296.568 494.698L417.002 425.127V470.71C417.002 474.549 415.562 477.429 412.204 479.346L320.557 532.126C308.081 539.323 293.206 542.68 277.854 542.68H277.859ZM396.852 599.776C454.911 599.776 503.37 558.513 514.41 503.812C568.149 489.896 602.696 439.515 602.696 388.176C602.696 354.587 588.303 321.962 562.392 298.45C564.791 288.373 566.231 278.296 566.231 268.224C566.231 199.611 510.571 148.267 446.274 148.267C433.322 148.267 420.846 150.184 408.37 154.505C386.775 133.392 357.026 119.958 324.4 119.958C266.342 119.958 217.883 161.22 206.843 215.921C153.104 229.837 118.557 280.218 118.557 331.557C118.557 365.146 132.95 397.771 158.861 421.283C156.462 431.36 155.022 441.437 155.022 451.51C155.022 520.123 210.682 571.466 274.978 571.466C287.931 571.466 300.407 569.549 312.883 565.228C334.473 586.341 364.222 599.776 396.852 599.776Z\" fill=\"currentColor\"/></svg>"};
  var me = document.currentScript, who = (me && me.getAttribute('data-who')) || 'my';
  var where = who === 'my' ? 'my Mia' : who + '\u2019s Mia';
  var css = document.createElement('style');
  css.textContent = '.demo-ran{display:inline-flex;align-self:flex-start;width:max-content;max-width:100%;align-items:center;gap:7px;margin-top:6px;padding:5px 12px 5px 5px;border:1px solid var(--sand-border-subtle,#e6e2dc);border-radius:999px;font:500 13px/1 var(--styled-sans,inherit);color:var(--sand-text-secondary,#6b6560);background:var(--paper,#fff);box-shadow:0 1px 2px rgba(0,0,0,.05);}'
    + '.demo-ran b{color:var(--sand-text-primary,#111);font-weight:600;}'
    + '.demo-ran-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#f3f1ee;color:#111;}'
    + '.demo-ran-mark svg{width:15px;height:15px;}'
    + '.demo-ran.pop{animation:ranPop .6s cubic-bezier(.2,.9,.3,1.4) both;}'
    + '@keyframes ranPop{0%{transform:scale(.6);opacity:0;}100%{transform:none;opacity:1;}}'
    + '@media (prefers-reduced-motion: reduce){.demo-ran.pop{animation:none;}}';
  document.head.appendChild(css);
  var names = Object.keys(LOGOS), pick = {}, used = [];
  function provider(bot){
    if (!pick[bot]){
      var free = names.filter(function(n){ return used.indexOf(n) < 0; });
      pick[bot] = (free.length ? free : names)[Math.floor(Math.random() * (free.length || names.length))];
      used.push(pick[bot]);
    }
    return pick[bot];
  }
  // If a bot names its provider in the reply ("with her Claude"), match it to the chip before it paints.
  function botName(row){
    if (!row.querySelector('.chat-msg-mark .mote-avatar-img, .chat-msg-mark .mia-avatar-mark')) return null;
    return (((row.querySelector('.chat-msg-name') || {}).textContent) || 'bot').trim();
  }
  new MutationObserver(function(muts){
    muts.forEach(function(m){ m.addedNodes.forEach(function(n){
      if (n.nodeType !== 1) return;
      var row = n.closest('.chat-msg-row') || (n.querySelector && n.querySelector('.chat-msg-row')), bot = row && botName(row);
      if (!bot) return;
      var w = document.createTreeWalker(row.querySelector('.chat-msg-text') || row, NodeFilter.SHOW_TEXT), t;
      while ((t = w.nextNode())) if (/\b(Claude|Grok|ChatGPT)\b/.test(t.nodeValue)) t.nodeValue = t.nodeValue.replace(/\b(Claude|Grok|ChatGPT)\b/g, provider(bot));
    }); });
  }).observe(document.documentElement, {childList: true, subtree: true});
  // A reply gets its chip once it has finished appearing: nothing hidden, and the same text for a moment.
  var seen = new WeakMap();
  setInterval(function(){
    document.querySelectorAll('.chat-msg-row').forEach(function(row){
      if (row.querySelector('.demo-ran') || !row.querySelector('.chat-msg-mark .mote-avatar-img, .chat-msg-mark .mia-avatar-mark')) return;
      var body = row.querySelector('.chat-msg-body'), text = row.querySelector('.chat-msg-text');
      if (!body || !text || row.querySelector('.demo-hide, .chat-thinking-shimmer') || !row.offsetParent) return;
      var sig = text.textContent.length + ':' + text.children.length, s = seen.get(row);
      if (!s || s.sig !== sig){ seen.set(row, {sig: sig, t: Date.now()}); return; }
      if (Date.now() - s.t < 700) return;
      var name = botName(row), p = provider(name);
      var next = row.nextElementSibling; if (next && next.classList.contains('chat-msg-row') && botName(next) === name) return;
      var chip = document.createElement('div');
      chip.className = 'demo-ran pop';
      var owner = row.getAttribute('data-ran-who'), on = owner ? owner + '\u2019s Mia' : where;
      chip.innerHTML = '<span class="demo-ran-mark">' + LOGOS[p] + '</span><b>' + p + '</b><span>\u00b7 Ran on ' + on + '</span>';
      body.appendChild(chip);
      // One chip per turn: drop it from this bot's earlier messages in the same run of replies.
      for (var prev = row.previousElementSibling; prev && prev.classList.contains('chat-msg-row'); prev = prev.previousElementSibling){
        if (botName(prev) !== name) break;
        var old = prev.querySelector('.demo-ran'); if (old) old.remove();
      }
      var log = document.getElementById('chatThread'); if (log) log.scrollTop = log.scrollHeight;
    });
  }, 250);
})();
