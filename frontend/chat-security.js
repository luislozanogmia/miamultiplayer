(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiaChatSecurity = factory();
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  var INTERNAL_TAGS = 'think|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal|hidden|reflection|pre[-_ ]?reasoning|system|prompt|tool(?:[-_ ]?call)?|function(?:[-_ ]?call)?|debug';
  var INTERNAL_BLOCK_RE = new RegExp('<(' + INTERNAL_TAGS + ')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'gi');
  var INTERNAL_TAG_RE = new RegExp('<\\/?(?:' + INTERNAL_TAGS + ')\\b[^>]*>', 'gi');
  var INTERNAL_FENCE_RE = /```\s*(?:think|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal|hidden|reflection|pre[-_ ]?reasoning|system|prompt|tool(?:[-_ ]?call)?|function(?:[-_ ]?call)?|debug)\s*\n[\s\S]*?```/gi;
  var LEADING_INTERNAL_RE = new RegExp('^\\s*(?:(?:#{1,6}\\s*)|(?:\\*{1,3}\\s*))?' +
    '(?:pre[-_ ]?reasoning|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal(?:\\s+notes?)?|hidden\\s+thoughts?|system(?:\\s+prompt)?|prompt|tool(?:\\s+trace)?|function(?:\\s+call)?|debug)' +
    '(?:\\s+(?:trace|output|notes?))?\\s*:?\\s*', 'i');
  var SIGNATURE_RE = /^\s*(\[[^\]\n]{1,120}\]\s*)/;
  var FINAL_RE = /(?:^|\n)\s*(?:final\s+answer|answer|response)\s*:?\s*/i;
  var TASK_RE = /(?:^|\n)\s*TASK\s*:\s*/i;
  var PLUMBING_RE = /^\s*(?:session_id\s*:|PROGRESS\s*:|(?:hook|tool|debug(?:ging)?|trace)\s+output\s*:|(?:tool|function|debug(?:ging)?|system|prompt)\s*(?:trace|call|output)?\s*:)/i;

  function removeTags(text){
    return String(text || '').replace(INTERNAL_FENCE_RE, '').replace(INTERNAL_BLOCK_RE, '').replace(INTERNAL_TAG_RE, '');
  }

  function removeLeadingInternal(text){
    var value = String(text || '').replace(/^\s+/, '');
    for(var i = 0; i < 2; i++){
      var heading = LEADING_INTERNAL_RE.exec(value);
      if(!heading) break;
      var body = value.slice(heading[0].length);
      var task = TASK_RE.exec(body);
      var finalLabel = FINAL_RE.exec(body);
      if(task && (!finalLabel || task.index <= finalLabel.index)) value = 'TASK: ' + body.slice(task.index + task[0].length).trim();
      else if(finalLabel) value = body.slice(finalLabel.index + finalLabel[0].length).trim();
      else {
        var blank = /\n\s*\n/.exec(body);
        value = blank ? body.slice(blank.index + blank[0].length).trim() : '';
      }
    }
    return value;
  }

  function sanitizeBotMessage(body){
    var raw = String(body || '').replace(/\r\n/g, '\n');
    var signature = SIGNATURE_RE.exec(raw);
    var content = signature ? raw.slice(signature[0].length) : raw;
    var hadLeadingPre = /^\s*(?:#{1,6}\s*)?(?:pre[-_ ]?reasoning|analysis|reasoning|scratchpad|internal)\b/i.test(content);
    content = removeTags(content);
    content = removeLeadingInternal(content);
    content = content.replace(/^\s*(?:final\s+answer|answer|response)\s*:?\s*/i, '');
    content = content.split('\n').filter(function(line){ return !PLUMBING_RE.test(line); }).join('\n').trim();
    // An unlabelled leading Pre-reasoning block with no final-answer boundary
    // is historical internal content, not a user-facing bot message.
    if(hadLeadingPre && !content) return '';
    if(!content || /^TASK\s*:/i.test(content)) return '';
    return signature ? signature[1] + content : content;
  }

  function normalizeMessages(messages, isHuman){
    return (messages || []).map(function(message){
      if(!message || message.system || (isHuman && isHuman(message.sender))) return message;
      var body = sanitizeBotMessage(message.body);
      if(!body) return null;
      return body === message.body ? message : Object.assign({}, message, {body: body});
    }).filter(Boolean);
  }

  return {
    sanitizeBotMessage: sanitizeBotMessage,
    normalizeMessages: normalizeMessages
  };
});
