/* A site's notifications in a chat, and the "Stopped" line, drawn with Mia's
   own icons instead of emoji. A notification shows the site's own icon (the
   one its browser tab shows) with Mia's gold dot; a site without one gets the
   small Mia mark. Notifications from one site that arrive in a row fold into
   one line, "WhatsApp · 5 new", opened on a click. */
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

  function noticeHtml(message){
    var n = meta(message), host = hostOf(n.origin), text = parse(message);
    return '<div class="chat-msg-system site-notice" data-event-id="' + escText(message.id) + '">' + iconHtml(n.icon) +
      '<div class="site-notice-text"><div class="site-notice-meta"><b>' + escText(siteName(host)) + '</b> · notification from ' + escText(host) + '</div>' +
      '<div>' + (text.title ? '<span class="site-notice-title">' + escText(text.title) + '</span> ' : '') + '<span class="site-notice-body">' + escText(text.body) + '</span></div></div>' +
      '<span class="site-notice-time">' + escText(clock(message.ts)) + '</span></div>';
  }

  function groupHtml(group){
    var items = group.items, first = items[0], n = meta(first), host = hostOf(group.origin);
    var icon = items.map(function(item){ return meta(item).icon; }).filter(function(value){ return typeof value === 'string' && ICON.test(value); }).pop();
    var who = [];
    items.forEach(function(item){ var t = parse(item).title; if(t && who.indexOf(t) < 0) who.push(t); });
    var people = who.slice(0, 3).join(', ') + (who.length > 3 ? ' and ' + (who.length - 3) + ' more' : '');
    var range = clock(first.ts) === clock(group.ts) ? clock(group.ts) : clock(first.ts) + '–' + clock(group.ts);
    return '<details class="chat-msg-system site-notice-group" data-site-notices="' + escText(group.id) + '"' + (open[group.id] ? ' open' : '') + '>' +
      '<summary class="site-notice">' + iconHtml(icon || n.icon) +
      '<div class="site-notice-text"><div class="site-notice-meta"><b>' + escText(siteName(host)) + '</b> · ' + escText(host) + '</div>' +
      '<div><span class="site-notice-title">' + items.length + ' new</span>' + (people ? ' <span class="site-notice-body">from ' + escText(people) + '</span>' : '') + '</div></div>' +
      '<span class="site-notice-time">' + escText(range) + '</span><span class="site-notice-count">' + items.length + '</span><span class="site-notice-chev" aria-hidden="true">›</span></summary>' +
      '<div class="site-notice-list">' + items.map(function(item){
        var text = parse(item);
        return '<div class="site-notice-item">' + (text.title ? '<span class="site-notice-title">' + escText(text.title) + '</span> ' : '') +
          '<span class="site-notice-body">' + escText(text.body) + '</span> <span class="site-notice-meta">· ' + escText(clock(item.ts)) + '</span></div>';
      }).join('') + '</div></details>';
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
