(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaEmoji = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The emoji panel used by the message box and by message reactions, and the
  // reaction chips under a message. Pure data shaping and markup; the app wires clicks.
  var GROUPS = [
    {title: 'Smileys', items: [
      ['😀','grin happy smile'],['😄','smile happy'],['😁','beam grin'],['😂','joy laugh tears lol'],['🤣','rofl laugh'],['😊','smile blush'],
      ['🙂','slight smile'],['😉','wink'],['😍','love heart eyes'],['😘','kiss'],['😎','cool sunglasses'],['🤩','star struck wow'],
      ['🤔','thinking hmm'],['🤨','raised eyebrow doubt'],['😐','neutral'],['🙄','eye roll'],['😴','sleep tired'],['😅','sweat relief'],
      ['😬','grimace awkward'],['😢','cry sad'],['😭','sob cry'],['😤','frustrated huff'],['😡','angry mad'],['🤯','mind blown'],
      ['😱','scream shock'],['🥳','party celebrate'],['🥲','smile tear'],['🤗','hug'],['🫡','salute'],['🤝','handshake deal'],
    ]},
    {title: 'Hands', items: [
      ['👍','thumbs up yes like'],['👎','thumbs down no'],['👏','clap applause'],['🙌','raised hands hooray'],['🙏','pray thanks please'],['👋','wave hello bye'],
      ['👌','ok perfect'],['✌️','peace victory'],['🤞','fingers crossed luck'],['💪','strong muscle'],['👀','eyes look'],['🫶','heart hands love'],
    ]},
    {title: 'Hearts and symbols', items: [
      ['❤️','red heart love'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],
      ['🖤','black heart'],['💯','hundred perfect'],['✅','check done yes'],['❌','cross no wrong'],['⚠️','warning'],['❓','question'],
      ['❗','exclamation important'],['🔥','fire hot great'],['✨','sparkles new'],['⭐','star'],['🎉','party tada celebrate'],['🎊','confetti'],
    ]},
    {title: 'Work and things', items: [
      ['🚀','rocket launch ship'],['💡','idea light'],['📌','pin'],['📎','paperclip attach'],['📅','calendar date'],['⏰','alarm time'],
      ['📈','chart up growth'],['📉','chart down'],['💰','money'],['💻','laptop computer'],['🔒','lock secure'],['🔑','key'],
      ['🐛','bug'],['🔧','wrench fix'],['📝','memo note write'],['📧','email'],['🏆','trophy win'],['🎯','target goal'],
      ['☕','coffee'],['🍕','pizza'],['🌮','taco'],['🍺','beer'],['🌎','world earth'],['☀️','sun'],
    ]},
  ];
  var RECENT_LIMIT = 12;

  function search(query){
    var words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return GROUPS.map(function(group){
      return {title: group.title, items: group.items.filter(function(item){
        return words.every(function(word){ return item[1].indexOf(word) !== -1; });
      })};
    }).filter(function(group){ return group.items.length; });
  }

  function remember(recent, emoji){
    return [emoji].concat((recent || []).filter(function(item){ return item !== emoji; })).slice(0, RECENT_LIMIT);
  }

  function grid(items, esc){
    return '<div class="mia-emoji-grid">' + items.map(function(item){
      return '<button type="button" data-emoji-pick="' + esc(item[0]) + '" title="' + esc(item[1]) + '" aria-label="' + esc(item[1]) + '">' + esc(item[0]) + '</button>';
    }).join('') + '</div>';
  }

  function listHtml(query, recent, esc){
    var groups = search(query);
    if(!groups.length) return '<div class="mia-emoji-empty">Nothing matches.</div>';
    var known = {};
    GROUPS.forEach(function(group){ group.items.forEach(function(item){ known[item[0]] = item; }); });
    var mine = String(query || '').trim() ? [] : (recent || []).map(function(emoji){ return known[emoji]; }).filter(Boolean);
    return (mine.length ? [{title: 'Recent', items: mine}] : []).concat(groups).map(function(group){
      return '<div class="mia-emoji-title">' + esc(group.title) + '</div>' + grid(group.items, esc);
    }).join('');
  }

  // Reactions are stored as {emoji: [who, ...]}; the chip you already added is marked.
  function reactionsHtml(reactions, me, esc, canReact){
    var mine = String(me || '').toLowerCase();
    var chips = Object.keys(reactions || {}).filter(function(emoji){
      return Array.isArray(reactions[emoji]) && reactions[emoji].length;
    }).map(function(emoji){
      var who = reactions[emoji];
      var on = who.some(function(person){ return String(person).toLowerCase() === mine; });
      var label = emoji + ', ' + who.length + (on ? ', you reacted' : '');
      return '<button type="button" class="chat-msg-reaction' + (on ? ' on' : '') + '"' + (canReact ? ' data-react-toggle="' + esc(emoji) + '"' : ' disabled')
        + ' aria-pressed="' + on + '" aria-label="' + esc(label) + '"><span>' + esc(emoji) + '</span><em>' + who.length + '</em></button>';
    });
    return chips.length ? '<div class="chat-msg-reactions">' + chips.join('') + '</div>' : '';
  }

  return {GROUPS: GROUPS, listHtml: listHtml, reactionsHtml: reactionsHtml, remember: remember, search: search};
});
