(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaTeamWorkflows = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  // Team workflows: the words, rules and Hub calls behind the screens in
  // team-workflows-ui.js. No DOM here, so all of it can be tested.
  var ID = /^[a-f0-9]{32}$/;
  var SUMMARY_MAX = 200, NAME_MAX = 120, LABEL_MAX = 80, STEP_MAX = 500, STEPS_MAX = 12, STARTERS_MAX = 10, DEPARTMENT_MAX = 40;
  var DEFINITION_BYTES = 6000;
  var WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  var OPEN_RUNS = ['running', 'waiting', 'paused', 'failed'];

  var MESSAGES = {
    invalid_workflow: 'This workflow has something the company server cannot accept. Check that every step has its text, person and bot.',
    bot_not_ready: 'One of the bots is not ready for that person. The bot needs an approved version and must sit in a channel they joined.',
    name_taken: 'Another workflow already has this name. Choose a different one.',
    workflow_limit: 'This company already has 50 workflows. Archive one before adding another.',
    version_already_approved: 'This version was already approved.',
    version_rejected: 'This version was already rejected. Save a new version instead.',
    version_superseded: 'A newer version has replaced this one, so it can no longer be approved. To use it again, propose it as a new version.',
    idempotency_conflict: 'This was already sent with different details. Close it and start again.',
    not_a_starter: 'You are not one of the people who can start this workflow.',
    workflow_not_published: 'This workflow has no approved version yet.',
    workflow_paused: 'This workflow is paused. Resume it first.',
    run_limit: 'This company has 50 workflows in progress. Wait for one to finish, or cancel one.',
    invalid_summary: 'Write the summary as one line, up to 200 characters.',
    invalid_run: 'The company server refused this because it does not match the run. Nothing was shared.',
    invalid_fix: 'That person cannot take this step. They must be in the workflow\'s channel, and the approver must be someone else.',
    not_fixer: 'Only the person named on this step or an admin can fix it.',
    step_not_paused: 'This step is no longer paused.',
    run_not_active: 'This workflow run has already ended.',
    run_finished: 'This workflow run has already finished, so it takes no more files.',
    already_decided: 'Someone already decided this.',
    self_approval: 'You own this step, so someone else has to approve it.',
    not_approver: 'Only the named approver or an admin can decide this.',
    invalid_note: 'Write the note as one line, up to 200 characters.',
    invalid_department: 'Write the department as one line, up to 40 characters.',
    forbidden: 'Only the person who started this run or an admin can do that.',
    writes_paused: 'The company server is not taking changes right now. Try again shortly.',
    step_gone: 'This step has moved on. There is nothing left to do here.',
    step_changed: 'This step changed after you saw it. Check the new details, then choose again.',
    step_paused: 'This step is paused. Someone has to fix it before it can run.',
    step_not_queued: 'This step is no longer waiting to run.',
    no_file_tools: 'This Mia can only search the web, so it cannot open the files this step needs.',
    step_running: 'This step is already running on this computer.',
    steps_busy: 'Mia is busy with other steps on this computer. Try again in a moment.',
    step_claimed: 'Another of your computers is working on this step.',
    bot_runtime_unavailable: 'Mia cannot run bots right now. Restart Mia and try again.',
    hub_unavailable: 'Mia cannot reach the company server. Your work is safe; try again shortly.',
    account_mismatch: 'This computer is signed in with a different account than this company expects.',
    account_changed: 'Your account changed while this was running. Try again.',
    account_not_linked: 'Sign in again to run company workflows on this computer.',
    account_unavailable: 'Sign in again to run company workflows on this computer.',
    hub_sign_in_required: 'Sign in again to run company workflows on this computer.'
  };
  function errorMessage(error, fallback){
    var code = error && error.code;
    if(code && MESSAGES[code]) return MESSAGES[code];
    if(error && (!error.status || error.status >= 500)) return MESSAGES.hub_unavailable;
    return fallback || (error && error.message) || 'That did not work. Try again.';
  }

  // ---- Names ----------------------------------------------------------------------------
  // members: the rows of GET /members. Returns subject -> member.
  function directory(members){
    var map = {};
    (members || []).forEach(function(member){ if(member && member.clerk_user_id) map[member.clerk_user_id] = member; });
    return map;
  }
  function shortName(people, subject){
    if(subject === 'system:schedule') return 'The schedule';
    var member = people && people[subject];
    if(!member) return subject ? 'A colleague' : 'Nobody';
    return String(member.display_name || member.email || 'Someone').trim();
  }
  function displayName(people, subject){
    var member = people && people[subject], name = shortName(people, subject);
    var department = member && String(member.department || '').trim();
    return department ? name + ' · ' + department : name;
  }
  function possessive(name){ return /s$/i.test(name) ? name + '’' : name + '’s'; }

  // ---- Time -----------------------------------------------------------------------------
  function sinceText(seconds, now){
    if(!seconds) return '';
    var age = Math.max(0, Math.floor((now || Date.now()) / 1000) - seconds);
    if(age < 60) return 'just now';
    if(age < 3600) return Math.floor(age / 60) + (Math.floor(age / 60) === 1 ? ' minute ago' : ' minutes ago');
    if(age < 86400) return Math.floor(age / 3600) + (Math.floor(age / 3600) === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(age / 86400);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  // ---- States ---------------------------------------------------------------------------
  var RUN_STATES = {
    running: {label: 'Running', tone: 'working'}, waiting: {label: 'Waiting for approval', tone: 'waiting'},
    paused: {label: 'Paused', tone: 'attention'}, failed: {label: 'Failed', tone: 'bad'},
    done: {label: 'Done', tone: 'good'}, rejected: {label: 'Rejected', tone: 'bad'}, cancelled: {label: 'Cancelled', tone: 'quiet'}
  };
  function runState(state){ return RUN_STATES[state] || {label: 'Unknown', tone: 'quiet'}; }
  function isOpenRun(run){ return !!run && OPEN_RUNS.indexOf(run.state) >= 0; }
  var PAUSED_REASONS = {
    owner_missing: 'The person who owned this step is no longer available.',
    bot_missing: 'The bot for this step is no longer available.',
    approver_missing: 'The approver for this step is no longer available.',
    stuck: 'This step waited 24 hours without starting.'
  };
  function pausedReason(reason){ return PAUSED_REASONS[reason] || 'This step needs someone to look at it.'; }
  // Maps a step state to the marks the Automations page already draws.
  var STEP_MARKS = {done: 'done', working: 'working', claimed: 'working', queued: 'unreported', waiting: 'unreported', failed: 'failed', rejected: 'failed', paused: 'needs_you', cancelled: 'skipped'};
  function stepMark(state){ return STEP_MARKS[state] || 'pending'; }
  function stepMarkOf(step){ return step.state === 'done' && step.outcome === 'partial' ? 'partial' : stepMark(step.state); }
  // The line under a step. A queued step waits for its owner's own computer,
  // which is the normal case, so it reads as waiting and never as a problem.
  function stepLine(step, people, now){
    var owner = shortName(people, step.owner_id);
    switch(step.state){
      case 'pending': return 'Not started yet';
      case 'queued': {
        var since = sinceText(step.queued_at, now);
        return 'Waiting for ' + possessive(owner) + ' Mia' + (since ? ' \u00b7 ' + since : '') + (step.interrupted ? ' (it was interrupted and needs a decision)' : '');
      }
      case 'claimed': return 'Starting on ' + possessive(owner) + ' Mia';
      case 'working': return 'Bot is working on ' + possessive(owner) + ' Mia';
      case 'waiting': return 'Waiting for ' + shortName(people, step.approver_id) + ' to approve';
      case 'done': return step.outcome === 'partial' ? 'Partly done' : 'Done';
      case 'rejected': return 'Rejected';
      case 'failed': return 'Failed';
      case 'paused': return pausedReason(step.paused_reason);
      case 'cancelled': return 'Cancelled';
      default: return '';
    }
  }
  function runLine(run, people, now){
    var current = run && run.current;
    if(!current) return runState(run && run.state).label;
    return 'Step ' + current.n + (run.step_count ? ' of ' + run.step_count : '') + ': ' + stepLine(current, people, now);
  }

  // ---- What this person may do ----------------------------------------------------------
  function canCancel(run, me, isAdmin){ return isOpenRun(run) && (!!isAdmin || (!!me && run.started_by === me)); }
  function canRetry(step, me, isAdmin){ return !!step && step.state === 'failed' && (!!isAdmin || (!!me && step.owner_id === me)); }
  function canFix(step, me, isAdmin){ return !!step && step.state === 'paused' && (!!isAdmin || (!!me && step.fixer_id === me)); }
  function canStart(workflow, me){
    var trigger = workflow && workflow.definition && workflow.definition.trigger;
    return !!(workflow && workflow.enabled && workflow.published && trigger && trigger.kind === 'flag' && (trigger.starters || []).indexOf(me) >= 0);
  }

  // ---- The privacy gate -----------------------------------------------------------------
  function cleanLine(text){ return String(text == null ? '' : text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
  function randomId(){
    var bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  // Exactly these two keys. The Hub refuses anything else, and so does this.
  function startBody(id, summary){
    var line = cleanLine(summary);
    if(!ID.test(id || '')) throw Object.assign(new Error('invalid_run'), {code: 'invalid_run'});
    if(!line || line.length > SUMMARY_MAX) throw Object.assign(new Error('invalid_summary'), {code: 'invalid_summary'});
    return {id: id, summary: line};
  }

  // ---- Triggers and definitions ---------------------------------------------------------
  function titleCase(word){ return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''; }
  function triggerLine(trigger){
    if(!trigger) return '';
    if(trigger.kind === 'flag') return 'Starts when someone flags: ' + trigger.label;
    var s = trigger.schedule || {};
    switch(s.frequency){
      case 'daily': return (s.weekdaysOnly ? 'Every weekday' : 'Every day') + ' at ' + s.time + ' (' + s.timezone + ')';
      case 'weekly': return 'Every ' + titleCase(s.day) + ' at ' + s.time + ' (' + s.timezone + ')';
      case 'monthly': return 'On day ' + s.day + ' of each month at ' + s.time + ' (' + s.timezone + ')';
      case 'interval': return 'Every ' + s.intervalMinutes + ' minutes';
      default: return 'On a schedule';
    }
  }
  function localTimezone(){
    try { return root.Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch(_){ return 'UTC'; }
  }
  function blankStep(){ return {text: '', ownerMemberId: '', botId: '', approverMemberId: ''}; }
  function blankDraft(timezone){
    return {name: '', channelId: '', triggerKind: 'schedule', frequency: 'daily', weekdaysOnly: true, time: '09:00', timezone: timezone || localTimezone(),
      weekday: 'monday', monthDay: '1', intervalMinutes: '60', label: '', starters: [], steps: [blankStep()], remindMemberId: '', escalate: true};
  }
  // A saved definition back into the form's flat shape.
  function draftFromWorkflow(workflow, timezone){
    var draft = blankDraft(timezone), definition = workflow.definition || {};
    draft.id = workflow.id; draft.name = workflow.name; draft.channelId = workflow.channel_id;
    var trigger = definition.trigger;
    if(trigger && trigger.kind === 'flag'){
      draft.triggerKind = 'flag'; draft.label = trigger.label || ''; draft.starters = (trigger.starters || []).slice();
    } else if(trigger && trigger.schedule){
      var s = trigger.schedule;
      draft.frequency = s.frequency || 'daily'; draft.time = s.time || draft.time; draft.timezone = s.timezone || draft.timezone;
      draft.weekdaysOnly = !!s.weekdaysOnly;
      if(s.frequency === 'weekly') draft.weekday = s.day;
      if(s.frequency === 'monthly') draft.monthDay = String(s.day);
      if(s.frequency === 'interval') draft.intervalMinutes = String(s.intervalMinutes);
    }
    if(Array.isArray(definition.steps) && definition.steps.length){
      draft.steps = definition.steps.map(function(step){
        return {text: step.text || '', ownerMemberId: step.ownerMemberId || '', botId: step.botId || '', approverMemberId: step.approverMemberId || ''};
      });
    }
    if(definition.stuck){
      draft.escalate = definition.stuck.escalate !== false;
      draft.remindMemberId = definition.stuck.remind && definition.stuck.remind.kind === 'member' ? definition.stuck.remind.memberId : '';
    }
    return draft;
  }
  function validTimezone(name){
    try { new root.Intl.DateTimeFormat('en-US', {timeZone: name}); return true; } catch(_){ return false; }
  }
  // The form's flat shape into exactly what the Hub accepts, with every problem
  // named in the person's words. Returns {definition, errors}.
  function buildDefinition(draft){
    var errors = [], trigger;
    if(draft.triggerKind === 'flag'){
      var label = cleanLine(draft.label);
      if(!label || label.length > LABEL_MAX) errors.push('Write what flags this workflow, up to ' + LABEL_MAX + ' characters.');
      var starters = (draft.starters || []).filter(Boolean);
      if(!starters.length || starters.length > STARTERS_MAX) errors.push('Choose between 1 and ' + STARTERS_MAX + ' people who can start this workflow.');
      trigger = {kind: 'flag', label: label, starters: starters};
    } else {
      var schedule = {frequency: draft.frequency};
      if(draft.frequency === 'interval'){
        var minutes = Number(draft.intervalMinutes);
        if(!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) errors.push('Run it every 15 to 1440 minutes.');
        schedule.intervalMinutes = minutes;
      } else {
        if(!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.time || '')) errors.push('Choose a time of day.');
        schedule.time = draft.time;
        if(draft.frequency === 'daily' && draft.weekdaysOnly) schedule.weekdaysOnly = true;
        if(draft.frequency === 'weekly'){
          if(WEEKDAYS.indexOf(draft.weekday) < 0) errors.push('Choose a day of the week.');
          schedule.day = draft.weekday;
        }
        if(draft.frequency === 'monthly'){
          var day = Number(draft.monthDay);
          if(!Number.isInteger(day) || day < 1 || day > 28) errors.push('Choose a day of the month from 1 to 28.');
          schedule.day = day;
        }
      }
      if(draft.frequency !== 'interval' && !validTimezone(draft.timezone)) errors.push('That time zone is not recognised. Use a name like America/Monterrey.');
      if(draft.frequency !== 'interval') schedule.timezone = draft.timezone;
      trigger = {kind: 'schedule', schedule: schedule};
    }
    var list = draft.steps || [];
    if(!list.length || list.length > STEPS_MAX) errors.push('A workflow has between 1 and ' + STEPS_MAX + ' steps.');
    var steps = list.map(function(step, index){
      var n = index + 1, text = cleanLine(step.text), out = {text: text, botId: step.botId, ownerMemberId: step.ownerMemberId};
      if(!text || text.length > STEP_MAX) errors.push('Step ' + n + ': say what the bot should do, up to ' + STEP_MAX + ' characters.');
      if(!step.ownerMemberId) errors.push('Step ' + n + ': choose who owns it.');
      if(!ID.test(step.botId || '')) errors.push('Step ' + n + ': choose a bot.');
      if(step.approverMemberId){
        if(step.approverMemberId === step.ownerMemberId) errors.push('Step ' + n + ': the approver must be someone other than the owner.');
        out.approverMemberId = step.approverMemberId;
      }
      return out;
    });
    var definition = {trigger: trigger, steps: steps,
      stuck: {remind: draft.remindMemberId ? {kind: 'member', memberId: draft.remindMemberId} : {kind: 'channel'}, escalate: draft.escalate !== false}};
    if(!errors.length && byteLength(JSON.stringify(definition)) > DEFINITION_BYTES) errors.push('This workflow is too long to save. Shorten the step text.');
    return {definition: definition, errors: errors};
  }
  function byteLength(text){ return root.TextEncoder ? new root.TextEncoder().encode(text).length : String(text).length; }
  function checkDraft(draft){
    var built = buildDefinition(draft), errors = built.errors.slice();
    var name = cleanLine(draft.name);
    if(!name || name.length > NAME_MAX) errors.unshift('Give the workflow a name, up to ' + NAME_MAX + ' characters.');
    if(!draft.id && !ID.test(draft.channelId || '')) errors.unshift('Choose the channel this workflow belongs to.');
    return {name: name, definition: built.definition, errors: errors};
  }
  // Only channels people can join, not groups or direct messages.
  function regularChannels(channels){
    return (channels || []).filter(function(channel){ return channel && channel.kind === 'channel' && !channel.archived; });
  }
  // Bots usable in a workflow: an approved published definition. Flat, deduped.
  function botOptions(groups){
    var seen = {}, out = [];
    (groups || []).forEach(function(group){
      (group.bots || []).forEach(function(bot){
        if(!bot || !ID.test(bot.id || '') || seen[bot.id]) return;
        if(bot.published === false || bot.published === null || (bot.admission && bot.admission.status === 'rejected')) return;
        seen[bot.id] = true;
        out.push({id: bot.id, name: bot.name || 'Bot', channel: group.channel && group.channel.name || ''});
      });
    });
    return out;
  }
  function latestProposal(workflow){
    var versions = (workflow && workflow.versions) || [];
    return versions.filter(function(v){ return v.state === 'proposed'; }).sort(function(a, b){ return b.version - a.version; })[0] || null;
  }
  function workflowStatus(workflow){
    if(!workflow.published) return {label: 'Waiting for approval', tone: 'waiting'};
    if(!workflow.enabled) return {label: 'Paused', tone: 'quiet'};
    return {label: 'On', tone: 'good'};
  }

  // ---- Hub calls ------------------------------------------------------------------------
  function createClient(options){
    var call = options.call, base = '/v1/teams/' + options.teamId;
    if(!ID.test(options.teamId || '')) throw new Error('invalid_team');
    function seg(id){ if(!ID.test(id || '')) throw Object.assign(new Error('not_found'), {code: 'not_found', status: 404}); return id; }
    function num(n){ if(!Number.isSafeInteger(n) || n < 1) throw Object.assign(new Error('not_found'), {code: 'not_found', status: 404}); return n; }
    return {
      teamId: options.teamId,
      members: function(){ return call('GET', base + '/members'); },
      channels: function(){ return call('GET', base + '/channels'); },
      workflows: function(){ return call('GET', base + '/workflows'); },
      workflow: function(id){ return call('GET', base + '/workflows/' + seg(id)); },
      create: function(body){ return call('POST', base + '/workflows', {id: seg(body.id), name: body.name, channelId: seg(body.channelId), definition: body.definition}); },
      propose: function(id, definition){ return call('POST', base + '/workflows/' + seg(id) + '/versions', {definition: definition}); },
      approveVersion: function(id, version){ return call('POST', base + '/workflows/' + seg(id) + '/versions/' + num(version) + '/approve', {}); },
      rejectVersion: function(id, version){ return call('POST', base + '/workflows/' + seg(id) + '/versions/' + num(version) + '/reject', {}); },
      setEnabled: function(id, enabled){ return call('PATCH', base + '/workflows/' + seg(id), {enabled: !!enabled}); },
      archive: function(id){ return call('DELETE', base + '/workflows/' + seg(id), {}); },
      start: function(id, runId, summary){ return call('POST', base + '/workflows/' + seg(id) + '/runs', startBody(runId, summary)); },
      runs: function(state, workflowId){
        var query = '?state=' + (['active', 'recent', 'all'].indexOf(state) >= 0 ? state : 'active');
        return call('GET', base + '/workflow-runs' + query + (workflowId ? '&workflow=' + seg(workflowId) : ''));
      },
      run: function(id){ return call('GET', base + '/workflow-runs/' + seg(id)); },
      cancel: function(id){ return call('POST', base + '/workflow-runs/' + seg(id) + '/cancel', {}); },
      retry: function(id, n){ return call('POST', base + '/workflow-runs/' + seg(id) + '/steps/' + num(n) + '/retry', {}); },
      fix: function(id, n, body){
        var out = {ownerMemberId: body.ownerMemberId, botId: seg(body.botId)};
        if(body.approverMemberId) out.approverMemberId = body.approverMemberId;
        return call('POST', base + '/workflow-runs/' + seg(id) + '/steps/' + num(n) + '/fix', out);
      },
      approvals: function(state){ return call('GET', base + '/workflow-approvals?state=' + (['pending', 'decided', 'all'].indexOf(state) >= 0 ? state : 'pending')); },
      decide: function(id, decision){ return call('POST', base + '/workflow-approvals/' + seg(id) + '/' + (decision === 'approve' ? 'approve' : 'reject'), {}); }
    };
  }

  // ---- The queue on this computer -------------------------------------------------------
  // Keeps one team's steps moving: wake on an event, otherwise look once a
  // minute. The backend does the work; this only says when, and carries back
  // what needs the person.
  function createQueue(options){
    var post = options.post, teamId = options.teamId, every = options.everyMs || 60000;
    var setTimer = options.setTimeout || function(fn, ms){ return root.setTimeout(fn, ms); };
    var clearTimer = options.clearTimeout || function(handle){ root.clearTimeout(handle); };
    var state = {available: null, running: 0, queued: 0, needsYou: [], error: null};
    var stopped = false, busy = false, again = false, timer = null;
    function schedule(ms){ if(stopped) return; if(timer) clearTimer(timer); timer = setTimer(wake, ms); }
    function wake(){
      if(stopped) return Promise.resolve(state);
      if(busy){ again = true; return Promise.resolve(state); }
      busy = true;
      return post('/workflow/poll', {teamId: teamId}).then(function(result){
        state = {available: !!result.available, running: result.running || 0, queued: result.queued || 0, needsYou: result.needsYou || [], error: null};
      }, function(error){
        state = Object.assign({}, state, {error: error});
      }).then(function(){
        busy = false;
        if(stopped) return state;
        if(options.onChange) options.onChange(state);
        // Look again soon while a step runs, so a finished one's report and the
        // next queued step are not left a whole minute.
        var next = again ? 0 : state.running > 0 ? Math.min(every, 15000) : every;
        again = false;
        schedule(next);
        return state;
      });
    }
    return {
      wake: wake,
      state: function(){ return state; },
      // `digest` names the exact content the person saw, so their answer covers only that.
      resume: function(runId, n, action, digest){
        var body = {teamId: teamId, runId: runId, n: n, action: ['fail', 'send', 'done'].indexOf(action) >= 0 ? action : 'run'};
        if(digest) body.digest = digest;
        return post('/workflow/resume', body).then(function(result){ wake(); return result; }, function(error){ wake(); throw error; });
      },
      stop: function(){ stopped = true; if(timer) clearTimer(timer); timer = null; }
    };
  }

  return {
    ID: ID, SUMMARY_MAX: SUMMARY_MAX, NAME_MAX: NAME_MAX, LABEL_MAX: LABEL_MAX, STEP_MAX: STEP_MAX, STEPS_MAX: STEPS_MAX, DEPARTMENT_MAX: DEPARTMENT_MAX, WEEKDAYS: WEEKDAYS,
    errorMessage: errorMessage, directory: directory, shortName: shortName, displayName: displayName, sinceText: sinceText,
    runState: runState, isOpenRun: isOpenRun, pausedReason: pausedReason, stepMark: stepMark, stepMarkOf: stepMarkOf, stepLine: stepLine, runLine: runLine,
    canCancel: canCancel, canRetry: canRetry, canFix: canFix, canStart: canStart,
    cleanLine: cleanLine, randomId: randomId, startBody: startBody, triggerLine: triggerLine, titleCase: titleCase, localTimezone: localTimezone,
    blankStep: blankStep, blankDraft: blankDraft, draftFromWorkflow: draftFromWorkflow, buildDefinition: buildDefinition, checkDraft: checkDraft,
    regularChannels: regularChannels, botOptions: botOptions, latestProposal: latestProposal, workflowStatus: workflowStatus,
    createClient: createClient, createQueue: createQueue
  };
});
