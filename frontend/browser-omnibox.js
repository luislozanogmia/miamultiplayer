(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaBrowserOmnibox = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // Address-bar suggestions built only from local visit history: inline
  // completion, one "go here" row that matches what Enter opens, then the
  // best-matching pages, deduplicated and ranked. Nothing here leaves the
  // machine.
  var MAX_ROWS = 8;
  var DAY_MS = 86400000;

  function stripPrefix(value){
    return String(value || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
  }

  // "https://www.linkedin.com/feed/?x=1#top" -> "linkedin.com/feed?x=1"
  function displayUrl(url){
    try {
      var parsed = new URL(url);
      var host = parsed.hostname.replace(/^www\./i, '') + (parsed.port ? ':' + parsed.port : '');
      var path = parsed.pathname.replace(/\/+$/, '');
      return host + path + parsed.search;
    } catch(_error) {
      return stripPrefix(url).replace(/\/+$/, '');
    }
  }

  function hostOf(display){
    var cut = display.search(/[/?]/);
    return cut === -1 ? display : display.slice(0, cut);
  }

  function frecency(item, now){
    var age = Math.max(0, (now - Number(item.lastVisit || 0)) / DAY_MS);
    return Math.max(1, Number(item.count) || 1) / (1 + age / 14);
  }

  // Visits of the same page (trailing slash, #fragment, www.) count as one.
  function pages(history, now){
    var byKey = {};
    var order = [];
    (history || []).forEach(function(entry){
      if(!entry || typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) return;
      var display = displayUrl(entry.url);
      var item = byKey[display];
      if(!item){
        item = byKey[display] = {url:entry.url, title:String(entry.title || ''), icon:String(entry.icon || ''),
          display:display, host:hostOf(display), score:0, lastVisit:0};
        order.push(item);
      }
      item.score += frecency(entry, now);
      if(Number(entry.lastVisit || 0) > item.lastVisit){
        item.lastVisit = Number(entry.lastVisit || 0);
        item.url = entry.url;
        if(entry.title) item.title = String(entry.title);
      }
      if(!item.title && entry.title) item.title = String(entry.title);
      if(!item.icon && entry.icon) item.icon = String(entry.icon);
    });
    return order;
  }

  // Pages with the same title on the same site show as one row; the shorter
  // address wins so "linkedin.com" beats "linkedin.com/feed".
  function dedupe(history, now){
    var byTitle = {};
    var merged = [];
    pages(history, now).forEach(function(page){
      var item = {url:page.url, title:page.title, icon:page.icon, display:page.display, host:page.host, score:page.score, lastVisit:page.lastVisit};
      var key = item.title ? item.host + '\n' + item.title.toLowerCase() : '';
      var kept = key && byTitle[key];
      if(!kept){
        if(key) byTitle[key] = item;
        merged.push(item);
        return;
      }
      if(item.display.length < kept.display.length){
        kept.url = item.url; kept.display = item.display;
      }
      kept.score += item.score;
      if(!kept.icon) kept.icon = item.icon;
    });
    return merged;
  }

  function terms(query){
    return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function wordStart(text, term){
    var lower = text.toLowerCase();
    var at = lower.indexOf(term);
    while(at !== -1){
      if(at === 0 || !/[a-z0-9]/i.test(lower.charAt(at - 1))) return true;
      at = lower.indexOf(term, at + 1);
    }
    return false;
  }

  // 3: the address starts with what was typed; 2: every word starts a word
  // in the title or address; 1: every word appears somewhere; 0: no match.
  function matchTier(item, query){
    var bare = stripPrefix(String(query || '').trim()).toLowerCase();
    if(bare && item.display.toLowerCase().indexOf(bare) === 0) return 3;
    var words = terms(query);
    if(!words.length) return 0;
    var haystack = item.title + ' ' + item.display;
    if(words.every(function(word){ return wordStart(haystack, stripPrefix(word)); })) return 2;
    var lower = haystack.toLowerCase();
    if(words.every(function(word){ return lower.indexOf(stripPrefix(word)) !== -1; })) return 1;
    return 0;
  }

  function isRoot(item){ return item.display === item.host; }

  // Completion for what was typed: the whole site when the typing is still
  // inside its name, else the best page whose address continues the typing.
  function completionFor(items, query){
    var raw = String(query || '');
    if(!raw || /\s/.test(raw)) return null;
    var bare = stripPrefix(raw).toLowerCase();
    if(!bare) return null;
    var sites = {};
    items.forEach(function(item){
      if(item.display.toLowerCase().indexOf(bare) !== 0) return;
      var site = sites[item.host] || (sites[item.host] = {score:0, root:null, best:null});
      site.score += item.score;
      if(isRoot(item)) site.root = item;
      if(!site.best || item.score > site.best.score) site.best = item;
    });
    var best = null;
    Object.keys(sites).forEach(function(host){
      if(!best || sites[host].score > sites[best].score) best = host;
    });
    if(!best) return null;
    var site = sites[best];
    var target;
    if(bare.length <= best.length){
      target = site.root || {url:siteUrl(site.best.url), title:'', icon:site.best.icon, display:best, host:best};
    } else {
      target = items.filter(function(item){
        return item.host === best && item.display.toLowerCase().indexOf(bare) === 0;
      }).sort(function(a, b){ return a.display.length - b.display.length || b.score - a.score; })[0];
    }
    var remainder = target.display.slice(bare.length);
    var url = target.url;
    // An explicit web address belongs to the user. History supplies only the
    // suffix: its scheme (or www. spelling) must not replace what is visible.
    if(/^https?:\/\//i.test(raw)){
      try { url = new URL(raw + remainder).href; } catch(_error) { return null; }
    }
    return {url:url, title:target.title || '', icon:target.icon || site.best.icon || '',
      display:target.display, remainder:remainder};
  }

  function siteUrl(url){
    try { var parsed = new URL(url); return parsed.origin + '/'; } catch(_error) { return url; }
  }

  // looksLikeUrl(query) tells whether Enter opens the typing as an address
  // (true) or searches for it (false) when nothing is completed.
  function suggest(history, query, options){
    options = options || {};
    var now = Number(options.now) || Date.now();
    var raw = String(query || '');
    var trimmed = raw.trim();
    if(!trimmed) return {completion:null, rows:[]};
    var items = dedupe(history, now);
    var completion = options.complete === false ? null : completionFor(pages(history, now), raw);
    var looksLikeUrl = typeof options.looksLikeUrl === 'function' ? options.looksLikeUrl(trimmed) : /\./.test(trimmed) && !/\s/.test(trimmed);
    var rows = [];
    if(completion){
      rows.push({kind:'url', url:completion.url, title:completion.title, display:completion.display, icon:completion.icon, go:true});
      if(!looksLikeUrl) rows.push({kind:'search', query:trimmed});
    } else if(looksLikeUrl){
      rows.push({kind:'url', url:'', value:trimmed, title:'', display:stripPrefix(trimmed), icon:'', go:true});
    } else {
      rows.push({kind:'search', query:trimmed, go:true});
    }
    var goDisplay = completion ? completion.display : '';
    items.map(function(item){ return {item:item, tier:matchTier(item, trimmed)}; })
      .filter(function(entry){ return entry.tier > 0 && entry.item.display !== goDisplay; })
      .sort(function(a, b){
        return b.tier - a.tier ||
          (b.tier === 3 ? Number(isRoot(b.item)) - Number(isRoot(a.item)) : 0) ||
          b.item.score - a.item.score ||
          a.item.display.length - b.item.display.length;
      })
      .slice(0, MAX_ROWS - rows.length)
      .forEach(function(entry){
        var item = entry.item;
        rows.push({kind:'history', url:item.url, title:item.title, display:item.display, icon:item.icon});
      });
    return {completion:completion, rows:rows};
  }

  // Splits text into [{text, match}] pieces, marking where a typed word
  // starts a word, or its first appearance otherwise.
  function highlight(text, query){
    text = String(text || '');
    var marks = [];
    terms(query).forEach(function(word){
      word = stripPrefix(word);
      if(!word) return;
      var lower = text.toLowerCase();
      var found = false;
      var at = lower.indexOf(word);
      while(at !== -1){
        if(at === 0 || !/[a-z0-9]/i.test(lower.charAt(at - 1))){ marks.push([at, at + word.length]); found = true; }
        at = lower.indexOf(word, at + 1);
      }
      if(!found && (at = lower.indexOf(word)) !== -1) marks.push([at, at + word.length]);
    });
    if(!marks.length) return text ? [{text:text, match:false}] : [];
    marks.sort(function(a, b){ return a[0] - b[0]; });
    var pieces = [];
    var cursor = 0;
    marks.forEach(function(mark){
      var start = Math.max(mark[0], cursor);
      if(start >= mark[1]) return;
      if(start > cursor) pieces.push({text:text.slice(cursor, start), match:false});
      pieces.push({text:text.slice(start, mark[1]), match:true});
      cursor = mark[1];
    });
    if(cursor < text.length) pieces.push({text:text.slice(cursor), match:false});
    return pieces;
  }

  // How well a name answers the typing: 3 starts with it, 2 every word
  // starts a word, 1 every word appears, 0 no match.
  function textTier(text, query){
    var lower = String(text || '').toLowerCase();
    var whole = String(query || '').trim().toLowerCase();
    if(!whole || !lower) return 0;
    if(lower.indexOf(whole) === 0) return 3;
    var words = terms(query);
    if(words.every(function(word){ return wordStart(lower, word); })) return 2;
    if(words.every(function(word){ return lower.indexOf(word) !== -1; })) return 1;
    return 0;
  }

  function ranked(items, query, textOf, limit){
    return (items || []).map(function(item){
      return {item:item, tier:Math.max.apply(null, [].concat(textOf(item)).map(function(text){ return textTier(text, query); }))};
    }).filter(function(entry){ return entry.tier > 0; })
      .sort(function(a, b){ return b.tier - a.tier; })
      .slice(0, limit)
      .map(function(entry){ return entry.item; });
  }

  // The bar searches everywhere. Groups come back in order of what you are
  // doing: the showing view's group first, then the rest in the mix order
  // browser, chat, automation. Each group holds labelled parts of rows.
  //   sources: {browser:[rows from suggest()], people:[{name, sub}],
  //     chats:[{name}], automations:[{name, botName, steps:[text]}],
  //     current:{name, messages:[{id, text, author}]} (the open chat, newest first)}
  //   options.view: 'browser' | 'chat' | 'automations'; null with tabs mixed.
  var GROUP_ORDER = ['browser', 'chat', 'automations'];
  var PART_LIMIT = 4;
  function everywhere(query, sources, options){
    sources = sources || {};
    var view = options && options.view;
    var groups = {
      browser: {key:'browser', title:'Browser', parts:[{label:'', rows:(sources.browser || []).slice(0, view && view !== 'browser' ? PART_LIMIT : MAX_ROWS)}]},
      chat: {key:'chat', title:'Chat', parts:[
        // The chat you have open answers first, from its own messages.
        {label:sources.current ? 'In ' + sources.current.name : '', rows:messageRows(sources.current, query)},
        {label:'People', rows:ranked(sources.people, query, function(person){ return [person.name, person.sub || '']; }, PART_LIMIT).map(function(person){ return {kind:'person', target:person}; })},
        {label:'Chat history', rows:ranked(sources.chats, query, function(chat){ return chat.name; }, PART_LIMIT).map(function(chat){ return {kind:'chat', target:chat}; })}
      ]},
      automations: {key:'automations', title:'Automation', parts:[
        {label:'Automations', rows:ranked(sources.automations, query, function(automation){ return [automation.name, automation.botName || '']; }, PART_LIMIT).map(function(automation){ return {kind:'automation', target:automation}; })},
        {label:'Steps', rows:stepRows(sources.automations, query)}
      ]}
    };
    var order = GROUP_ORDER.indexOf(view) === -1 ? GROUP_ORDER : [view].concat(GROUP_ORDER.filter(function(key){ return key !== view; }));
    return order.map(function(key){
      var group = groups[key];
      group.parts = group.parts.filter(function(part){ return part.rows.length; });
      return group;
    }).filter(function(group){ return group.parts.length; });
  }

  // A long message is shown from just before the match, so the match is visible.
  function messageRows(current, query){
    if(!current) return [];
    return ranked(current.messages, query, function(message){ return message.text; }, PART_LIMIT).map(function(message){
      var text = String(message.text || '').replace(/\s+/g, ' ').trim();
      var at = text.toLowerCase().indexOf((terms(query)[0] || '').toLowerCase());
      if(at > 40) text = '…' + text.slice(at - 20);
      return {kind:'message', target:message, text:text};
    });
  }

  function stepRows(automations, query){
    var steps = [];
    (automations || []).forEach(function(automation){
      (automation.steps || []).forEach(function(step, index){
        steps.push({text:String(step || ''), number:index + 1, automation:automation});
      });
    });
    return ranked(steps, query, function(step){ return step.text; }, PART_LIMIT).map(function(step){
      return {kind:'step', target:step.automation, text:step.text, number:step.number};
    });
  }

  return {MAX_ROWS:MAX_ROWS, displayUrl:displayUrl, dedupe:dedupe, suggest:suggest, highlight:highlight, everywhere:everywhere};
});
