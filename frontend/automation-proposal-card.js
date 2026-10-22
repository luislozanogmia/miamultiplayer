(function(root){
  'use strict';

  // The review card under a bot reply that proposes an automation (event
  // metadata.automationProposal), and the status line for run_now
  // (metadata.automationRun). It reuses the bot setup card's layout. Fields
  // are scoped by the event id because several cards can be on screen.

  var WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  // 'weekdays' is a daily schedule with weekdaysOnly; it is only a menu choice.
  var FREQUENCIES = [['daily','Every day'],['weekdays','Weekdays'],['weekly','Every week'],['monthly','Every month'],['interval','Repeating timer']];

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
    var text = run.status === 'started' ? 'Running ' + name + ' now. Its checklist is on the Automations page.'
      : run.status === 'off' ? name + ' is off, so it didn’t run.'
      : run.status === 'denied' ? 'Only the bot owner or a workspace admin can run ' + name + '.'
      : run.status === 'missing' ? name + ' has no scheduled job yet. Open it in Automations and save it again.'
      : name + ' didn’t start. Try again in a moment.';
    return '<div class="automation-run-note" data-automation-run="' + esc(run.automationId || '') + '">' + text + '</div>';
  }

  function answeredHtml(proposal, esc){
    var automation = proposal.automation || {};
    if(proposal.status === 'dismissed'){
      return '<div class="automation-proposal-answered">Not set up: ' + esc(automation.name || 'automation') + '</div>';
    }
    // proposal.schedule: 'scheduled', 'draft' (the bot isn't set up, so
    // nothing runs) or 'pending' (the job sync failed and retries at boot).
    var verb = proposal.schedule === 'draft' || proposal.schedule === 'pending' ? 'Saved'
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
        '<input data-field="timezone" type="text" value="' + esc(schedule.timezone || options.timezone || '') + '" aria-label="Time zone" placeholder="America/Monterrey"></div>';
    return '<div class="agent-setup-card automation-proposal-card" data-automation-proposal="' + esc(eventId) + '" data-frequency="' + esc(choice || '') + '">' +
      '<div class="agent-setup-card-intro">' + (isUpdate ? 'Here’s the change I’d make. Edit anything before saving.' : 'Here’s the automation I’d set up. Edit anything before turning it on.') + '</div>' +
      field('name', 'Name', '<input data-field="name" type="text" maxlength="80" value="' + esc(automation.name || '') + '">') +
      field('goal', 'Goal', '<textarea data-field="goal" rows="2" maxlength="500">' + esc(automation.goal || '') + '</textarea>') +
      field('schedule', 'When', when) +
      field('steps', 'Steps (one per line)', '<textarea data-field="steps" rows="' + Math.min(8, Math.max(3, (automation.steps || []).length + 1)) + '">' + esc((automation.steps || []).join('\n')) + '</textarea>') +
      field('output', 'Output', '<textarea data-field="output" rows="2" maxlength="300">' + esc(automation.output || '') + '</textarea>') +
      '<div class="agent-setup-confirm-copy">' + (isUpdate ? 'Save this change?' : 'Turn on this automation?') + '</div>' +
      '<div class="agent-setup-safety">' + (isUpdate ? 'Nothing changes until you confirm.' : 'Nothing is scheduled until you confirm.') + '</div>' +
      (options.error ? '<div class="agent-setup-error" role="alert">' + esc(options.error) + '</div>' : '') +
      '<div class="agent-setup-actions">' +
        '<button type="button" class="agent-setup-activate" data-automation-decision="accept"' + (options.busy ? ' disabled' : '') + '>' + (options.busy ? 'Saving…' : (isUpdate ? 'Save change' : 'Yes, turn it on')) + '</button>' +
        '<button type="button" class="agent-setup-later" data-automation-decision="dismiss"' + (options.busy ? ' disabled' : '') + '>Not yet</button>' +
      '</div></div>';
  }

  // html(message, {esc, canEdit, busy, error, timezone}) -> '' when the
  // message carries no automation card.
  function html(message, options){
    var metadata = message && message.nativeEvent && message.nativeEvent.metadata;
    if(!metadata) return '';
    var esc = options.esc;
    if(metadata.automationRun) return runHtml(metadata.automationRun, esc);
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

  var api = {html: html, readFields: readFields, scheduleText: scheduleText, changedFields: changedFields};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MiaAutomationProposalCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
