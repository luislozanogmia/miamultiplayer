(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiaFeedbackReport = factory();
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  // The anonymized report sent with "Tell us what happened". It is built
  // from a fixed allow-list of fields, so nothing outside this file can widen
  // what leaves the machine. Free-text facts (platform, model family, error
  // codes) must also look like plain labels or they are dropped.
  //
  // Included: app version, OS family/version, CPU architecture, install type,
  // provider and model family, workspace mode, counts of bots / browser tabs /
  // tab groups, recent error codes, time and timezone offset.
  // Never included: names, emails, account or user ids, API keys, tokens,
  // router keys, conversation text, tab URLs or page content, file paths.

  var FEEDBACK_EMAIL = 'hello@mia-labs.com';
  var LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:+()-]{0,47}$/;

  function label(value){
    if(typeof value !== 'string' && typeof value !== 'number') return '';
    var text = String(value).trim();
    if(!LABEL_RE.test(text)) return '';
    // Key- and id-shaped values: prefixed secrets, long unbroken runs.
    if(/(^|[-_ ])(sk|pk|mia|key|tok|token|secret|bearer|user|org|sess|session)[-_][A-Za-z0-9]{6,}/i.test(text)) return '';
    if(/[A-Za-z0-9]{24,}/.test(text)) return '';
    return text;
  }

  function count(value){
    var n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < 100000 ? String(n) : 'unknown';
  }

  function timezone(minutesWestOfUtc){
    var n = Number(minutesWestOfUtc);
    if(!Number.isFinite(n) || Math.abs(n) > 24 * 60) return 'unknown';
    var east = -n;
    var sign = east < 0 ? '-' : '+';
    var abs = Math.abs(east);
    var h = Math.floor(abs / 60);
    var m = abs % 60;
    return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
  }

  function timestamp(value){
    var text = typeof value === 'string' ? value : '';
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text) ? text : 'unknown';
  }

  function buildReport(facts){
    facts = facts && typeof facts === 'object' ? facts : {};
    var counts = facts.counts && typeof facts.counts === 'object' ? facts.counts : {};
    var errors = (Array.isArray(facts.errors) ? facts.errors : []).map(label).filter(Boolean);
    var seen = {};
    errors = errors.filter(function(code){ if(seen[code]) return false; seen[code] = 1; return true; }).slice(-5);
    var os = [label(facts.platform), label(facts.osVersion)].filter(Boolean).join(' ');
    var model = [label(facts.provider), label(facts.modelFamily)].filter(Boolean).join(' / ');
    return [
      'Mia anonymized report',
      'Version: ' + (label(facts.version) || 'unknown'),
      'OS: ' + (os || 'unknown'),
      'Architecture: ' + (label(facts.arch) || 'unknown'),
      'Install: ' + (label(facts.installType) || 'unknown'),
      'Workspace mode: ' + (label(facts.workspaceMode) || 'unknown'),
      'Model: ' + (model || 'none selected'),
      'Bots: ' + count(counts.bots),
      'Browser tabs: ' + count(counts.tabs),
      'Tab groups: ' + count(counts.groups),
      'Recent error codes: ' + (errors.length ? errors.join(', ') : 'none'),
      'Time: ' + timestamp(facts.now) + ' (' + timezone(facts.tzOffsetMinutes) + ')'
    ].join('\n');
  }

  // The preview shows exactly this string and Send mails exactly this string.
  function composeFeedback(note, report){
    return ['Mia beta feedback', '', String(note || '').trim(), '', String(report || '')].join('\n');
  }

  function buildMailto(version, body){
    var v = label(version);
    var subject = v ? 'Mia feedback (v' + v + ')' : 'Mia feedback';
    return 'mailto:' + FEEDBACK_EMAIL +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(String(body || ''));
  }

  return {
    FEEDBACK_EMAIL: FEEDBACK_EMAIL,
    buildReport: buildReport,
    composeFeedback: composeFeedback,
    buildMailto: buildMailto
  };
});
