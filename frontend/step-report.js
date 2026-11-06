(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaStepReport = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The report a bot leaves when it finishes a piece of work: the closing block it
  // is asked to write, the reading of that block, and how a report looks on screen.
  // Team workflows use it today. It knows nothing about workflows, so automations
  // can use it too. The Hub's field names live here and nowhere else.
  var LIMIT = 800, NOTE_MAX = 200, LAST_MESSAGE_MAX = 4000;
  var REQUIRED = ['did', 'how', 'failed', 'next'];
  var FIELDS = REQUIRED.concat('decision');
  var OUTCOMES = {done: 'Done', partial: 'Partly done', failed: 'Failed'};
  var LABELS = {RESULT: 'result', DID: 'did', HOW: 'how', 'FAILED OR UNCHECKED': 'failed', NEXT: 'next', 'NEEDS A DECISION': 'decision'};
  var LINE = /^(RESULT|DID|HOW|FAILED\s+OR\s+UNCHECKED|NEXT|NEEDS\s+A\s+DECISION)\s*:[\s*_`]*(.*)$/i;
  var TITLES = {did: 'What it did', how: 'How', failed: 'Failed or not checked', next: 'Suggested next', decision: 'Needs a decision'};

  function points(text){ return Array.from(String(text)); }
  // One line the Hub will accept. It refuses control characters, line and paragraph
  // separators, lone surrogates and invisible format characters. Only the zero-width
  // joiner and non-joiner stay, because emoji sequences and some scripts need them.
  function oneLine(text, max){
    var limit = max === undefined ? NOTE_MAX : max;
    var clean = String(text == null ? '' : text).replace(/(?![\u200c\u200d])\p{Cf}|\p{Cs}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    var all = points(clean);
    return all.length <= limit ? clean : all.slice(0, Math.max(0, limit - 1)).join('').trimEnd() + '\u2026';
  }
  function withAddition(note, addition){
    if(!addition) return note;
    return oneLine(note, NOTE_MAX - points(addition).length - 1) + ' ' + addition;
  }
  function totalLength(report){
    return FIELDS.reduce(function(sum, field){ return sum + (report[field] ? points(report[field]).length : 0); }, 0);
  }
  // The block a bot is asked to end with. The wording is the contract with the parser.
  function closingBlock(){
    return ['End your reply with exactly this block, one line per section, at most ' + LIMIT + ' characters in total:',
      'RESULT: done | partial | failed', 'DID: ...', 'HOW: ...',
      'FAILED OR UNCHECKED: Nothing, or what failed or wasn\'t checked', 'NEXT: ...',
      'NEEDS A DECISION: only if someone has to decide something', '',
      'The whole company sees this block, so leave out file paths, account names, customer details and secrets. The app lists shared files itself. Describe how you worked in a sentence, not a log of commands.',
      'Say what you did not check. "Nothing" means no failures and nothing left unchecked.',
      'NEXT is a suggestion. If a choice belongs to a person, put it under NEEDS A DECISION instead of guessing, and leave that line out if there is none.',
      'The rest of your reply never leaves this computer.'].join('\n');
  }
  var hasWords = function(text){ return /[\p{L}\p{N}]/u.test(text); };
  var saysNothing = function(text){ return /^(nothing|none)[.!]?$/i.test(text); };
  var noDecision = function(text){
    return !hasWords(text) || /^(nothing|none|no|n\/?a|no decision( needed)?)[.!]?$/i.test(text) || /^only if someone has to decide/i.test(text);
  };
  function lastMessage(reply){ return points(String(reply == null ? '' : reply).trim()).slice(0, LAST_MESSAGE_MAX).join(''); }
  // Reads the block at the very end of a reply.
  // send: complete, and the bot's claim holds up. partial: complete, but it names a gap,
  // so its owner decides. unclear: anything else. None of it counts as done, and only
  // the owner ever sees `lastMessage`.
  function readReply(reply){
    var text = String(reply == null ? '' : reply).trim();
    var unclear = {kind: 'unclear', why: [], lastMessage: lastMessage(text)};
    var lines = text.split(/\r?\n/).map(function(line){ return line.replace(/^[\s*_#>`-]+/, '').replace(/[\s*_`]+$/, ''); }).filter(Boolean);
    var start = -1;
    lines.forEach(function(line, index){ var match = LINE.exec(line); if(match && LABELS[match[1].toUpperCase().replace(/\s+/g, ' ')] === 'result') start = index; });
    if(start < 0) return unclear;
    var found = {};
    for(var i = start; i < lines.length; i++){
      var match = LINE.exec(lines[i]);
      if(!match) return unclear;
      var key = LABELS[match[1].toUpperCase().replace(/\s+/g, ' ')];
      if(Object.prototype.hasOwnProperty.call(found, key)) return unclear;
      found[key] = oneLine(match[2], 1e6);
    }
    var result = String(found.result || '').replace(/[.!]+$/, '').toLowerCase();
    if(!Object.prototype.hasOwnProperty.call(OUTCOMES, result)) return unclear;
    var report = {};
    for(var r = 0; r < REQUIRED.length; r++){
      if(!found[REQUIRED[r]] || !hasWords(found[REQUIRED[r]])) return unclear;
      report[REQUIRED[r]] = found[REQUIRED[r]];
    }
    if(found.decision && !noDecision(found.decision)) report.decision = found.decision;
    if(totalLength(report) > LIMIT) return unclear;
    var nothing = saysNothing(report.failed), note = oneLine(report.did);
    if(result === 'done' && nothing) return {kind: 'send', outcome: 'done', note: note, report: report};
    if(result === 'failed' && !nothing) return {kind: 'send', outcome: 'failed', note: note, report: report};
    if(nothing) return unclear;
    return {kind: 'partial', outcome: 'partial', note: note, report: report, saidDone: result === 'done', why: result === 'done' ? ['said_done'] : []};
  }
  // A report as the Hub hands it back, or null for an older step or a garbled one.
  function normalize(report){
    if(!report || typeof report !== 'object') return null;
    var out = {};
    for(var i = 0; i < REQUIRED.length; i++){
      var value = report[REQUIRED[i]];
      if(typeof value !== 'string' || !value.trim()) return null;
      out[REQUIRED[i]] = value;
    }
    if(typeof report.decision === 'string' && report.decision.trim()) out.decision = report.decision;
    return out;
  }
  // Each field on one line, for text that goes into a prompt.
  function cleaned(report){
    var out = {};
    FIELDS.forEach(function(field){ if(report[field]) out[field] = oneLine(report[field], LIMIT); });
    return out;
  }
  // Adds a sentence to what the bot did, staying within the Hub's limit.
  function addToDid(report, addition){
    if(!addition) return report;
    var out = Object.assign({}, report, {did: report.did + ' ' + addition});
    for(var over = totalLength(out) - LIMIT; over > 0; over = totalLength(out) - LIMIT){
      var longest = FIELDS.filter(function(field){ return out[field]; }).sort(function(a, b){ return points(out[b]).length - points(out[a]).length; })[0];
      out[longest] = oneLine(out[longest], points(out[longest]).length - over);
    }
    return out;
  }
  // For when there is no usable report from the bot. None of this comes from its reply.
  function failureReport(reason){
    return {did: 'This step did not finish.', how: 'Mia wrote this report itself, because the bot left none.', failed: reason, next: 'Someone should look at this step.'};
  }
  function confirmedReport(){
    return {did: 'The step owner marked this step as done.', how: 'The bot left no complete report, so its owner decided.', failed: 'Not known: the bot left no complete report.', next: 'Check the result before relying on it.'};
  }
  // What goes to the Hub, in today's shape and in the shape an older Hub knows.
  function hubBody(claimId, outcome, note, report, fileIds){
    var body = {claimId: claimId, outcome: outcome, note: note};
    if(report) body.report = report;
    if(fileIds && fileIds.length) body.fileIds = fileIds;
    return body;
  }
  function olderHubBody(claimId, outcome, note, fileIds){
    return hubBody(claimId, outcome === 'partial' ? 'done' : outcome, outcome === 'partial' ? withAddition(note, '(Partly done.)') : note, null, fileIds);
  }
  // ---- On screen. `esc` is the caller's HTML escaper. --------------------------------
  function resultLabel(outcome){ return Object.prototype.hasOwnProperty.call(OUTCOMES, outcome) ? OUTCOMES[outcome] : ''; }
  function decisionHtml(report, esc){
    if(!report || !report.decision) return '';
    return '<div class="step-report-decision"><span class="step-report-decision-label">' + esc(TITLES.decision) + '</span><span>' + esc(report.decision) + '</span></div>';
  }
  function rowsHtml(report, esc){
    return '<dl class="step-report-rows">' + REQUIRED.map(function(field){
      return '<div class="step-report-row"><dt>' + esc(TITLES[field]) + '</dt><dd>' + esc(report[field]) + '</dd></div>';
    }).join('') + '</dl>';
  }
  function headlineHtml(item, esc){
    var label = resultLabel(item.outcome);
    var line = item.report ? item.report.did : item.note;
    return '<div class="step-report-headline">' + (label ? '<span class="step-report-result" data-outcome="' + esc(item.outcome) + '">' + esc(label) + '</span> ' : '') + (line ? '<span>' + esc(line) + '</span>' : '') + '</div>';
  }
  // The result and what was done, a decision always in view, the rest behind "Read report".
  // `keep` names it, so a screen that redraws can leave it open.
  function summaryHtml(item, esc, keep){
    var report = normalize(item.report);
    var shown = {outcome: item.outcome, note: item.note, report: report};
    if(!report) return item.note || resultLabel(item.outcome) ? headlineHtml(shown, esc) : '';
    return '<div class="step-report">' + headlineHtml(shown, esc) + decisionHtml(report, esc)
      + '<details class="step-report-more"' + (keep ? ' data-wf-keep-open="' + esc(keep) + '"' : '') + '><summary>Read report</summary>' + rowsHtml(report, esc) + '</details></div>';
  }
  // The whole report in view, for someone who has to decide on it.
  function fullHtml(item, esc){
    var report = normalize(item.report);
    if(!report) return '';
    return '<div class="step-report">' + (resultLabel(item.outcome) ? headlineHtml({outcome: item.outcome}, esc) : '') + decisionHtml(report, esc) + rowsHtml(report, esc) + '</div>';
  }
  return {LIMIT: LIMIT, NOTE_MAX: NOTE_MAX, FIELDS: FIELDS, oneLine: oneLine, withAddition: withAddition, closingBlock: closingBlock, readReply: readReply, lastMessage: lastMessage, normalize: normalize, cleaned: cleaned,
    addToDid: addToDid, failureReport: failureReport, confirmedReport: confirmedReport, hubBody: hubBody, olderHubBody: olderHubBody,
    resultLabel: resultLabel, decisionHtml: decisionHtml, summaryHtml: summaryHtml, fullHtml: fullHtml};
});
