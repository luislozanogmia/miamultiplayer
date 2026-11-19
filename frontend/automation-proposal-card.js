(function(root){
  'use strict';

  // The review card under a bot reply that proposes an automation (event
  // metadata.automationProposal), and the card for run_now
  // (metadata.automationRun) that shows the run's steps as they go. It reuses
  // the bot setup card's layout. Fields are scoped by the event id because
  // several cards can be on screen.

  var board = root.MiaAutomationsBoard || (typeof require === 'function' ? require('./automations-board.js') : null);

  var WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  // 'weekdays' is a daily schedule with weekdaysOnly; it is only a menu choice.
  var FREQUENCIES = [['daily','Every day'],['weekdays','Weekdays'],['weekly','Every week'],['monthly','Every month'],['interval','Repeating timer']];

  var CLOCK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

  function scheduleText(schedule){
    var value = schedule || {};
    var zone = value.timezone ? ' · ' + value.timezone : '';
    if(value.frequency === 'interval') return 'Every ' + value.intervalMinutes + ' minutes';
    if(value.frequency === 'daily') return (value.weekdaysOnly ? 'Weekdays' : 'Every day') + ' at ' + value.time + zone;
    if(value.frequency === 'weekly') return 'Every ' + value.day + ' at ' + value.time + zone;
    if(value.frequency === 'monthly') return 'Day ' + value.day + ' of every month at ' + value.time + zone;
    return 'No schedule';
  }

  // Which fields an update changes, for the "was" hints.
  function changedFields(proposal){
    var before = proposal && proposal.before;
    var after = proposal && proposal.automation;
    if(!before || !after) return {};
    var changed = {};
    ['name','goal','output'].forEach(function(key){ if(String(before[key] || '') !== String(after[key] || '')) changed[key] = before[key] || ''; });
    if(JSON.stringify(before.steps || []) !== JSON.stringify(after.steps || [])) changed.steps = (before.steps || []).join('\n');
    if(scheduleText(before.schedule) !== scheduleText(after.schedule)) changed.schedule = scheduleText(before.schedule);
    return changed;
  }

  function runHtml(run, esc){
    var name = esc(run.name || 'This automation');
    var text = run.status === 'off' ? name + ' is off, so it didn’t run.'
      : run.status === 'denied' ? 'Only the bot owner or a workspace admin can run ' + name + '.'
      : run.status === 'missing' ? name + ' has no scheduled job yet. Open it in Automations and save it again.'
      : name + ' didn’t start. Try again in a moment.';
    return '<div class="automation-run-note" data-automation-run="' + esc(run.automationId || '') + '">' + text + '</div>';
  }

  function durationText(ms){
    if(!(ms >= 0)) return '';
    var seconds = Math.round(ms / 1000);
    if(seconds < 60) return seconds + ' s';
    var minutes = Math.round(seconds / 60);
    if(minutes < 60) return minutes + ' min';
    return Math.floor(minutes / 60) + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
  }

  // How long a card waits for its run to show up before it stops asking.
  var RUN_START_WAIT_MS = 10 * 60 * 1000;

  // The card of a run a bot started from its chat. card: {eventId, botId,
  // automationId, name, since}; checklist: that run's steps from the app, or
  // null while the run has not begun. options: {now, timeText, open}.
  // The app redraws it in place as the run goes, from the card's own
  // attributes, until the card says it is final.
  function runCardHtml(card, checklist, esc, options){
    var opts = options || {};
    var name = esc(card.name || 'This automation');
    var final = checklist ? ['completed', 'failed', 'unknown'].indexOf(checklist.runStatus) >= 0
      : !(opts.now - card.since < RUN_START_WAIT_MS);
    var attrs = ' data-automation-run-card="' + esc(card.eventId || '') + '" data-run-bot="' + esc(card.botId || '') +
      '" data-run-automation="' + esc(card.automationId || '') + '" data-run-name="' + esc(card.name || '') +
      '" data-run-since="' + esc(card.since || '') + '"' + (final ? ' data-run-final' : '');
    var open = '<button type="button" class="automation-proposal-open" data-automation-bot="' + esc(card.botId || '') +
      '" data-automation-open="' + esc(card.automationId || '') + '">Open</button>';
    if(!checklist){
      var waiting = final ? name + ' was asked to run. Its checklist is on the Automations page.' : 'Starting ' + name + '…';
      return '<div class="automation-run-note"' + attrs + '>' + waiting + '</div>';
    }
    var items = checklist.steps || [];
    var count = items.length ? checklist.done + ' of ' + checklist.total : '';
    var time = function(ms){ return ms && opts.timeText ? opts.timeText(ms) : ''; };
    var foot = function(text){ return '<div class="automation-run-foot"><span>' + esc(text) + '</span>' + open + '</div>'; };
    var head = function(mark, title, side){
      return mark + '<span class="automation-run-name">' + title + '</span>' + (side ? '<span class="automation-run-count">' + esc(side) + '</span>' : '');
    };
    if(!final){
      return '<div class="automation-run-card" data-state="running"' + attrs + '><div class="automation-run-head">' +
        head('<span class="automations-live" aria-hidden="true"></span>', name, count) + '</div>' +
        (items.length ? board.stepsHtml(items, esc) : '') +
        foot(time(checklist.startedMs) ? 'Started ' + time(checklist.startedMs) : 'Running now') + '</div>';
    }
    var ran = durationText(checklist.finishedMs - checklist.startedMs);
    var stopped = items.filter(function(item){ return item.state === 'failed' || item.state === 'needs_you'; })[0];
    if(stopped || checklist.runStatus !== 'completed'){
      // Steps after the last one the bot reported on were never reached.
      var reached = 0;
      items.forEach(function(item, index){ if(item.state !== 'pending' && item.state !== 'unreported') reached = index + 1; });
      var rest = items.length - reached;
      var title = !stopped ? name + ' didn’t finish' : (stopped.state === 'failed' ? 'Stopped at step ' : 'Needs you at step ') + stopped.n;
      return '<div class="automation-run-card" data-state="stopped"' + attrs + '><div class="automation-run-head">' +
        head('<span class="automations-step-mark" data-state="' + (stopped ? stopped.state : 'failed') + '"></span>', title, stopped ? card.name || '' : '') + '</div>' +
        (reached ? board.stepsHtml(items.slice(0, reached), esc) : '') +
        (rest > 0 && reached ? '<div class="automation-run-rest">' + rest + ' more step' + (rest === 1 ? '' : 's') + ' not reached</div>' : '') +
        foot(ran ? 'Ran ' + ran : 'Stopped') + '</div>';
    }
    // A finished run folds to one line; the bot's own message has the result.
    var side = [count, ran].filter(Boolean).join(' · ');
    if(!items.length){
      return '<div class="automation-run-card" data-state="done"' + attrs + '><div class="automation-run-head">' +
        head('<span class="automations-step-mark" data-state="done"></span>', name, side || 'Done') + '</div></div>';
    }
    return '<details class="automation-run-card" data-state="done"' + attrs + (opts.open ? ' open' : '') + '><summary class="automation-run-head">' +
      head('<span class="automations-step-mark" data-state="done"></span>', name, side) + '</summary>' +
      board.stepsHtml(items, esc) + foot(time(checklist.startedMs) ? 'Started ' + time(checklist.startedMs) : 'Finished') + '</details>';
  }

  function answeredHtml(proposal, esc){
    var automation = proposal.automation || {};
    if(proposal.status === 'dismissed'){
      return '<div class="automation-proposal-answered">Not set up: ' + esc(automation.name || 'automation') + '</div>';
    }
    // proposal.schedule: 'scheduled', 'draft' (the bot isn't set up, so
    // nothing runs) or 'pending' (the job sync failed and retries at boot).
    // A bot's own save (ask-before-do off) says what it did, not what you did.
    var verb = proposal.appliedByBot ? (proposal.action === 'update' ? 'Automation updated' : 'A new automation was created')
      : proposal.schedule === 'draft' || proposal.schedule === 'pending' ? 'Saved'
      : proposal.action === 'update' ? 'Saved' : 'Turned on';
    var note = proposal.schedule === 'draft' ? ' It will run once this bot is set up; it’s still a draft.'
      : proposal.schedule === 'pending' ? ' It isn’t scheduled yet. Mia will try again when it restarts.'
      : '';
    return '<div class="automation-proposal-answered">' + verb + ': ' + esc(automation.name || 'automation') + ' · ' + esc(scheduleText(automation.schedule)) + '.' + note +
      ' <button type="button" class="automation-proposal-open" data-automation-bot="' + esc(proposal.botId || '') + '" data-automation-open="' + esc(proposal.automationId || '') + '">Open in Automations</button></div>';
  }

  function wasHint(changed, key, esc){
    return Object.prototype.hasOwnProperty.call(changed, key)
      ? '<span class="automation-proposal-was">Was: ' + esc(changed[key] || 'empty') + '</span>' : '';
  }

  function editableHtml(eventId, proposal, options){
    var esc = options.esc;
    // options.draft holds the user's unsaved edits across re-renders.
    var automation = options.draft || proposal.automation || {};
    var schedule = automation.schedule || {};
    var choice = schedule.frequency === 'daily' && schedule.weekdaysOnly ? 'weekdays' : schedule.frequency;
    var changed = changedFields({before: proposal.before, automation: automation});
    var isUpdate = proposal.action === 'update';
    function field(key, label, control){
      return '<label class="agent-setup-field' + (Object.prototype.hasOwnProperty.call(changed, key) ? ' is-changed' : '') + '"><span>' + label + '</span>' + control + wasHint(changed, key, esc) + '</label>';
    }
    var frequency = '<select data-field="frequency">' + FREQUENCIES.map(function(item){
      return '<option value="' + item[0] + '"' + (choice === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    }).join('') + '</select>';
    var day = schedule.frequency === 'weekly'
      ? '<select data-field="day">' + WEEKDAYS.map(function(name){ return '<option' + (schedule.day === name ? ' selected' : '') + '>' + name + '</option>'; }).join('') + '</select>'
      : schedule.frequency === 'monthly'
        ? '<input data-field="day" type="number" min="1" max="31" value="' + esc(schedule.day || '1') + '">'
        : '';
    var when = schedule.frequency === 'interval'
      ? '<div class="agent-setup-schedule-row">' + frequency + '<input data-field="intervalMinutes" type="number" min="1" max="1440" value="' + esc(schedule.intervalMinutes || 60) + '" aria-label="Minutes between runs"></div>'
      : '<div class="agent-setup-schedule-row">' + frequency + day +
        '<input data-field="time" type="time" value="' + esc(schedule.time || '09:00') + '" aria-label="Time">' +
        '<input data-field="timezone" type="text" value="' + esc(schedule.timezone || options.timezone || '') + '" aria-label="Time zone" placeholder="America/Mexico_City"></div>';
    // A compact card: label beside its field, the confirmation and buttons on
    // one closing row, so the whole thing fits in the chat panel.
    return '<div class="agent-setup-card automation-proposal-card" data-automation-proposal="' + esc(eventId) + '" data-frequency="' + esc(choice || '') + '">' +
      '<div class="automation-proposal-head"><span class="automation-proposal-icon" aria-hidden="true">' + CLOCK_ICON + '</span>' +
        '<div><div class="automation-proposal-title">' + (isUpdate ? 'Change to this automation' : 'New automation') + '</div>' +
        '<div class="agent-setup-card-intro">' + (isUpdate ? 'Edit anything before saving.' : 'Edit anything before turning it on.') + '</div></div></div>' +
      field('name', 'Name', '<input data-field="name" type="text" maxlength="80" value="' + esc(automation.name || '') + '">') +
      field('goal', 'Goal', '<textarea data-field="goal" rows="2" maxlength="500">' + esc(automation.goal || '') + '</textarea>') +
      field('schedule', 'When', when) +
      field('steps', 'Steps <i>one per line</i>', '<textarea data-field="steps" rows="' + Math.min(6, Math.max(2, (automation.steps || []).length)) + '">' + esc((automation.steps || []).join('\n')) + '</textarea>') +
      field('output', 'Output', '<textarea data-field="output" rows="2" maxlength="300">' + esc(automation.output || '') + '</textarea>') +
      (options.error ? '<div class="agent-setup-error" role="alert">' + esc(options.error) + '</div>' : '') +
      '<div class="automation-proposal-foot">' +
        '<div class="automation-proposal-confirm"><div class="agent-setup-confirm-copy">' + (isUpdate ? 'Save this change?' : 'Turn on this automation?') + '</div>' +
        '<div class="agent-setup-safety">' + (isUpdate ? 'Nothing changes until you confirm.' : 'Nothing is scheduled until you confirm.') + '</div></div>' +
        '<div class="agent-setup-actions">' +
          '<button type="button" class="agent-setup-later" data-automation-decision="dismiss"' + (options.busy ? ' disabled' : '') + '>Not yet</button>' +
          '<button type="button" class="agent-setup-activate" data-automation-decision="accept"' + (options.busy ? ' disabled' : '') + '>' + (options.busy ? 'Saving…' : (isUpdate ? 'Save change' : 'Yes, turn it on')) + '</button>' +
        '</div></div></div>';
  }

  // html(message, {esc, canEdit, busy, error, timezone}) -> '' when the
  // message carries no automation card. A run card also reads {botId,
  // runChecklist, runOpen, now, timeText}.
  function html(message, options){
    var metadata = message && message.nativeEvent && message.nativeEvent.metadata;
    if(!metadata) return '';
    var esc = options.esc;
    var run = metadata.automationRun;
    if(run && run.status === 'started'){
      return runCardHtml({
        eventId: message.nativeEvent.id, botId: run.botId || options.botId || '', automationId: run.automationId, name: run.name,
        since: Number(run.requestedAt) || Date.parse(message.nativeEvent.createdAt) || 0
      }, options.runChecklist || null, esc, {now: options.now, timeText: options.timeText, open: options.runOpen});
    }
    if(run) return runHtml(run, esc);
    var proposal = metadata.automationProposal;
    if(!proposal || !proposal.automation) return '';
    if(proposal.status !== 'pending') return answeredHtml(proposal, esc);
    if(!options.canEdit){
      return '<div class="automation-proposal-answered">Waiting for the bot owner to review: ' + esc(proposal.automation.name || 'automation') + ' · ' + esc(scheduleText(proposal.automation.schedule)) + '</div>';
    }
    return editableHtml(message.nativeEvent.id, proposal, options);
  }

  // Reads a card's fields back into the schema's automation shape. The
  // server checks everything again.
  function readFields(card){
    function value(name){
      var input = card.querySelector('[data-field="' + name + '"]');
      return input ? String(input.value || '').trim() : '';
    }
    var choice = value('frequency') || card.getAttribute('data-frequency') || 'daily';
    var frequency = choice === 'weekdays' ? 'daily' : choice;
    var schedule = {frequency: frequency};
    if(frequency === 'interval'){
      schedule.intervalMinutes = parseInt(value('intervalMinutes'), 10);
    } else {
      schedule.time = value('time');
      if(value('timezone')) schedule.timezone = value('timezone');
      if(frequency === 'weekly' || frequency === 'monthly') schedule.day = value('day');
      if(choice === 'weekdays') schedule.weekdaysOnly = true;
    }
    return {
      name: value('name'),
      goal: value('goal'),
      schedule: schedule,
      steps: value('steps').split('\n').map(function(step){ return step.trim(); }).filter(Boolean),
      output: value('output')
    };
  }

  // Why a card's answer was refused, in the server's words when it gave any.
  // Only a rejected value (400) is about the fields.
  function saveErrorText(status, data){
    if(status === 409) return 'This card was already answered.';
    if(data && data.message) return String(data.message);
    if(status === 400) return 'That didn’t save. Check the fields and try again.';
    if(status === 403) return 'Only the bot’s owner can answer this card.';
    if(status === 404) return 'Mia could not find this bot or card. Reload Mia and try again.';
    if(status === 401) return 'You are signed out. Sign in and try again.';
    return 'That didn’t save. Try again.';
  }

  var api = {html: html, runCardHtml: runCardHtml, readFields: readFields, scheduleText: scheduleText, changedFields: changedFields, saveErrorText: saveErrorText};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MiaAutomationProposalCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
