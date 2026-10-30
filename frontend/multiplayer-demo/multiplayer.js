/* Mia Multiplayer Demo (from the browser mockup kept outside the repo).
   Everything here is local and scripted: the teammates, bots, pages and
   messages are fake, nothing is fetched, and nothing typed leaves the page.
   One shared tab, streamed to everyone. Humans are players with game-style
   cursors (you are always P1 blue); bots are Motes that work on the page at
   the same time, ringed in their owner's player color. The other players and
   bots here are scripted so the demo runs on its own; you can edit the page
   and chat for real. */
(function () {
  'use strict';

  var MOTE_SRC = '../assets/mote/mote.svg';
  var MOTE_BASE_HUE = 337; // mote.svg is the pink "inbox" plate

  var PLAYERS = {
    you: { name: 'You', short: 'YO', num: 1, color: '#1084fe' },
    ana: { name: 'Ana', short: 'AN', num: 2, color: '#ff263c' },
    diego: { name: 'Diego', short: 'DG', num: 3, color: '#f5b400', dark: true },
    sam: { name: 'Sam', short: 'SM', num: 4, color: '#9159fe' }
  };
  // Body hue = the bot's job. Ring = its owner's player color.
  var BOTS = {
    mia: { name: 'Mia', job: 'General', owner: 'you', hue: 337, color: '#e9407f', ink: '#b8245c' },
    lex: { name: 'Lex', job: 'Legal', owner: 'you', hue: 170, color: '#12a58a', ink: '#0b6e5b' },
    pixel: { name: 'Pixel', job: 'Design', owner: 'you', hue: 110, color: '#4f9a2f', ink: '#35701c' },
    ledger: { name: 'Ledger', job: 'Finance', owner: 'ana', hue: 212, color: '#2f7fd8', ink: '#1c5aa3' },
    scout: { name: 'Scout', job: 'Research', owner: 'diego', hue: 272, color: '#8a4be0', ink: '#6331ad' }
  };

  var $ = function (id) { return document.getElementById(id); };
  var screen = $('screen'), page = $('page'), layer = $('layer'), msgs = $('msgs');

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function setVars(node, vars) {
    Object.keys(vars).forEach(function (k) { node.style.setProperty(k, vars[k]); });
    return node;
  }
  function moteEl(botId) {
    var bot = BOTS[botId];
    var wrap = setVars(h('span', 'mp-mote'), { '--owner': PLAYERS[bot.owner].color });
    var img = h('img');
    img.src = MOTE_SRC; img.alt = ''; img.draggable = false;
    var rot = ((bot.hue - MOTE_BASE_HUE + 540) % 360) - 180;
    if (rot) img.style.filter = 'hue-rotate(' + rot + 'deg) saturate(1.08)';
    wrap.appendChild(img);
    wrap.title = bot.name + ' · ' + PLAYERS[bot.owner].name + "'s " + bot.job.toLowerCase() + ' bot';
    return wrap;
  }

  /* ---------- run control ---------- */
  var STOP = { stopped: true };
  var PACE = 1.25; // >1 slows the scripted players down
  var run = { token: 0, paused: false };
  function waitFor(ms, token) {
    return new Promise(function (resolve, reject) {
      var left = ms * PACE, last = Date.now();
      (function tick() {
        if (token !== run.token) return reject(STOP);
        var now = Date.now();
        if (!run.paused) left -= now - last;
        last = now;
        if (left <= 0) return resolve();
        setTimeout(tick, Math.min(40, left));
      })();
    });
  }

  /* ---------- geometry ---------- */
  function rectOf(target) {
    var list = Array.isArray(target) ? target : [target];
    var s = screen.getBoundingClientRect();
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    list.forEach(function (node) {
      if (!node) return;
      var r = node.getBoundingClientRect();
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
      x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    });
    return { x: x1 - s.left, y: y1 - s.top, w: x2 - x1, h: y2 - y1, sw: s.width, sh: s.height };
  }
  function place(node, x, y) { node.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)'; }

  /* ---------- actors on the shared page ---------- */
  var actors = { cursors: {}, sels: {}, bots: {} };

  function cursorNode(pid) {
    if (actors.cursors[pid]) return actors.cursors[pid];
    var p = PLAYERS[pid];
    var node = setVars(h('div', 'mp-cursor'), { '--c': p.color });
    node.innerHTML = '<svg viewBox="0 0 18 22"><path d="M1.5 1.5v16.2l4.4-4.1 2.9 6.6 3-1.3-2.9-6.5 6-.4z"/></svg>';
    node.appendChild(h('span', 'mp-cursor-tag' + (p.dark ? ' dark' : ''), p.name));
    place(node, rectOf(page).sw * 0.5, -40);
    layer.appendChild(node);
    actors.cursors[pid] = { node: node, target: null };
    return actors.cursors[pid];
  }
  function positionCursor(c) {
    if (!c.target) return;
    var r = rectOf(c.target);
    place(c.node, r.x + r.w * c.fx, r.y + r.h * c.fy);
  }
  function positionSel(s) {
    if (!s.target) return;
    var r = rectOf(s.target);
    place(s.node, r.x - 1, r.y - 1);
    s.node.style.width = (r.w + 2) + 'px'; s.node.style.height = (r.h + 2) + 'px';
  }
  function positionBot(b) {
    if (!b.target) return;
    var r = rectOf(b.target);
    place(b.range, r.x - 4, r.y - 4);
    b.range.style.width = (r.w + 8) + 'px'; b.range.style.height = (r.h + 8) + 'px';
    var mx = r.x + r.w - 14, my = r.y - 22;
    b.node.classList.toggle('left', b.side === 'left' || mx > r.sw - 260);
    if (my < 4) my = r.y + r.h - 8;
    place(b.node, mx, my);
  }
  function repositionAll() {
    Object.keys(actors.cursors).forEach(function (k) { positionCursor(actors.cursors[k]); });
    Object.keys(actors.sels).forEach(function (k) { positionSel(actors.sels[k]); });
    Object.keys(actors.bots).forEach(function (k) { positionBot(actors.bots[k]); });
    if (current && current.layout) current.layout();
  }
  function clearActors() {
    layer.replaceChildren();
    actors = { cursors: {}, sels: {}, bots: {} };
  }

  // The script API a tab uses. Every call checks the run token, so switching
  // tabs or restarting stops the old script cleanly.
  function makeKit(token) {
    var k = {
      wait: function (ms) { return waitFor(ms, token); },
      move: function (pid, target, fx, fy) {
        var c = cursorNode(pid);
        c.target = target; c.fx = fx === undefined ? 0.62 : fx; c.fy = fy === undefined ? 0.6 : fy;
        positionCursor(c);
        return k.wait(780);
      },
      select: function (pid, target) {
        var s = actors.sels[pid];
        if (!s) {
          s = actors.sels[pid] = { node: setVars(h('div', 'mp-sel'), { '--c': PLAYERS[pid].color }) };
          layer.appendChild(s.node);
        }
        s.target = target; s.node.style.opacity = '1';
        positionSel(s);
      },
      unselect: function (pid) {
        var s = actors.sels[pid];
        if (s) { s.target = null; s.node.style.opacity = '0'; }
      },
      typing: function (pid, on) { cursorNode(pid).node.classList.toggle('typing', !!on); },
      // side 'left' puts the status chip left of the Mote, for spots where
      // the right side is busy (doc margin cards, a neighbouring bot).
      bot: function (botId, target, label, side) {
        var b = actors.bots[botId];
        var bot = BOTS[botId];
        if (!b) {
          var node = setVars(h('div', 'mp-bot'), { '--c': bot.color, '--owner': PLAYERS[bot.owner].color });
          node.appendChild(moteEl(botId));
          var chip = h('div', 'mp-bot-chip');
          chip.appendChild(h('span', 'mp-spin'));
          chip.appendChild(h('b', null, bot.name));
          chip.appendChild(h('span', 'mp-bot-label', ''));
          node.appendChild(chip);
          var range = setVars(h('div', 'mp-range'), { '--c': bot.color });
          layer.appendChild(range); layer.appendChild(node);
          var r0 = rectOf(target);
          place(node, r0.sw - 60, -50);
          b = actors.bots[botId] = { node: node, range: range };
        }
        b.target = target; b.side = side || null;
        b.node.classList.remove('idle', 'gone'); b.range.classList.remove('done');
        clearTimeout(b.leave);
        b.node.querySelector('.mp-bot-label').textContent = label;
        positionBot(b);
        return k.wait(950);
      },
      botLabel: function (botId, label) {
        var b = actors.bots[botId];
        if (b) b.node.querySelector('.mp-bot-label').textContent = label;
      },
      // stay=true keeps the Mote on the page, e.g. while a suggestion
      // waits for a human; otherwise it drifts off after a moment.
      botDone: function (botId, label, stay) {
        var b = actors.bots[botId];
        if (!b) return;
        b.node.classList.add('idle'); b.range.classList.add('done');
        if (label) b.node.querySelector('.mp-bot-label').textContent = label;
        clearTimeout(b.leave);
        if (!stay) b.leave = setTimeout(function () { b.node.classList.add('gone'); }, 2600 * PACE);
      },
      type: function (node, text, speed, onChar) {
        var i = 0;
        speed = speed || 70;
        function step() {
          if (i >= text.length) return Promise.resolve();
          node.textContent += text.charAt(i++);
          if (onChar) onChar();
          return k.wait(speed + Math.random() * speed * 0.6).then(step);
        }
        return step();
      },
      say: function (who, text, opts) { return say(who, text, opts); }
    };
    return k;
  }

  /* ---------- room chat ---------- */
  function authorOf(who) {
    if (PLAYERS[who]) return { name: PLAYERS[who].name, sub: 'P' + PLAYERS[who].num, player: who };
    if (BOTS[who]) return { name: BOTS[who].name, sub: PLAYERS[BOTS[who].owner].name + "'s " + BOTS[who].job.toLowerCase() + ' bot', bot: who };
    return { name: 'Mia', sub: '' };
  }
  function fillText(node, text) {
    node.replaceChildren();
    String(text).split(/(@\w+)/).forEach(function (part) {
      if (!part) return;
      if (/^@\w+$/.test(part)) node.appendChild(h('span', 'at', part));
      else node.appendChild(document.createTextNode(part));
    });
  }
  function say(who, text, opts) {
    opts = opts || {};
    if (who === 'system') {
      var s = h('div', 'mp-msg sys');
      s.appendChild(h('div', 'mp-msg-text', text));
      msgs.appendChild(s); msgs.scrollTop = msgs.scrollHeight;
      return s;
    }
    var a = authorOf(who);
    var row = h('div', 'mp-msg' + (opts.working ? ' working' : ''));
    var av;
    if (a.bot) { av = moteEl(a.bot); av.classList.add('mp-msg-av'); setVars(row, { '--c': BOTS[a.bot].color }); }
    else { av = setVars(h('div', 'mp-msg-av', PLAYERS[a.player].short), { '--c': PLAYERS[a.player].color }); }
    row.appendChild(av);
    var body = h('div', 'mp-msg-body');
    var whoLine = h('div', 'mp-msg-who', a.name);
    whoLine.appendChild(h('small', null, a.sub));
    body.appendChild(whoLine);
    var t = h('div', 'mp-msg-text');
    fillText(t, text);
    body.appendChild(t);
    row.appendChild(body);
    row.resolve = function (finalText) { row.classList.remove('working'); fillText(t, finalText); msgs.scrollTop = msgs.scrollHeight; };
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  /* ---------- sheet: Q4 budget ---------- */
  var COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  var COL_W = [150, 96, 96, 96, 76, null, 64]; // F (notes) takes the rest
  var SHEET_ROWS = 22;
  function num(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; }
  function fmt(n, signed) {
    var s = Math.abs(Math.round(n)).toLocaleString('en-US');
    if (!signed) return (n < 0 ? '-' : '') + s;
    return n > 0 ? '+' + s : n < 0 ? '-' + s : '0';
  }

  function renderSheet() {
    var root = h('div', 'sh');
    var menu = h('div', 'sh-menu');
    ['File', 'Edit', 'View', 'Insert', 'Format', 'Data', 'Tools', 'Extensions'].forEach(function (m) { menu.appendChild(h('span', null, m)); });
    root.appendChild(h('div', 'sh-title', 'Q4 budget'));
    root.appendChild(menu);
    var fx = h('div', 'sh-fx');
    var addr = h('div', 'sh-addr', 'A1'); fx.appendChild(addr); fx.appendChild(h('i', null, 'fx'));
    var fxval = h('div', 'sh-fxval', 'Line'); fx.appendChild(fxval);
    root.appendChild(fx);
    var wrap = h('div', 'sh-wrap');
    var table = h('table', 'sh-grid');
    var colgroup = h('colgroup');
    var c0 = h('col'); c0.style.width = '46px'; colgroup.appendChild(c0);
    COL_W.forEach(function (w) { var c = h('col'); if (w) c.style.width = w + 'px'; colgroup.appendChild(c); });
    table.appendChild(colgroup);
    var hr = h('tr'); hr.appendChild(h('th', 'rh', ''));
    COLS.forEach(function (c) { hr.appendChild(h('th', null, c)); });
    table.appendChild(hr);
    var cells = {};
    var data = {
      1: ['Line', 'Q3 actual', 'Q4 plan', 'Q4 vs Q3', 'Owner', 'Notes'],
      2: ['Design', '', '1,200', '', 'Ana', ''],
      3: ['Engineering', '', '4,800', '', 'You', ''],
      4: ['Marketing', '', '2,000', '', 'Diego', ''],
      5: ['Infrastructure', '', '650', '', 'Sam', ''],
      6: ['Contingency', '', '900', '', 'You', ''],
      9: ['Total', '', '', '', '', '']
    };
    for (var r = 1; r <= SHEET_ROWS; r++) {
      var tr = h('tr');
      tr.appendChild(h('th', 'rh', String(r)));
      COLS.forEach(function (c, ci) {
        var td = h('td');
        var v = data[r] ? data[r][ci] : '';
        td.textContent = v || '';
        td.dataset.addr = c + r;
        if (r === 1) td.classList.add('head');
        if (r === 9) td.classList.add('total');
        if ((c === 'B' || c === 'C' || c === 'D') && r > 1) td.classList.add('num');
        if (c === 'F') td.classList.add('note');
        if (r > 1 && c !== 'D' && r !== 9) td.contentEditable = 'true';
        td.spellcheck = false;
        cells[c + r] = td;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    root.appendChild(wrap);
    var tabsBar = h('div', 'sh-sheets');
    tabsBar.appendChild(h('span', 'on', 'Q4 budget'));
    tabsBar.appendChild(h('span', null, 'Q3 invoices'));
    tabsBar.appendChild(h('span', null, 'Headcount'));
    root.appendChild(tabsBar);
    page.replaceChildren(root);

    function recompute() {
      var tb = 0, tc = 0, td = 0, any = false;
      for (var r = 2; r <= 8; r++) {
        var b = num(cells['B' + r].textContent), c = num(cells['C' + r].textContent);
        var d = cells['D' + r];
        d.classList.remove('pos', 'neg');
        if (b !== null && c !== null) {
          var diff = c - b;
          d.textContent = fmt(diff, true);
          d.classList.add(diff >= 0 ? 'pos' : 'neg');
          td += diff;
        } else d.textContent = '';
        if (b !== null) { tb += b; any = true; }
        if (c !== null) tc += c;
      }
      cells.B9.textContent = any ? fmt(tb) : '';
      cells.C9.textContent = fmt(tc);
      cells.D9.textContent = any ? fmt(td, true) : '';
      cells.D9.classList.toggle('neg', any && td < 0);
      cells.D9.classList.toggle('pos', any && td >= 0);
    }
    recompute();

    function showFx(td) {
      addr.textContent = td.dataset.addr;
      var a = td.dataset.addr;
      if (a.charAt(0) === 'D' && a !== 'D1') fxval.textContent = a === 'D9' ? '=SUM(D2:D8)' : '=C' + a.slice(1) + '-B' + a.slice(1);
      else if (/^[BC]9$/.test(a)) fxval.textContent = '=SUM(' + a.charAt(0) + '2:' + a.charAt(0) + '8)';
      else fxval.textContent = td.textContent;
    }
    table.addEventListener('focusin', function (e) {
      var td = e.target.closest('td'); if (!td) return;
      table.querySelectorAll('td.mine').forEach(function (n) { n.classList.remove('mine'); });
      td.classList.add('mine'); showFx(td);
    });
    table.addEventListener('mousedown', function (e) {
      var td = e.target.closest('td'); if (!td || td.isContentEditable) return;
      table.querySelectorAll('td.mine').forEach(function (n) { n.classList.remove('mine'); });
      td.classList.add('mine'); showFx(td);
    });
    table.addEventListener('input', function (e) { recompute(); var td = e.target.closest('td'); if (td) showFx(td); });
    table.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    return { cells: cells, recompute: recompute };
  }

  function sheetScript(k, S) {
    var cells = S.cells;
    function flash(td) { td.classList.remove('flash'); void td.offsetWidth; td.classList.add('flash'); }
    function typeCell(pid, td, text, speed) {
      td.textContent = '';
      if (pid) k.typing(pid, true);
      return k.type(td, text, speed || 85, S.recompute).then(function () {
        if (pid) k.typing(pid, false);
        flash(td); S.recompute();
      });
    }

    var ledger = function () {
      var working;
      return k.wait(1400)
        .then(function () { working = k.say('ledger', 'Reading 42 invoices in "Q3 invoices"…', { working: true }); return k.bot('ledger', [cells.B2, cells.B6], 'reading Q3 invoices'); })
        .then(function () { return k.wait(1600); })
        .then(function () { k.botLabel('ledger', 'filling Q3 actuals'); })
        .then(function () { return typeCell(null, cells.B2, '1,140', 70); })
        .then(function () { return typeCell(null, cells.B3, '5,230', 70); })
        .then(function () { return typeCell(null, cells.B4, '1,870', 70); })
        .then(function () { return typeCell(null, cells.B5, '710', 70); })
        .then(function () { return typeCell(null, cells.B6, '420', 70); })
        .then(function () {
          k.botDone('ledger', 'done');
          working.resolve('Filled Q3 actuals in B2:B6 from 42 invoices. Engineering and Infrastructure ran over what Q4 plans for them.');
        });
    };

    var mia = function () {
      var working;
      return k.wait(9800)
        .then(function () { working = k.say('mia', 'Checking Q4 plan against Q3 actuals…', { working: true }); return k.bot('mia', cells.F3, 'writing a note'); })
        .then(function () { return typeCell(null, cells.F3, 'Q4 is 8% under Q3 run-rate. Hiring freeze?', 45); })
        .then(function () { return k.bot('mia', cells.F5, 'writing a note'); })
        .then(function () { return typeCell(null, cells.F5, 'Q3 over by $60: GPU burst in August.', 45); })
        .then(function () {
          k.botDone('mia', 'done');
          working.resolve('Flagged the two lines where Q4 plan is below Q3 actual: Engineering (F3) and Infrastructure (F5).');
        });
    };

    var scout = function () {
      var working;
      return k.wait(15500)
        .then(function () { working = k.say('scout', 'Looking up marketing spend at similar companies…', { working: true }); return k.bot('scout', cells.F4, 'researching peers'); })
        .then(function () { return k.wait(1800); })
        .then(function () { return typeCell(null, cells.F4, 'Peers spend ~18% of budget here; we are at 21%.', 40); })
        .then(function () { k.botDone('scout', 'done'); working.resolve('Added a benchmark to F4. Sources are in the thread.'); });
    };

    var ana = function () {
      return k.wait(600)
        .then(function () { return k.move('ana', cells.C2); })
        .then(function () { k.select('ana', cells.C2); return k.wait(900); })
        .then(function () { return k.move('ana', cells.B2, 0.3); })
        .then(function () { k.select('ana', [cells.B2, cells.B6]); return k.wait(2600); })
        .then(function () { return k.move('ana', cells.D3, 0.4); })
        .then(function () { k.select('ana', cells.D3); return k.wait(7000); })
        .then(function () { return k.move('ana', cells.C3); })
        .then(function () { k.select('ana', cells.C3); return k.wait(500); })
        .then(function () { return typeCell('ana', cells.C3, '5,100'); })
        .then(function () { k.say('ana', 'Bumped Engineering to 5,100 so we are not cutting below Q3.'); return k.wait(1500); })
        .then(function () { return k.move('ana', cells.D9, 0.5); })
        .then(function () { k.select('ana', cells.D9); });
    };

    var diego = function () {
      return k.wait(2200)
        .then(function () { return k.move('diego', cells.A7, 0.3); })
        .then(function () { k.select('diego', cells.A7); return k.wait(700); })
        .then(function () { return typeCell('diego', cells.A7, 'Contractors'); })
        .then(function () { return k.move('diego', cells.C7, 0.4); })
        .then(function () { k.select('diego', cells.C7); return typeCell('diego', cells.C7, '1,500'); })
        .then(function () { return k.move('diego', cells.E7, 0.4); })
        .then(function () { k.select('diego', cells.E7); return typeCell('diego', cells.E7, 'Diego'); })
        .then(function () { k.say('diego', 'Added a Contractors line for the Q4 launch push. @Scout can you benchmark our marketing spend?'); return k.wait(1400); })
        .then(function () { return k.move('diego', cells.F4, 0.2, 0.5); })
        .then(function () { k.unselect('diego'); });
    };

    var sam = function () {
      return k.wait(4200)
        .then(function () { return k.move('sam', cells.E5); })
        .then(function () { return k.wait(2600); })
        .then(function () { return k.move('sam', cells.C9); })
        .then(function () { k.select('sam', [cells.B9, cells.D9]); return k.wait(11000); })
        .then(function () { k.say('sam', 'Totals update as you all type. Looks right to me.'); return k.move('sam', cells.G11); })
        .then(function () { k.unselect('sam'); });
    };

    return Promise.all([ledger(), mia(), scout(), ana(), diego(), sam()]);
  }

  /* ---------- doc: services contract ---------- */
  function renderDoc() {
    var root = h('div', 'dc');
    var pg = h('article', 'dc-page');
    pg.contentEditable = 'true'; pg.spellcheck = false;
    pg.appendChild(h('h1', null, 'Master services agreement'));
    pg.appendChild(h('p', 'dc-sub', 'Mia Labs, Inc. and Acme Corp. · Draft 3'));
    var refs = {};
    function section(title, parts) {
      pg.appendChild(h('h2', null, title));
      var p = h('p');
      parts.forEach(function (part) {
        if (typeof part === 'string') p.appendChild(document.createTextNode(part));
        else { var s = h('span', null, part.text); refs[part.ref] = s; p.appendChild(s); }
      });
      pg.appendChild(p);
      return p;
    }
    refs.s1 = section('1. Services', ['Mia Labs will provide hosted agent workspaces, onboarding for up to 40 seats, and email support as described in Order Form 1.']);
    refs.s2 = section('2. Fees and payment', ['Acme will pay $24,000 per quarter, invoiced in advance. Invoices are due within ', { ref: 'net', text: '30' }, ' days of the invoice date. Late amounts accrue interest at 1% per month.']);
    refs.s3 = section('3. Limitation of liability', [{ ref: 'liab', text: "Neither party's liability under this agreement is limited." }, ' Neither party is liable for indirect or consequential damages.']);
    refs.s4 = section('4. Confidentiality', ["Each party will protect the other's confidential information with at least reasonable care and use it only to perform this agreement."]);
    refs.s5 = section('5. Term and termination', ['This agreement starts on the effective date and lasts two years. It renews for one-year terms unless either party gives ', { ref: 'notice', text: '60' }, " days' notice."]);
    root.appendChild(pg);
    var margin = h('aside', 'dc-margin');
    root.appendChild(margin);
    page.replaceChildren(root);
    refs.page = pg; refs.margin = margin;
    return refs;
  }

  // A bot's change arrives as a suggestion (strike + insert) with a margin
  // card; a human accepts or rejects it.
  function suggestion(refs, botId, anchorSpan) {
    var bot = BOTS[botId];
    var del = anchorSpan;
    del.classList.add('dc-del'); setVars(del, { '--c': bot.color });
    var ins = setVars(h('span', 'dc-ins', ''), { '--c': bot.color, '--c-ink': bot.ink });
    del.after(document.createTextNode(' '), ins);
    var card = setVars(h('div', 'dc-card'), { '--c': bot.color });
    var head = h('div', 'dc-card-head');
    head.appendChild(moteEl(botId));
    head.appendChild(h('b', null, bot.name));
    head.appendChild(h('small', null, PLAYERS[bot.owner].name + "'s bot"));
    card.appendChild(head);
    var body = h('p');
    card.appendChild(body);
    var actions = h('div', 'dc-card-actions');
    var accept = h('button', 'primary', 'Accept'); accept.type = 'button';
    var reject = h('button', null, 'Reject'); reject.type = 'button';
    actions.appendChild(accept); actions.appendChild(reject);
    card.appendChild(actions);
    refs.margin.appendChild(card);
    var sugg = { del: del, ins: ins, card: card, body: body, accept: accept, reject: reject, anchor: del, done: false };
    function settle(ok, by) {
      if (sugg.done) return;
      sugg.done = true;
      // Layout is: del, ' ', ins. Keep one side and drop the joining space.
      ins.previousSibling.remove();
      if (ok) { del.remove(); ins.className = ''; } else { ins.remove(); del.className = ''; }
      actions.replaceWith(h('div', 'dc-card-done', (ok ? 'Accepted' : 'Rejected') + ' by ' + (by === 'you' ? 'you' : PLAYERS[by].name)));
      sugg.anchor = ok ? ins : del;
      layoutCards(refs);
      if (refs.kit) refs.kit.botDone(botId, ok ? 'accepted' : 'rejected');
    }
    accept.addEventListener('click', function () { settle(true, 'you'); });
    reject.addEventListener('click', function () { settle(false, 'you'); });
    sugg.settle = settle;
    (refs.suggs = refs.suggs || []).push(sugg);
    return sugg;
  }
  function layoutCards(refs) {
    if (!refs.suggs) return;
    var base = refs.margin.getBoundingClientRect().top;
    var floor = 0;
    refs.suggs.map(function (s) { return { s: s, y: s.anchor.getBoundingClientRect().top - base - 8 }; })
      .sort(function (a, b) { return a.y - b.y; })
      .forEach(function (item) {
      var s = item.s;
      var top = Math.max(floor, item.y);
      s.card.style.top = top + 'px';
      floor = top + s.card.offsetHeight + 10;
    });
  }

  function docScript(k, D) {
    D.kit = k;
    var lex = function () {
      var working, sg;
      return k.wait(1600)
        .then(function () { working = k.say('lex', 'Reviewing the draft for risky terms…', { working: true }); return k.bot('lex', D.s3, 'reviewing liability', 'left'); })
        .then(function () { return k.wait(2200); })
        .then(function () {
          sg = suggestion(D, 'lex', D.liab);
          layoutCards(D);
          k.botLabel('lex', 'redlining section 3');
          return k.type(sg.ins, "Each party's total liability is capped at the fees paid in the 12 months before the claim.", 32);
        })
        .then(function () {
          sg.body.textContent = 'Unlimited liability is the biggest risk in this draft. A 12-month fee cap is standard for SaaS deals.';
          sg.card.classList.add('in'); layoutCards(D);
          k.botDone('lex', 'waiting for a human', true);
          working.resolve('Proposed a liability cap in section 3. It needs a human to accept it.');
        });
    };
    var ledger = function () {
      var working, sg;
      return k.wait(5200)
        .then(function () { working = k.say('ledger', "Comparing payment terms with Acme's AP cycle…", { working: true }); return k.bot('ledger', D.s2, 'checking payment terms', 'left'); })
        .then(function () { return k.wait(1800); })
        .then(function () {
          sg = suggestion(D, 'ledger', D.net);
          layoutCards(D);
          k.botLabel('ledger', 'suggesting net 45');
          return k.type(sg.ins, '45', 140);
        })
        .then(function () {
          sg.body.textContent = 'Acme pays suppliers on net 45. Matching it avoids late notices; it costs us about $1.2k in float a year.';
          sg.card.classList.add('in'); layoutCards(D);
          k.botDone('ledger', 'waiting for a human', true);
          working.resolve('Suggested net 45 in section 2.');
          D.ledgerSugg = sg;
        });
    };
    var ana = function () {
      return k.wait(900)
        .then(function () { return k.move('ana', D.notice, 0.5, 0.6); })
        .then(function () {
          D.notice.classList.add('dc-hl'); setVars(D.notice, { '--c': PLAYERS.ana.color });
          return k.wait(900);
        })
        .then(function () {
          k.typing('ana', true);
          D.notice.textContent = '';
          return k.type(D.notice, '90', 180);
        })
        .then(function () {
          k.typing('ana', false);
          D.notice.classList.remove('dc-hl');
          k.say('ana', "Changed notice to 90 days. Acme's procurement asked for it.");
          return k.wait(7000);
        })
        .then(function () { return D.ledgerSugg ? k.move('ana', D.ledgerSugg.accept, 0.5, 0.6) : null; })
        .then(function () { return k.wait(900); })
        .then(function () {
          if (D.ledgerSugg) D.ledgerSugg.settle(true, 'ana');
          k.say('ana', 'Accepted net 45. The liability cap from Lex is yours to call.');
          return k.wait(800);
        })
        .then(function () { return k.move('ana', D.s4, 0.8, 0.5); });
    };
    return Promise.all([lex(), ledger(), ana()]);
  }

  /* ---------- slides: Q3 finance report ---------- */
  function renderSlides() {
    var root = h('div', 'sl');
    var film = h('div', 'sl-film');
    var thumbs = [];
    ['Title', 'Agenda', 'Revenue', 'Costs', 'Outlook'].forEach(function (name, i) {
      var t = h('div', 'sl-thumb' + (i === 2 ? ' on' : ''));
      t.appendChild(h('span', null, String(i + 1)));
      var d = h('div');
      d.appendChild(h('i')); d.appendChild(h('i', 's'));
      if (i === 2 || i === 3) {
        var bars = h('div', 'bars');
        [40, 55, 60, 70, 90].forEach(function (v) { var b = h('b'); b.style.height = v + '%'; bars.appendChild(b); });
        d.appendChild(bars);
      }
      t.appendChild(d);
      t.title = name;
      thumbs.push(t);
      film.appendChild(t);
    });
    root.appendChild(film);
    var main = h('div', 'sl-main');
    var canvas = h('div', 'sl-canvas');
    canvas.appendChild(h('div', 'sl-kicker', 'Q3 finance report'));
    var title = h('h2', 'sl-title');
    title.appendChild(document.createTextNode('Q3 revenue: '));
    var tAmount = h('em', null, '$1.18M');
    title.appendChild(tAmount);
    title.appendChild(document.createTextNode(', up '));
    var tPct = h('span', null, '12%');
    title.appendChild(tPct);
    canvas.appendChild(title);
    var chart = h('div', 'sl-chart');
    chart.appendChild(h('div', 'sl-chart-cap', 'Revenue by quarter, $M'));
    var barsWrap = h('div', 'sl-bars');
    var axis = h('div', 'sl-axis');
    var bars = [];
    [['Q3 25', 0.82], ['Q4 25', 0.91], ['Q1 26', 0.97], ['Q2 26', 1.05], ['Q3 26', 1.18]].forEach(function (q) {
      var bar = h('div', 'sl-bar');
      var label = h('span', null, q[1].toFixed(2));
      var fill = h('b');
      fill.style.height = (q[1] / 1.3 * 88) + '%';
      bar.appendChild(label); bar.appendChild(fill);
      barsWrap.appendChild(bar);
      axis.appendChild(h('span', null, q[0]));
      bars.push({ bar: bar, label: label, fill: fill });
    });
    chart.appendChild(barsWrap); chart.appendChild(axis);
    canvas.appendChild(chart);
    var kpis = h('div', 'sl-kpis');
    function kpi(label, value, note) {
      var box = h('div', 'sl-kpi');
      box.appendChild(h('small', null, label));
      var v = h('strong', null, value);
      box.appendChild(v);
      var n = h('em', null, note);
      box.appendChild(n);
      box.contentEditable = 'true'; box.spellcheck = false;
      kpis.appendChild(box);
      return { box: box, value: v, note: n };
    }
    var arr = kpi('ARR', '$4.7M', '+9% QoQ');
    var nrr = kpi('Net revenue retention', '110%', 'target 110%');
    var gm = kpi('Gross margin', '71%', '+2 pts');
    canvas.appendChild(kpis);
    main.appendChild(canvas);
    var notes = h('div', 'sl-notes');
    notes.appendChild(h('b', null, 'Speaker notes'));
    var notesText = h('span', null, 'Q3 beat plan by 6%. ');
    notes.appendChild(notesText);
    notes.contentEditable = 'true'; notes.spellcheck = false;
    main.appendChild(notes);
    root.appendChild(main);
    page.replaceChildren(root);
    return { thumbs: thumbs, title: title, tAmount: tAmount, tPct: tPct, chart: chart, bars: bars, kpis: kpis, arr: arr, nrr: nrr, gm: gm, notes: notes, notesText: notesText, canvas: canvas };
  }

  function slidesScript(k, P) {
    var q3 = P.bars[4];
    var ledger = function () {
      var working;
      return k.wait(1500)
        .then(function () { working = k.say('ledger', 'Pulling final Q3 numbers from the close…', { working: true }); return k.bot('ledger', P.chart, 'pulling Q3 close'); })
        .then(function () { return k.wait(1900); })
        .then(function () {
          k.botLabel('ledger', 'updating Q3 bar');
          q3.label.textContent = '1.24';
          q3.fill.style.height = (1.24 / 1.3 * 88) + '%';
          return k.wait(1300);
        })
        .then(function () { return k.bot('ledger', P.title, 'updating the headline'); })
        .then(function () { P.tAmount.textContent = ''; return k.type(P.tAmount, '$1.24M', 110); })
        .then(function () { P.tPct.textContent = ''; return k.type(P.tPct, '18%', 140); })
        .then(function () { return k.bot('ledger', P.arr.box, 'updating ARR'); })
        .then(function () { P.arr.value.textContent = ''; return k.type(P.arr.value, '$4.9M', 120); })
        .then(function () { P.arr.note.textContent = '+12% QoQ'; k.botDone('ledger', 'done'); working.resolve('Updated the Q3 bar, headline and ARR to the closed numbers: $1.24M revenue, up 18%.'); });
    };
    var pixel = function () {
      var working;
      return k.wait(7200)
        .then(function () { working = k.say('pixel', 'Making the slide board-ready…', { working: true }); return k.bot('pixel', P.chart, 'highlighting the Q3 bar', 'left'); })
        .then(function () { return k.wait(1100); })
        .then(function () { q3.bar.classList.add('hot'); return k.wait(1200); })
        .then(function () { return k.bot('pixel', P.title, 'tightening the title'); })
        .then(function () { P.title.classList.add('tuned'); return k.wait(1500); })
        .then(function () { k.botDone('pixel', 'done'); working.resolve('Highlighted Q3 in the chart and tightened the title. The rest of the layout already matches the deck.'); });
    };
    var ana = function () {
      return k.wait(3000)
        .then(function () { return k.move('ana', P.nrr.value, 0.9, 0.6); })
        .then(function () { k.select('ana', P.nrr.box); return k.wait(700); })
        .then(function () { k.typing('ana', true); P.nrr.value.textContent = ''; return k.type(P.nrr.value, '112%', 160); })
        .then(function () { k.typing('ana', false); P.nrr.note.textContent = 'target 110%, beat'; return k.wait(1500); })
        .then(function () { k.say('ana', 'NRR is 112% after the Acme expansion.'); });
    };
    var diego = function () {
      return k.wait(1000)
        .then(function () { return k.move('diego', P.thumbs[3], 0.6, 0.6); })
        .then(function () { k.select('diego', P.thumbs[3].lastChild); return k.wait(3200); })
        .then(function () { return k.move('diego', P.notesText, 1, 0.6); })
        .then(function () { k.select('diego', P.notes); k.typing('diego', true); return k.type(P.notesText, 'Main driver is the Acme expansion; call it out before the chart.', 55); })
        .then(function () { k.typing('diego', false); k.unselect('diego'); k.say('diego', 'Speaker notes are in. Slide 4 is next, I will take costs.'); return k.move('diego', P.thumbs[3], 0.5, 0.5); });
    };
    return Promise.all([ledger(), pixel(), ana(), diego()]);
  }

  /* ---------- tabs ---------- */
  var TABS = [
    {
      id: 'sheet', kind: 'sheet', label: 'Q4 budget', url: 'docs.google.com/spreadsheets/d/q4-budget/edit',
      players: ['you', 'ana', 'diego', 'sam'], bots: ['mia', 'ledger', 'scout'],
      seed: [
        ['system', 'You shared this tab with the room'],
        ['ana', '@Ledger fill Q3 actuals from the invoices tab.'],
        ['you', '@Mia flag anything where Q4 plan is below Q3 actual.']
      ],
      render: renderSheet, script: sheetScript
    },
    {
      id: 'doc', kind: 'doc', label: 'MSA · Mia Labs and Acme', url: 'docs.google.com/document/d/msa-acme/edit',
      players: ['you', 'ana'], bots: ['lex', 'ledger'],
      seed: [
        ['system', 'You shared this tab with the room'],
        ['ana', "Acme's legal team wants this back by Friday. @Ledger check the payment terms against their AP cycle."],
        ['you', '@Lex review this for anything risky.']
      ],
      render: renderDoc, script: docScript,
      layout: function (refs) { layoutCards(refs); }
    },
    {
      id: 'slides', kind: 'slides', label: 'Q3 finance report', url: 'docs.google.com/presentation/d/q3-finance/edit#slide=3',
      players: ['you', 'ana', 'diego'], bots: ['pixel', 'ledger'],
      seed: [
        ['system', 'You shared this tab with the room'],
        ['ana', '@Ledger swap in the final Q3 numbers from the close.'],
        ['you', '@Pixel make this slide board-ready.'],
        ['diego', 'I will take the speaker notes.']
      ],
      render: renderSlides, script: slidesScript
    }
  ];

  var current = null;
  var tabButtons = {};

  function buildTabs() {
    var strip = $('tabs');
    TABS.forEach(function (tab) {
      var b = h('button', 'mp-tab');
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.appendChild(h('span', 'mp-tab-ico ' + tab.kind));
      b.appendChild(h('span', 'mp-tab-label', tab.label));
      var live = h('span', 'mp-tab-live');
      tab.players.forEach(function (pid) { live.appendChild(setVars(h('i'), { background: PLAYERS[pid].color })); });
      b.appendChild(live);
      b.addEventListener('click', function () { openTab(tab.id); });
      tabButtons[tab.id] = b;
      strip.appendChild(b);
    });
    var plus = h('button', 'mp-newtab', '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'New tab');
    strip.appendChild(plus);
  }

  function buildPresence(tab) {
    var box = $('presence');
    box.replaceChildren(h('span', 'mp-presence-label', 'Working with'));
    tab.players.forEach(function (pid) {
      var p = PLAYERS[pid];
      var el = setVars(h('div', 'mp-player'), { '--c': p.color });
      el.appendChild(h('div', 'mp-face', p.short));
      el.appendChild(h('span', 'mp-pnum', 'P' + p.num));
      var mine = tab.bots.filter(function (b) { return BOTS[b].owner === pid; });
      if (mine.length) {
        var orbit = h('div', 'mp-orbit');
        mine.forEach(function (b, i) {
          var m = moteEl(b);
          setVars(m, { '--a': (-50 + i * 120) + 'deg' });
          orbit.appendChild(m);
        });
        el.appendChild(orbit);
      }
      var tip = h('div', 'mp-player-tip');
      tip.appendChild(h('b', null, p.name + (pid === 'you' ? ' (you)' : '') + ' · Player ' + p.num));
      if (!mine.length) tip.appendChild(h('span', null, 'No bots in this tab'));
      mine.forEach(function (b) {
        var row = h('span');
        var m = moteEl(b); m.style.width = '16px'; m.style.height = '16px';
        row.appendChild(m);
        row.appendChild(document.createTextNode(BOTS[b].name + ' · ' + BOTS[b].job));
        tip.appendChild(row);
      });
      el.appendChild(tip);
      box.appendChild(el);
    });
    $('liveText').textContent = 'Multiplayer · ' + tab.players.length + ' players · ' + tab.bots.length + ' bots';
  }

  function buildRoom(tab) {
    $('roomTitle').textContent = tab.label;
    var roster = $('roster');
    roster.replaceChildren();
    tab.players.forEach(function (pid) {
      var s = h('span');
      s.appendChild(setVars(h('i', 'mp-face-sm'), { '--c': PLAYERS[pid].color }));
      s.appendChild(document.createTextNode(PLAYERS[pid].name));
      roster.appendChild(s);
    });
    tab.bots.forEach(function (b) {
      var s = h('span');
      var m = moteEl(b); m.classList.add('mp-mote');
      s.appendChild(m);
      s.appendChild(document.createTextNode(BOTS[b].name));
      roster.appendChild(s);
    });
    msgs.replaceChildren();
    tab.seed.forEach(function (m) { say(m[0], m[1]); });
  }

  function openTab(id) {
    var tab = TABS.filter(function (t) { return t.id === id; })[0];
    run.token += 1;
    var token = run.token;
    Object.keys(tabButtons).forEach(function (k) { tabButtons[k].setAttribute('aria-selected', k === id ? 'true' : 'false'); });
    $('url').textContent = tab.url;
    clearActors();
    buildPresence(tab);
    buildRoom(tab);
    var refs = tab.render();
    current = { tab: tab, refs: refs, layout: tab.layout ? function () { tab.layout(refs); } : null };
    try { history.replaceState(null, '', '#' + id); } catch (_) { /* file:// */ }
    // A timer, not requestAnimationFrame: rAF never fires in a background tab.
    setTimeout(function () {
      tab.script(makeKit(token), refs).then(function () {
        if (token === run.token) say('system', 'Everyone is still in the tab. Restart to replay.');
      }, function (err) { if (err !== STOP) console.error(err); });
    }, 0);
  }

  /* ---------- your chat ---------- */
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('composerInput');
    var text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    say('you', text);
    var tab = current.tab;
    var mentioned = tab.bots.filter(function (b) { return new RegExp('@' + BOTS[b].name + '\\b', 'i').test(text); });
    var token = run.token;
    mentioned.forEach(function (b, i) {
      setTimeout(function () {
        if (token !== run.token) return;
        var m = say(b, 'On it, working in the tab…', { working: true });
        setTimeout(function () {
          if (token !== run.token) return;
          m.resolve('Done. Anything I change shows up as a suggestion for a human to accept.');
        }, 2600);
      }, 700 + i * 500);
    });
  });
  $('composerInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });

  /* ---------- demo controls ---------- */
  $('pauseBtn').addEventListener('click', function () {
    run.paused = !run.paused;
    this.textContent = run.paused ? 'Play' : 'Pause';
    document.body.classList.toggle('paused', run.paused);
  });
  $('restartBtn').addEventListener('click', function () {
    run.paused = false; $('pauseBtn').textContent = 'Pause';
    openTab(current ? current.tab.id : 'sheet');
  });
  window.addEventListener('resize', repositionAll);

  buildTabs();
  var start = (location.hash || '').replace('#', '');
  openTab(TABS.some(function (t) { return t.id === start; }) ? start : 'sheet');
})();
