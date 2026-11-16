/* How a bot got to its reply, for a power user: its thinking and its tool
   calls fold into one collapsed line per run, opened on a click. Nothing here
   reaches a normal user's chat, because their runs never post these rows. */
(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaChatSteps = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  var THINKING_TYPES = {'thinking.delta': true, 'reasoning.delta': true, 'reasoning.available': true};
  var THINKING_HEADS = /^(Thinking|Reasoning summary|Reasoning)(\n|$)/;
  var WAITING_FACE = /^[^A-Za-z0-9\s]\S{0,24} [a-z]+\.\.\.$/;
  var MAX_TOOL_LINE = 160;

  function eventType(message){
    var meta = message && message.nativeEvent && message.nativeEvent.metadata;
    return meta && typeof meta.hermesEventType === 'string' ? meta.hermesEventType : '';
  }

  // One row of a run becomes {kind, text}, or null when it has nothing to show.
  function stepOf(message){
    var type = eventType(message), text = String(message && message.body || '').trim();
    if(!text) return null;
    if(THINKING_TYPES[type]){
      // The runtime's waiting faces ("(¬_¬) deliberating...") are not thoughts.
      text = text.replace(THINKING_HEADS, '').split('\n').filter(function(line){ return !WAITING_FACE.test(line.trim()); }).join('\n').trim();
      return text ? {kind: 'thinking', text: text} : null;
    }
    if(type.indexOf('tool.') === 0){
      // Older runs stored a tool call's whole command, code and output. Only
      // the tool's name is kept from those, and the rest of the dump is dropped.
      var old = /^Debug · tool\.(\w+)(?: — ([^\n]+))?/.exec(text);
      if(old) return old[1] === 'start' && old[2] ? {kind: 'tool', text: 'Using ' + old[2].trim().slice(0, 64)} : null;
      if(text.indexOf('\n') >= 0 || text.length > MAX_TOOL_LINE) return null;
      return {kind: 'tool', text: text};
    }
    // What the bot says between steps is kept; status and debug rows are not.
    return type === 'message.interim' ? {kind: 'note', text: text} : null;
  }

  // Folds each run's rows into one entry, placed where the run's first row was.
  // An entry is {steps: true, id, dispatchId, ts, items: [{kind, text}]}.
  function groupSteps(messages){
    var out = [], byRun = {};
    (messages || []).forEach(function(message){
      if(!message || !message.nativeDiagnostic || !message.nativeDispatchId){ out.push(message); return; }
      var group = byRun[message.nativeDispatchId];
      if(!group){
        group = byRun[message.nativeDispatchId] = {steps: true, id: message.id, dispatchId: message.nativeDispatchId, ts: message.ts, items: []};
        out.push(group);
      }
      var step = stepOf(message);
      if(!step) return;
      var last = group.items[group.items.length - 1];
      // Thinking arrives in pieces; pieces in a row read as one thought.
      if(last && last.kind === 'thinking' && step.kind === 'thinking') last.text += '\n\n' + step.text;
      else group.items.push(step);
    });
    return out.filter(function(entry){ return !entry || !entry.steps || entry.items.length; });
  }

  // The collapsed line. While the run works it names the step in hand;
  // afterwards it sums the run up. -> "Thinking and 3 steps"
  function summary(group, live){
    var items = group.items, tools = items.filter(function(item){ return item.kind === 'tool'; }).length;
    var thought = items.some(function(item){ return item.kind === 'thinking'; });
    if(live){
      var last = items[items.length - 1];
      return last && last.kind === 'tool' ? last.text : 'Thinking';
    }
    var steps = tools ? tools + (tools === 1 ? ' step' : ' steps') : '';
    if(thought && steps) return 'Thinking and ' + steps;
    if(steps) return steps.charAt(0).toUpperCase() + steps.slice(1);
    return thought ? 'Thinking' : 'Notes';
  }

  // options: esc(text), live, open.
  function html(group, options){
    var esc = options.esc;
    var list = group.items.map(function(item){
      return '<div class="chat-step chat-step-' + item.kind + '">' + esc(item.text) + '</div>';
    }).join('');
    // The empty mark keeps the line under the bot's text, not under its picture.
    return '<div class="chat-msg-row chat-steps-row" data-event-id="' + esc(group.id) + '"><span class="chat-msg-mark-time"></span><div class="chat-msg-body">' +
      '<details class="chat-steps" data-chat-steps="' + esc(group.dispatchId) + '"' + (options.open ? ' open' : '') + '>' +
      '<summary><span class="chat-steps-title' + (options.live ? ' chat-thinking-shimmer' : '') + '">' + esc(summary(group, options.live)) + '</span>' +
      '<svg class="chat-steps-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>' +
      '<div class="chat-steps-list">' + list + '</div></details></div></div>';
  }

  return {stepOf: stepOf, groupSteps: groupSteps, summary: summary, html: html};
});
