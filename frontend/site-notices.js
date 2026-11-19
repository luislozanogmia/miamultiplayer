/* A site's notifications in a chat, and the "Stopped" line, drawn with Mia's
   own icons instead of emoji. A notification is drawn as a message from the
   site: its own icon (the one its browser tab shows) with Mia's gold dot as
   the avatar, the site's name with a "Notification" tag, and the time. A site
   without an icon gets the small Mia mark. Like any message it can be replied
   to in a thread (the bot then gets its text, see nativeSiteNoticeReplyNote in
   backend/server.js). Notifications from one site that arrive in a row fold
   into one message, "WhatsApp · 5 new", opened on a click; each one in it can
   be replied to. */
(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaSiteNotices = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // Only an inline image the browser kept for the tab; never an address.
  var ICON = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
  // Older rows were written with an emoji in front.
  var LEAD = /^(?:\uD83D\uDD14|\u23F9\uFE0F?|\u23F8\uFE0F?)\s*/;
  // Names people know a site by; anything else shows its address.
  var NAMES = {
    'web.whatsapp.com': 'WhatsApp', 'mail.google.com': 'Gmail', 'calendar.google.com': 'Calendar',
    'app.slack.com': 'Slack', 'www.linkedin.com': 'LinkedIn', 'teams.microsoft.com': 'Teams',
    'outlook.office.com': 'Outlook', 'outlook.live.com': 'Outlook', 'web.telegram.org': 'Telegram',
    'discord.com': 'Discord', 'app.asana.com': 'Asana', 'x.com': 'X'
  };
  var open = {};

  function escText(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function meta(message){
    var m = message && message.nativeEvent && message.nativeEvent.metadata;
    return m && m.siteNotification && typeof m.siteNotification === 'object' ? m.siteNotification : null;
  }
  function isNotice(message){
    var n = meta(message);
    return !!(message && message.system && !message.deleted && n && typeof n.origin === 'string' && n.origin);
  }
  function hostOf(origin){
    try { return new URL(origin).hostname.toLowerCase(); } catch (_) { return String(origin || ''); }
  }
  function siteName(host){ return NAMES[host] || host; }
  // "Notification from host\ntitle\nbody" -> {title, body}
  function parse(message){
    var lines = String(message && message.body || '').replace(LEAD, '').split('\n');
    if(/^Notification from /.test(lines[0] || '')) lines.shift();
    return {title: (lines.shift() || '').trim(), body: lines.join(' ').trim()};
  }
  function miaMark(px){
    var s = '<svg class="site-notice-mia" viewBox="-30 -30 60 60" width="' + px + '" height="' + px + '" aria-hidden="true">';
    for(var y = -2; y <= 2; y++) for(var x = -2; x <= 2; x++){
      var r = Math.abs(x) + Math.abs(y); if(r > 2) continue;
      s += '<circle cx="' + x * 10 + '" cy="' + y * 10 + '" r="' + (r === 2 ? 4.3 : 5) + '" class="' + (r === 0 ? 'gold' : 'dot') + '"/>';
    }
    return s + '</svg>';
  }
  function iconHtml(icon){
    var site = typeof icon === 'string' && ICON.test(icon)
      ? '<img class="site-notice-site" src="' + escText(icon) + '" alt="" draggable="false">'
      : '<span class="site-notice-site is-mia">' + miaMark(16) + '</span>';
    return '<span class="site-notice-icon" aria-hidden="true">' + site + '<span class="site-notice-pip"></span></span>';
  }
  function clock(ts){
    var d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  }

  // Runs of two or more notices from one site, with nothing between them,
  // become {siteNotices: true, id, origin, items}.
  function groupNotices(messages){
    var out = [];
    (messages || []).forEach(function(message){
      var last = out[out.length - 1];
      if(!isNotice(message)){ out.push(message); return; }
      var origin = meta(message).origin;
      if(last && last.siteNotices && last.origin === origin){ last.items.push(message); last.ts = message.ts; return; }
      if(last && isNotice(last) && meta(last).origin === origin){
        out[out.length - 1] = {siteNotices: true, id: 'site-notices-' + last.id, origin: origin, ts: message.ts, items: [last, message]};
        return;
      }
      out.push(message);
    });
    return out;
  }

  // The row attributes the chat's message menu reads (app.js): only "Reply
  // in thread", and not inside a thread that is already open.
  function rowAttrs(message, opts){
    var canThread = !opts.inThread && !message.pending && !message.deleted;
    return ' data-event-id="' + escText(message.id) + '" data-can-thread="' + (canThread ? '1' : '') + '" data-can-delete="" data-can-edit=""';
  }
  function headHtml(host, timeHtml){
    return '<div class="chat-msg-head"><span class="chat-msg-name">' + escText(siteName(host)) + '</span>' +
      '<span class="chat-msg-tag">Notification</span>' + timeHtml + '</div>';
  }
  function lineHtml(text){
    return (text.title ? '<span class="site-notice-title">' + escText(text.title) + '</span> ' : '') +
      '<span class="site-notice-body">' + escText(text.body) + '</span>';
  }

  // opts: {inThread, direct (a one-to-one chat, as for other messages),
  // timeText (what the chat shows for other messages' time), footerHtml (the
  // thread pill under it)}.
  function noticeHtml(message, opts){
    opts = opts || {};
    var n = meta(message), host = hostOf(n.origin), text = parse(message);
    var time = '<span class="chat-msg-time"' + (message.ts ? ' data-ts="' + Number(message.ts) + '"' : '') + '>' +
      escText(opts.timeText || clock(message.ts)) + '</span>';
    return '<div class="chat-msg-row site-notice-row' + (opts.direct ? ' is-direct' : '') + (opts.inThread ? ' in-thread' : '') + '"' + rowAttrs(message, opts) + '>' +
      '<span class="chat-msg-mark site-notice-mark">' + iconHtml(n.icon) + '</span>' +
      '<div class="chat-msg-body">' + headHtml(host, time) +
      '<div class="chat-msg-text site-notice-card"><div class="site-notice-meta">notification from ' + escText(host) + '</div>' +
      '<div>' + lineHtml(text) + '</div></div>' + (opts.footerHtml || '') + '</div></div>';
  }

  // opts: {direct, footerFor(item) -> the thread pill under one notice}.
  function groupHtml(group, opts){
    opts = opts || {};
    var items = group.items, first = items[0], n = meta(first), host = hostOf(group.origin);
    var icon = items.map(function(item){ return meta(item).icon; }).filter(function(value){ return typeof value === 'string' && ICON.test(value); }).pop();
    var who = [];
    items.forEach(function(item){ var t = parse(item).title; if(t && who.indexOf(t) < 0) who.push(t); });
    var people = who.slice(0, 3).join(', ') + (who.length > 3 ? ' and ' + (who.length - 3) + ' more' : '');
    var range = clock(first.ts) === clock(group.ts) ? clock(group.ts) : clock(first.ts) + '–' + clock(group.ts);
    return '<div class="chat-msg-row site-notice-row site-notice-group-row' + (opts.direct ? ' is-direct' : '') + '" data-can-thread="" data-can-delete="" data-can-edit="">' +
      '<span class="chat-msg-mark site-notice-mark">' + iconHtml(icon || n.icon) + '</span>' +
      '<div class="chat-msg-body">' + headHtml(host, '<span class="chat-msg-time">' + escText(range) + '</span>') +
      '<details class="chat-msg-text site-notice-card site-notice-group" data-site-notices="' + escText(group.id) + '"' + (open[group.id] ? ' open' : '') + '>' +
      '<summary class="site-notice-summary"><span class="site-notice-text"><span class="site-notice-title">' + items.length + ' new</span>' +
      (people ? ' <span class="site-notice-body">from ' + escText(people) + '</span>' : '') + '</span>' +
      '<span class="site-notice-count">' + items.length + '</span><span class="site-notice-chev" aria-hidden="true">›</span></summary>' +
      '<div class="site-notice-list">' + items.map(function(item){
        return '<div class="chat-msg-row site-notice-item"' + rowAttrs(item, {}) + '><div class="site-notice-item-text">' + lineHtml(parse(item)) +
          ' <span class="site-notice-meta">· ' + escText(clock(item.ts)) + '</span></div>' +
          (opts.footerFor ? opts.footerFor(item) || '' : '') + '</div>';
      }).join('') + '</div></details></div></div>';
  }

  // "Stopped by you — …" and "Stopped when Mia closed — …" (backend
  // stopNoticeText), with or without the old emoji in front.
  var STOPPED = /^(?:\u23F9\uFE0F?\s*)?(Stopped (?:by you|when Mia closed)\b[\s\S]*)$/;
  function stoppedText(text){
    var match = STOPPED.exec(String(text || '').trim());
    return match ? match[1] : '';
  }
  function stoppedHtml(text){
    var line = stoppedText(text);
    if(!line) return '';
    return '<div class="chat-stopped-notice"><span class="chat-stopped-icon" aria-hidden="true"><i></i></span><span>' +
      escText(line).replace(/\n/g, '<br>') + '</span></div>';
  }

  if(typeof document !== 'undefined' && document.addEventListener){
    // A folded line stays open across re-renders of the chat.
    document.addEventListener('toggle', function(event){
      var el = event.target;
      if(el && el.getAttribute && el.getAttribute('data-site-notices')) open[el.getAttribute('data-site-notices')] = !!el.open;
    }, true);
  }

  return {isNotice: isNotice, groupNotices: groupNotices, noticeHtml: noticeHtml, groupHtml: groupHtml,
    stoppedText: stoppedText, stoppedHtml: stoppedHtml, iconHtml: iconHtml, parse: parse};
});
