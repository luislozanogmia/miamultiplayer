(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaTeamWorkflowsUi = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root){
  'use strict';
  // The team workflow screens, drawn inside the Automations page, and the
  // approval card drawn inside channels. Markup is pure (*Html) so it can be
  // tested; the controller below wires it to the Hub. Team workspaces only.
  var wf = root.MiaTeamWorkflows || (typeof require === 'function' ? require('./team-workflows.js') : null);
  var tf = root.MiaTeamFiles || (typeof require === 'function' ? require('./team-files.js') : null);
  var sr = root.MiaStepReport || (typeof require === 'function' ? require('./step-report.js') : null);

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  function btn(label, attrs, kind){
    return '<button type="button" class="artifacts-bar-text-btn' + (kind ? ' ' + kind : '') + '" ' + attrs + '>' + esc(label) + '</button>';
  }
  function statePill(state){ return '<span class="twf-pill" data-tone="' + esc(state.tone) + '">' + esc(state.label) + '</span>'; }
  function backHtml(){ return btn('Back', 'data-wf-back'); }
  function noticeHtml(view){ return view.notice ? '<div class="tf-notice" role="alert">' + esc(view.notice) + '</div>' : ''; }
  function emptyHtml(title, text){ return '<div class="twf-empty"><div class="twf-empty-title">' + esc(title) + '</div><div>' + esc(text) + '</div></div>'; }
  function selectHtml(attrs, options, selected, blank){
    var rows = (blank === undefined ? [] : [{value: '', label: blank}]).concat(options);
    return '<select class="twf-input" ' + attrs + '>' + rows.map(function(o){
      return '<option value="' + esc(o.value) + '"' + (o.value === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('') + '</select>';
  }
  function peopleOptions(list, people){
    return (list || []).map(function(m){ return {value: m.clerk_user_id, label: wf.displayName(people, m.clerk_user_id)}; });
  }
  function botChoices(bots){
    return (bots || []).map(function(b){ return {value: b.id, label: b.channel ? b.name + ' (' + b.channel + ')' : b.name}; });
  }

  // ---- Approval card: the same one in a channel, on the home list and in a run ------------
  function approvalCardHtml(approval, people, options){
    options = options || {};
    if(!approval) return '';
    var id = esc(approval.id), step = 'Step ' + approval.step_n + ' of ' + (approval.workflow_name || 'a workflow');
    var status = {approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', pending: 'Waiting for ' + wf.shortName(people, approval.approver_id)}[approval.state] || approval.state;
    if(approval.decided_by && approval.state !== 'cancelled') status += ' by ' + wf.shortName(people, approval.decided_by);
    var controls = approval.canDecide && approval.state === 'pending'
      ? btn('Approve', 'data-wf-decide="approve" data-wf-approval="' + id + '"', 'primary') + btn('Reject', 'data-wf-decide="reject" data-wf-approval="' + id + '"') : '';
    if(!options.inRun && approval.run_id) controls += btn('Open run', 'data-wf-open-run="' + esc(approval.run_id) + '"');
    return '<div class="twf-approval" data-wf-card="' + id + '"><div class="twf-approval-kicker">Approval needed</div>'
      + '<div class="twf-approval-title">' + esc(step) + '</div>'
      + (approval.run_summary ? '<div class="twf-approval-line">' + esc(approval.run_summary) + '</div>' : '')
      + (approval.step_text ? '<div class="twf-approval-line">' + esc(approval.step_text) + '</div>' : '')
      + (sr.normalize(approval.step_report) ? '<div class="twf-approval-line">' + esc(wf.displayName(people, approval.owner_id)) + ':' + sr.summaryHtml({outcome: approval.step_outcome, note: approval.step_note, report: approval.step_report}, esc, 'report:' + id) + '</div>'
        : approval.step_note ? '<div class="twf-approval-line">' + esc(wf.displayName(people, approval.owner_id)) + ': ' + esc(approval.step_note) + '</div>' : '')
      + '<div class="twf-approval-status">' + esc(status) + '</div>'
      + (controls ? '<div class="twf-actions">' + controls + '</div>' : '')
      + '<div class="twf-feedback" role="status" data-wf-feedback></div></div>';
  }

  // ---- Home --------------------------------------------------------------------------------
  // Everything the owner is agreeing to run, exactly as it was written.
  function stepContentHtml(item, people){
    var out = '<div class="twf-gate"><div class="twf-gate-row"><span class="twf-gate-label">Step</span><span>' + esc(item.text || '') + '</span></div>'
      + '<div class="twf-gate-row"><span class="twf-gate-label">Bot</span><span>' + esc(item.botName || 'Team bot') + '</span></div>';
    if(item.definition){
      out += '<div class="twf-gate-instructions-label">Bot instructions · version ' + Number(item.definition.version) + '</div>'
        + '<pre class="twf-gate-instructions" tabindex="0" data-wf-keep-scroll="instructions:' + esc(item.runId) + ':' + Number(item.n) + '">' + esc(item.definition.instructions) + '</pre>';
    }
    if(item.summary){
      out += '<div class="twf-gate-row"><span class="twf-gate-label">Summary</span><span>' + (item.startedBy ? esc(wf.displayName(people, item.startedBy)) + ': ' : '') + esc(item.summary) + '</span></div>';
    }
    (item.previous || []).forEach(function(step){
      var from = 'Step ' + Number(step.n);
      // In full, because this is what the person agrees to pass to the bot.
      if(sr.normalize(step.report)) out += '<div class="twf-gate-row"><span class="twf-gate-label">' + from + '</span><span>' + esc(wf.displayName(people, step.ownerId)) + sr.fullHtml(step, esc) + '</span></div>';
      else if(step.note) out += '<div class="twf-gate-row"><span class="twf-gate-label">' + from + '</span><span>' + esc(wf.displayName(people, step.ownerId)) + ': ' + esc(step.note) + '</span></div>';
      if((step.files || []).length) out += '<div class="twf-gate-row"><span class="twf-gate-label">Files</span><span>' + step.files.map(esc).join(', ') + '</span></div>';
    });
    return out + '</div>';
  }
  var GATE_WHY = {
    new_version: 'This version of the workflow is new on this computer. Someone else wrote this step and its bot\'s instructions.',
    teammate_text: 'This step carries text or files from teammates. Mia passes them to the bot as information, but they could still try to mislead it.',
    bot_changed: 'This bot\'s instructions changed since you last agreed to run this step.',
    changed_after_ok: 'What this step would run changed after you agreed, so Mia did not run it. Check it again.'
  };
  function needsYouHtml(items, people){
    return (items || []).map(function(item){
      var n = Number(item.n), run = esc(item.runId), where = ' data-wf-run="' + run + '" data-wf-n="' + n + '"';
      var digest = item.digest ? ' data-wf-digest="' + esc(item.digest) + '"' : '';
      var name = esc(item.workflowName || 'A workflow');
      var runButton = function(label, kind){ return item.digest ? btn(label, 'data-wf-resume="run"' + where + digest, kind === undefined ? 'primary' : kind) : ''; };
      var missing = item.digest ? '' : '<div class="twf-card-text">Mia could not load this step\'s details, so it cannot run it yet. It will look again.</div>';
      if(item.reason === 'approval'){
        return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': step ' + n + ' needs your OK to run</div>'
          + (item.why || []).map(function(why){ return GATE_WHY[why] ? '<div class="twf-card-text">' + esc(GATE_WHY[why]) + '</div>' : ''; }).join('')
          + stepContentHtml(item, people)
          + '<div class="twf-card-text">The bot runs on this computer and can use its tools here. Run starts only this one step.</div>'
          + '<div class="twf-actions">' + runButton('Run') + btn('Don\u2019t run it', 'data-wf-resume="fail"' + where) + '</div></div>';
      }
      var reviewed = item.reviewDigest ? ' data-wf-digest="' + esc(item.reviewDigest) + '"' : '';
      var failButton = btn('Mark as failed', 'data-wf-resume="fail"' + where + reviewed);
      var waitingFiles = (item.outputFiles || []).length ? '<div class="twf-card-text">Files waiting to be shared: ' + item.outputFiles.map(esc).join(', ') + '</div>' : '';
      if(item.reason === 'report_partial'){
        return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': step ' + n + ' is only partly done</div>'
          + '<div class="twf-card-text">' + esc((item.why || []).indexOf('said_done') >= 0 ? 'The bot said this step was done, but it also listed something that failed or wasn\'t checked.' : 'The bot finished part of this step.') + ' Nothing has gone to the team yet.</div>'
          + sr.fullHtml({outcome: 'partial', report: item.report}, esc) + waitingFiles
          + '<div class="twf-actions">' + btn('Send as partly done', 'data-wf-resume="send"' + where + reviewed, 'primary') + runButton('Run it again', '') + failButton + '</div></div>';
      }
      if(item.reason === 'report_unclear'){
        return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': did step ' + n + ' finish?</div>'
          + '<div class="twf-card-text">' + esc((item.why || []).indexOf('looks_secret') >= 0 ? 'The bot\'s report looked like it held a password or key, so Mia did not send it.' : 'The bot did not end with a complete report, so Mia can\'t tell.') + ' Nothing has gone to the team yet.</div>'
          + (item.lastMessage ? '<div class="twf-gate-instructions-label">The bot\'s last message. Only you can see this.</div><pre class="twf-gate-instructions" tabindex="0" data-wf-keep-scroll="reply:' + run + ':' + n + '">' + esc(item.lastMessage) + '</pre>' : '<div class="twf-card-text">The bot left no message.</div>')
          + waitingFiles
          + '<div class="twf-actions">' + btn('Mark as done', 'data-wf-resume="done"' + where + reviewed, 'primary') + runButton('Run it again', '') + failButton + '</div></div>';
      }
      if(item.reason === 'instructions_unavailable'){
        return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': step ' + n + ' is waiting</div>'
          + '<div class="twf-card-text">Mia could not read this bot\'s instructions, so the step has not started. It only runs once you can see them. Mia will look again. If this keeps happening, the team server may need an update.</div>'
          + stepContentHtml(item, people)
          + '<div class="twf-actions">' + btn('Don\u2019t run it', 'data-wf-resume="fail"' + where) + '</div></div>';
      }
      if(item.reason === 'no_file_tools'){
        return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': step ' + n + ' cannot run on this Mia</div>'
          + '<div class="twf-card-text">This Mia can only search the web, so it cannot open the files this step needs. Someone with a full Mia has to own this step.</div>'
          + stepContentHtml(item, people)
          + '<div class="twf-actions">' + btn('Mark as failed', 'data-wf-resume="fail"' + where) + '</div></div>';
      }
      return '<div class="twf-card twf-card-attention"><div class="twf-card-title">' + name + ': step ' + n + ' was interrupted</div>'
        + '<div class="twf-card-text">Mia stopped partway through this step, so some of it may already have happened. Running it again could repeat that.</div>'
        + stepContentHtml(item, people) + missing
        + '<div class="twf-actions">' + runButton('Run it again') + btn('Mark as failed', 'data-wf-resume="fail"' + where) + '</div></div>';
    }).join('');
  }
  function runRowHtml(run, people, now){
    var state = wf.runState(run.state);
    return '<button type="button" class="automations-row" data-wf-open-run="' + esc(run.id) + '"><span class="automations-step-mark twf-row-mark" data-state="' + esc(wf.stepMark(run.current ? run.current.state : run.state === 'done' ? 'done' : run.state)) + '"></span>'
      + '<span><div class="automations-row-name">' + esc(run.workflow_name) + (run.summary ? ' · ' + esc(run.summary) : '') + '</div>'
      + '<div class="automations-row-detail">' + esc(wf.isOpenRun(run) ? wf.runLine(run, people, now) : run.final_note || wf.sinceText(run.finished_at, now)) + '</div></span>'
      + '<span class="automations-row-side">' + statePill(state) + '</span></button>';
  }
  function workflowRowHtml(workflow){
    var status = wf.workflowStatus(workflow), trigger = workflow.definition && workflow.definition.trigger;
    return '<button type="button" class="automations-row" data-wf-open-workflow="' + esc(workflow.id) + '"><span class="automations-step-mark twf-row-mark" data-state="pending"></span>'
      + '<span><div class="automations-row-name">' + esc(workflow.name) + '</div>'
      + '<div class="automations-row-detail">' + esc(trigger ? wf.triggerLine(trigger) : 'No approved version yet') + '</div></span>'
      + '<span class="automations-row-side">' + statePill(status) + '</span></button>';
  }
  function queueLineHtml(queue){
    if(!queue) return '';
    if(queue.error) return '<div class="twf-queue-line" data-tone="bad">' + esc(wf.errorMessage(queue.error, 'Mia could not check for your steps. It will try again.')) + '</div>';
    if(queue.running) return '<div class="twf-queue-line">This computer is running ' + (queue.running === 1 ? '1 step' : queue.running + ' steps') + '.</div>';
    return '';
  }
  // view: {loading, error, unavailable, notice, workflows, runs, recent, approvals, needsYou, queue, people, isAdmin, now}
  function homeHtml(view){
    var people = view.people || {}, now = view.now;
    var head = '<div class="twf-head"><div class="automations-group-title twf-section-title">Team workflows</div>'
      + (view.isAdmin && !view.unavailable ? btn('New workflow', 'data-wf-new') : '') + '</div>';
    var out = head + noticeHtml(view);
    if(view.unavailable) return out + emptyHtml('Not on your team yet', 'Your team’s server does not offer team workflows yet. Everything else keeps working, and they will show up here once it does.');
    if(view.loading && !view.workflows) return out + '<div class="twf-empty">Loading…</div>';
    if(view.error && !view.workflows) return out + '<div class="twf-empty">' + esc(view.error) + '<div class="twf-actions twf-center">' + btn('Try again', 'data-wf-reload') + '</div></div>';
    out += queueLineHtml(view.queue) + needsYouHtml(view.needsYou, view.people);
    var approvals = (view.approvals || []).filter(function(a){ return a.canDecide; });
    if(approvals.length) out += '<div class="twf-section-sub">Waiting for your approval</div>' + approvals.map(function(a){ return approvalCardHtml(a, people); }).join('');
    if((view.runs || []).length) out += '<div class="twf-section-sub">In progress</div>' + view.runs.map(function(r){ return runRowHtml(r, people, now); }).join('');
    if((view.workflows || []).length) out += '<div class="twf-section-sub">Workflows</div>' + view.workflows.map(workflowRowHtml).join('');
    else out += emptyHtml('No team workflows yet', view.isAdmin
      ? 'A workflow is one job shared across people. Each step runs on its owner’s computer, with their own bot.'
      : 'An admin can set one up. Each step runs on its owner’s computer, with their own bot.');
    if((view.recent || []).length) out += '<div class="twf-section-sub">Recently finished</div>' + view.recent.slice(0, 10).map(function(r){ return runRowHtml(r, people, now); }).join('');
    return out;
  }

  // ---- A run -------------------------------------------------------------------------------
  function fixCardHtml(step, view){
    var draft = (view.fixDrafts && view.fixDrafts[step.n]) || {}, n = Number(step.n);
    var attr = function(field){ return 'data-wf-fix-field="' + field + '" data-wf-n="' + n + '"'; };
    return '<div class="twf-card twf-card-attention"><div class="twf-card-title">Fix this step</div>'
      + '<div class="twf-card-text">This change applies to this run only. The saved workflow stays as it is.</div>'
      + '<label class="twf-label">Who takes it' + selectHtml(attr('ownerMemberId') + ' aria-label="Who takes it"', peopleOptions(view.channelMembers, view.people), draft.ownerMemberId || '', 'Choose a person') + '</label>'
      + '<label class="twf-label">Which bot' + selectHtml(attr('botId') + ' aria-label="Which bot"', botChoices(view.bots), draft.botId || '', 'Choose a bot') + '</label>'
      + '<label class="twf-label">Who approves' + selectHtml(attr('approverMemberId') + ' aria-label="Who approves"', peopleOptions(view.channelMembers, view.people), draft.approverMemberId || '', step.approver_id ? 'Keep ' + wf.shortName(view.people, step.approver_id) : 'Nobody') + '</label>'
      + '<div class="twf-actions">' + btn('Save the fix', 'data-wf-fix="' + n + '"', 'primary') + '</div></div>';
  }
  function stepFilesHtml(step){
    if(step.files && step.files.length){
      return '<div class="twf-files">' + step.files.map(function(file){
        var ready = file.state === 'ready' || file.state === undefined;
        return '<div class="twf-file"><span>' + esc(file.filename) + ' · ' + esc(tf.formatBytes(file.sizeBytes || 0)) + (ready ? '' : ' · Scanning for viruses') + '</span>'
          + (ready ? btn('Download', 'data-wf-download="' + esc(file.fileId) + '" data-wf-n="' + Number(step.n) + '" aria-label="Download ' + esc(file.filename) + '"') : '') + '</div>';
      }).join('') + '</div>';
    }
    if(step.file_count) return '<div class="automations-step-note">' + step.file_count + (step.file_count === 1 ? ' file' : ' files') + ', visible to the people on this run</div>';
    return '';
  }
  function runStepHtml(step, view){
    var run = view.run, people = view.people, me = view.me;
    var approval = (view.approvals || []).filter(function(a){ return a.step_n === step.n; }).slice(-1)[0];
    var meta = wf.displayName(people, step.owner_id) + (step.bot_name ? ' · ' + step.bot_name : '');
    var hasReport = !!sr.normalize(step.report), mark = esc(wf.stepMarkOf(step));
    var out = '<li class="automations-step" data-state="' + mark + '"><span class="automations-step-n"><span class="automations-step-mark" data-state="' + mark + '"></span>' + Number(step.n) + '</span><span>'
      + '<div>' + esc(step.text) + '</div><div class="automations-step-note">' + esc(meta) + '</div>'
      // The report's own headline says the result, so it is not said twice.
      + (hasReport && (step.state === 'done' || step.state === 'failed') ? '' : '<div class="automations-step-note">' + esc(wf.stepLine(step, people, view.now)) + '</div>');
    if(step.state === 'working' && step.progress_note) out += '<div class="automations-step-note">' + esc(step.progress_note) + '</div>';
    if(hasReport) out += sr.summaryHtml(step, esc, 'report:' + run.id + ':' + step.n);
    else if(step.note) out += '<div class="twf-note">' + esc(step.note) + '</div>';
    out += stepFilesHtml(step);
    if(wf.canRetry(step, me, view.isAdmin) && wf.isOpenRun(run)) out += '<div class="twf-actions">' + btn('Retry this step', 'data-wf-retry="' + Number(step.n) + '"') + '</div>';
    if(approval && approval.state === 'pending') out += approvalCardHtml(approval, people, {inRun: true});
    if(step.state === 'paused'){
      if(wf.canFix(step, me, view.isAdmin)) out += fixCardHtml(step, view);
      else out += '<div class="automations-step-note">' + esc(step.fixer_id ? wf.shortName(people, step.fixer_id) + ' or an admin can fix this.' : 'An admin can fix this.') + '</div>';
    }
    return out + '</span></li>';
  }
  function runHtml(view){
    var run = view.run;
    if(!run) return '<div class="twf-head">' + backHtml() + '</div>' + noticeHtml(view) + '<div class="twf-empty">' + esc(view.error || 'Loading…') + '</div>';
    var state = wf.runState(run.state), started = run.started_by === 'system:schedule' ? 'Started by the schedule' : 'Started by ' + wf.displayName(view.people, run.started_by);
    var mine = (view.needsYou || []).filter(function(item){ return item.runId === run.id; });
    return '<div class="twf-head">' + backHtml() + (wf.canCancel(run, view.me, view.isAdmin) ? btn('Cancel run', 'data-wf-cancel') : '') + '</div>' + noticeHtml(view)
      + '<div class="automations-detail-head"><span><div class="automations-detail-title">' + esc(run.workflow_name) + '</div>'
      + (run.summary ? '<div class="automations-detail-sub">' + esc(run.summary) + '</div>' : '')
      + '<div class="automations-detail-sub">' + esc(started) + ' · ' + esc(wf.sinceText(run.created_at, view.now)) + ' · version ' + Number(run.version) + '</div></span>'
      + '<span class="automations-row-side">' + statePill(state) + '</span></div>'
      + (run.state === 'paused' ? '<div class="twf-card-text">This run stops at the paused step until someone fixes it. It never skips a step.</div>' : '')
      + (run.final_note ? '<div class="twf-note">' + esc(run.final_note) + '</div>' : '')
      + needsYouHtml(mine, view.people)
      + '<ol class="automations-steps">' + (view.steps || []).map(function(step){ return runStepHtml(step, view); }).join('') + '</ol>';
  }

  // ---- A workflow --------------------------------------------------------------------------
  function definitionStepsHtml(definition, people){
    return '<ol class="automations-steps">' + ((definition && definition.steps) || []).map(function(step, index){
      var meta = wf.displayName(people, step.ownerMemberId) + (step.botName ? ' · ' + step.botName : '');
      return '<li class="automations-step"><span class="automations-step-n">' + (index + 1) + '</span><span><div>' + esc(step.text) + '</div>'
        + '<div class="automations-step-note">' + esc(meta) + '</div>'
        + (step.approverMemberId ? '<div class="automations-step-note">Approved by ' + esc(wf.displayName(people, step.approverMemberId)) + '</div>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  function workflowHtml(view){
    var workflow = view.workflow;
    if(!workflow) return '<div class="twf-head">' + backHtml() + '</div>' + noticeHtml(view) + '<div class="twf-empty">' + esc(view.error || 'Loading…') + '</div>';
    var actions = '';
    if(wf.canStart(workflow, view.me)) actions += btn(workflow.definition.trigger.label || 'Start', 'data-wf-start', 'primary');
    if(view.isAdmin){
      actions += btn('Edit', 'data-wf-edit');
      if(workflow.published) actions += btn(workflow.enabled ? 'Pause' : 'Resume', 'data-wf-toggle="' + (workflow.enabled ? 'off' : 'on') + '"');
      actions += btn('Archive', 'data-wf-archive');
    }
    var proposal = view.isAdmin ? wf.latestProposal(workflow) : null;
    var out = '<div class="twf-head">' + backHtml() + '<span class="twf-actions">' + actions + '</span></div>' + noticeHtml(view)
      + '<div class="automations-detail-head"><span><div class="automations-detail-title">' + esc(workflow.name) + '</div>'
      + '<div class="automations-detail-sub">' + esc(workflow.definition ? wf.triggerLine(workflow.definition.trigger) : 'No approved version yet') + '</div></span>'
      + '<span class="automations-row-side">' + statePill(wf.workflowStatus(workflow)) + '</span></div>';
    if(proposal){
      out += '<div class="twf-card"><div class="twf-card-title">Version ' + Number(proposal.version) + ' is waiting for approval</div>'
        + '<div class="twf-card-text">Proposed by ' + esc(wf.displayName(view.people, proposal.proposed_by)) + '. It goes live once an admin approves it. Runs already in progress keep their version.</div>'
        + '<div class="automations-step-note">' + esc(wf.triggerLine(proposal.definition && proposal.definition.trigger)) + '</div>'
        + definitionStepsHtml(proposal.definition, view.people)
        + '<div class="twf-actions">' + btn('Approve', 'data-wf-version="approve" data-wf-v="' + Number(proposal.version) + '"', 'primary')
        + btn('Reject', 'data-wf-version="reject" data-wf-v="' + Number(proposal.version) + '"') + '</div></div>';
    }
    if(workflow.definition) out += '<div class="twf-section-sub">Steps</div>' + definitionStepsHtml(workflow.definition, view.people);
    out += '<div class="twf-section-sub">Runs</div>';
    out += (view.workflowRuns || []).length ? view.workflowRuns.map(function(r){ return runRowHtml(r, view.people, view.now); }).join('')
      : '<div class="twf-card-text">No runs yet.</div>';
    return out;
  }

  // ---- Starting from a flag: the privacy gate ----------------------------------------------
  function startHtml(view){
    var workflow = view.workflow, length = (view.summary || '').length;
    return '<div class="twf-head">' + backHtml() + '</div>' + noticeHtml(view)
      + '<div class="automations-detail-title">' + esc(workflow.name) + '</div>'
      + '<div class="twf-card-text">Write one line about what this run is for. Only this line goes to your team. Anything private stays on this computer.</div>'
      + '<label class="twf-label">Summary<textarea class="twf-input" rows="2" maxlength="' + wf.SUMMARY_MAX + '" data-wf-summary placeholder="For example: Quote request from a new customer">' + esc(view.summary || '') + '</textarea></label>'
      + '<div class="automations-step-note" data-wf-summary-count>' + length + ' of ' + wf.SUMMARY_MAX + ' characters</div>'
      + '<div class="twf-card-text">Nothing is sent until you press Start.</div>'
      + '<div class="twf-actions">' + btn('Start', 'data-wf-start-confirm' + (view.starting ? ' disabled' : ''), 'primary') + '</div>';
  }

  // ---- Editor ------------------------------------------------------------------------------
  function field(name, attrs){ return 'data-wf-field="' + name + '"' + (attrs ? ' ' + attrs : ''); }
  function triggerFieldsHtml(draft, view){
    if(draft.triggerKind === 'flag'){
      var pick = {}; (draft.starters || []).forEach(function(s){ pick[s] = true; });
      return '<label class="twf-label">What flags this workflow<input class="twf-input" maxlength="' + wf.LABEL_MAX + '" value="' + esc(draft.label) + '" ' + field('label') + ' placeholder="For example: Quote request"></label>'
        + '<div class="twf-label">Who can start it</div><div class="twf-checks">' + (view.channelMembers || []).map(function(m){
          return '<label class="twf-check"><input type="checkbox" data-wf-starter="' + esc(m.clerk_user_id) + '"' + (pick[m.clerk_user_id] ? ' checked' : '') + '>' + esc(wf.displayName(view.people, m.clerk_user_id)) + '</label>';
        }).join('') + '</div>';
    }
    var frequency = selectHtml(field('frequency', 'data-wf-rerender aria-label="How often"'), [{value: 'daily', label: 'Every day'}, {value: 'weekly', label: 'Every week'}, {value: 'monthly', label: 'Every month'}, {value: 'interval', label: 'Every few minutes'}], draft.frequency);
    var out = '<label class="twf-label">How often' + frequency + '</label>';
    if(draft.frequency === 'interval') return out + '<label class="twf-label">Minutes between runs<input class="twf-input" type="number" min="15" max="1440" value="' + esc(draft.intervalMinutes) + '" ' + field('intervalMinutes') + '></label>';
    if(draft.frequency === 'daily') out += '<label class="twf-check"><input type="checkbox" ' + field('weekdaysOnly') + (draft.weekdaysOnly ? ' checked' : '') + '>Weekdays only</label>';
    if(draft.frequency === 'weekly') out += '<label class="twf-label">Day' + selectHtml(field('weekday', 'aria-label="Day"'), wf.WEEKDAYS.map(function(d){ return {value: d, label: wf.titleCase(d)}; }), draft.weekday) + '</label>';
    if(draft.frequency === 'monthly') out += '<label class="twf-label">Day of the month<input class="twf-input" type="number" min="1" max="28" value="' + esc(draft.monthDay) + '" ' + field('monthDay') + '></label>';
    return out + '<label class="twf-label">Time<input class="twf-input" type="time" value="' + esc(draft.time) + '" ' + field('time') + '></label>'
      + '<label class="twf-label">Time zone<input class="twf-input" value="' + esc(draft.timezone) + '" ' + field('timezone') + '></label>';
  }
  function editorStepHtml(step, index, count, view){
    var i = 'data-wf-step="' + index + '"', members = peopleOptions(view.channelMembers, view.people);
    return '<div class="twf-card"><div class="twf-card-row"><div class="twf-card-title">Step ' + (index + 1) + '</div><span class="twf-actions">'
      + (index > 0 ? btn('Move up', 'data-wf-step-up="' + index + '"') : '') + (count > 1 ? btn('Remove', 'data-wf-step-remove="' + index + '"') : '') + '</span></div>'
      + '<label class="twf-label">What the bot should do<textarea class="twf-input" rows="2" maxlength="' + wf.STEP_MAX + '" ' + i + ' data-wf-step-field="text">' + esc(step.text) + '</textarea></label>'
      + '<label class="twf-label">Who owns it. It runs on their computer.' + selectHtml(i + ' data-wf-step-field="ownerMemberId" aria-label="Owner"', members, step.ownerMemberId, 'Choose a person') + '</label>'
      + '<label class="twf-label">Which bot' + selectHtml(i + ' data-wf-step-field="botId" aria-label="Bot"', botChoices(view.bots), step.botId, 'Choose a bot') + '</label>'
      + '<label class="twf-label">Who approves it (optional)' + selectHtml(i + ' data-wf-step-field="approverMemberId" aria-label="Approver"', members, step.approverMemberId, 'No approval needed') + '</label></div>';
  }
  function editorHtml(view){
    var draft = view.draft, steps = draft.steps;
    var channels = wf.regularChannels(view.channels).map(function(c){ return {value: c.id, label: c.name}; });
    return '<div class="twf-head">' + backHtml() + '</div>'
      + '<div class="automations-detail-title">' + (draft.id ? 'Edit ' + esc(draft.name) : 'New workflow') + '</div>'
      + (view.errors && view.errors.length ? '<div class="tf-notice" role="alert">' + view.errors.map(esc).join('<br>') + '</div>' : noticeHtml(view))
      + (draft.id ? '' : '<label class="twf-label">Name<input class="twf-input" maxlength="' + wf.NAME_MAX + '" value="' + esc(draft.name) + '" ' + field('name') + '></label>'
        + '<label class="twf-label">Channel. It posts here, and everyone on it must have joined.' + selectHtml(field('channelId', 'data-wf-rerender aria-label="Channel"'), channels, draft.channelId, 'Choose a channel') + '</label>')
      + '<div class="twf-section-sub">When it starts</div>'
      + '<label class="twf-label">Start' + selectHtml(field('triggerKind', 'data-wf-rerender aria-label="Start"'), [{value: 'schedule', label: 'On a schedule'}, {value: 'flag', label: 'When someone flags it'}], draft.triggerKind) + '</label>'
      + triggerFieldsHtml(draft, view)
      + '<div class="twf-section-sub">Steps</div>' + steps.map(function(step, index){ return editorStepHtml(step, index, steps.length, view); }).join('')
      + (steps.length < wf.STEPS_MAX ? '<div class="twf-actions">' + btn('Add a step', 'data-wf-step-add') + '</div>' : '')
      + '<div class="twf-section-sub">If a step is stuck</div>'
      + '<label class="twf-label">After 1 hour, remind' + selectHtml(field('remindMemberId', 'aria-label="Who to remind"'), peopleOptions(view.channelMembers, view.people), draft.remindMemberId, 'The channel') + '</label>'
      + '<label class="twf-check"><input type="checkbox" ' + field('escalate') + (draft.escalate ? ' checked' : '') + '>After 24 hours, pause the run and ask someone to fix it</label>'
      + '<div class="twf-card-text">Saving proposes a new version. It goes live once an admin approves it, and runs already in progress keep their version.</div>'
      + '<div class="twf-actions">' + btn(view.saving ? 'Saving…' : 'Save for approval', 'data-wf-save' + (view.saving ? ' disabled' : ''), 'primary') + '</div>';
  }

  // ---- Controller --------------------------------------------------------------------------
  var ctx = null, client = null, mount = null, view = null, queues = {}, reloadTimer = null, seenNeeds = {}, generation = 0;

  function freshView(){ return {screen: 'home', workflows: null, runs: [], recent: [], approvals: [], members: [], people: {}, notice: '', error: '', channelMembers: []}; }
  function queueFor(teamId){
    if(!queues[teamId]){
      queues[teamId] = wf.createQueue({teamId: teamId, post: function(path, body){ return root.MiaHubChat.localCall('POST', path, body); }, onChange: function(){ onQueue(teamId); }});
      queues[teamId].wake();
    }
    return queues[teamId];
  }
  function onQueue(teamId){
    if(!ctx || ctx.teamId !== teamId) return;
    var state = queues[teamId].state();
    var fresh = (state.needsYou || []).filter(function(item){ if(item.reason === 'instructions_unavailable') return false; var key = teamId + item.runId + ':' + item.n; if(seenNeeds[key]) return false; seenNeeds[key] = true; return true; });
    if(fresh.length && ctx.toast) ctx.toast(fresh.some(function(item){ return item.reason === 'approval'; }) ? 'A team workflow step is waiting for your OK to run.' : 'A team workflow step needs your decision.');
    render();
  }
  // Every team this person belongs to keeps moving, whichever one is on screen.
  function setTeams(teamIds){
    var wanted = {};
    (teamIds || []).forEach(function(id){ if(wf.ID.test(id)){ wanted[id] = true; queueFor(id); } });
    Object.keys(queues).forEach(function(id){ if(!wanted[id] && !(ctx && ctx.teamId === id)){ queues[id].stop(); delete queues[id]; } });
  }
  function me(){ return ctx && ctx.subject ? ctx.subject() : null; }
  function isAdmin(){ return !!(ctx && ctx.isAdmin && ctx.isAdmin()); }
  function attach(context){
    if(ctx && ctx.teamId === context.teamId){ ctx = context; queueFor(context.teamId); return; }
    ctx = context; generation++;
    client = wf.createClient({teamId: context.teamId, call: context.call});
    view = freshView();
    queueFor(context.teamId);
    loadMembers();
  }
  function detach(){ ctx = null; client = null; mount = null; view = null; generation++; }
  function loadMembers(){
    var gen = generation;
    return client.members().then(function(result){
      if(gen !== generation) return;
      view.members = result.members || [];
      view.people = wf.directory(view.members);
      render();
      if(ctx.onPeople) ctx.onPeople();
    }).catch(function(){});
  }
  function viewModel(){
    var queue = queues[ctx.teamId] && queues[ctx.teamId].state();
    return Object.assign({}, view, {me: me(), isAdmin: isAdmin(), now: Date.now(), queue: queue, needsYou: queue ? queue.needsYou : []});
  }
  function screenHtml(){
    var model = viewModel();
    switch(view.screen){
      case 'run': return runHtml(model);
      case 'workflow': return workflowHtml(model);
      case 'start': return startHtml(model);
      case 'edit': return editorHtml(model);
      default: return homeHtml(model);
    }
  }
  function render(){
    if(!mount || !ctx || !mount.isConnected) return;
    var scroller = mount.closest ? mount.closest('.automations-body') : null, top = scroller ? scroller.scrollTop : 0;
    // Polling redraws the page, so a long set of instructions keeps its place.
    var kept = {}, boxes = function(){ return mount.querySelectorAll ? Array.prototype.slice.call(mount.querySelectorAll('[data-wf-keep-scroll]')) : []; };
    boxes().forEach(function(box){ kept[box.getAttribute('data-wf-keep-scroll')] = box.scrollTop; });
    var wasOpen = {}, opened = function(){ return mount.querySelectorAll ? Array.prototype.slice.call(mount.querySelectorAll('[data-wf-keep-open]')) : []; };
    opened().forEach(function(box){ if(box.open) wasOpen[box.getAttribute('data-wf-keep-open')] = true; });
    mount.innerHTML = screenHtml();
    if(scroller) scroller.scrollTop = top;
    boxes().forEach(function(box){ var place = kept[box.getAttribute('data-wf-keep-scroll')]; if(place) box.scrollTop = place; });
    opened().forEach(function(box){ if(wasOpen[box.getAttribute('data-wf-keep-open')]) box.open = true; });
    // On a detail screen the rest of the page steps aside.
    var board = mount.parentNode && mount.parentNode.querySelector('[data-wf-board]');
    if(board) board.hidden = view.screen !== 'home';
  }
  // The Automations page redraws its whole body, so it hands over a new element.
  function mountInto(element){
    if(!ctx || !element) return;
    mount = element;
    mount.addEventListener('click', onClick);
    mount.addEventListener('input', onInput);
    mount.addEventListener('change', onChange);
    render();
    if(!view.workflows && !view.loading && !view.unavailable && !view.error) reload();
  }
  function fullScreen(){ return !!view && view.screen !== 'home'; }
  function pageOpened(){ if(view) view.notice = ''; return reload(); }
  function fail(error, fallback){ if(!view) return; view.notice = wf.errorMessage(error, fallback); render(); }

  function loadHome(gen){
    view.loading = true; render();
    return Promise.all([client.workflows(), client.runs('active'), client.runs('recent'), client.approvals('pending')]).then(function(results){
      if(gen !== generation) return;
      view.unavailable = false; view.error = '';
      view.workflows = results[0].workflows || [];
      view.runs = results[1].runs || [];
      view.recent = results[2].runs || [];
      view.approvals = results[3].approvals || [];
    }).catch(function(error){
      if(gen !== generation) return;
      // Every member can read this list, so a 404 means this Hub has no workflows.
      if(error && error.status === 404) view.unavailable = true;
      else view.error = wf.errorMessage(error, 'Mia could not load team workflows.');
    }).then(function(){
      if(gen !== generation) return;
      view.loading = false; render();
    });
  }
  function loadChannelPeople(channelId){
    if(!channelId){ view.channelMembers = view.members; return Promise.resolve(); }
    return ctx.call('GET', '/v1/teams/' + ctx.teamId + '/channels/' + channelId + '/members').then(function(result){
      view.channelMembers = (result.members || []).filter(function(m){ return m && m.clerk_user_id && view.people[m.clerk_user_id]; });
    }).catch(function(){ view.channelMembers = view.members; });
  }
  function loadBots(){
    if(view.bots) return Promise.resolve();
    return root.MiaHubChat.teamBots(ctx.teamId).then(function(groups){ view.bots = wf.botOptions(groups); }).catch(function(){ view.bots = []; });
  }
  function loadRun(id, gen){
    return client.run(id).then(function(result){
      if(gen !== generation || view.screen !== 'run' || view.runId !== id) return;
      view.run = result.run; view.steps = result.steps || []; view.approvals = result.approvals || []; view.error = '';
      if(view.steps.some(function(s){ return wf.canFix(s, me(), isAdmin()); })){
        return Promise.all([loadBots(), loadChannelPeople(view.run.channel_id)]);
      }
    }).catch(function(error){
      if(gen !== generation) return;
      view.error = error && error.status === 404 ? 'This run is no longer available. Finished runs are kept for 90 days.' : wf.errorMessage(error, 'Mia could not load this run.');
    }).then(function(){ if(gen === generation) render(); });
  }
  function loadWorkflow(id, gen){
    return Promise.all([client.workflow(id), client.runs('all', id)]).then(function(results){
      if(gen !== generation || view.workflowId !== id) return;
      view.workflow = results[0].workflow; view.workflowRuns = results[1].runs || []; view.error = '';
    }).catch(function(error){
      if(gen !== generation) return;
      view.error = error && error.status === 404 ? 'This workflow is no longer available.' : wf.errorMessage(error, 'Mia could not load this workflow.');
    }).then(function(){ if(gen === generation) render(); });
  }
  function reload(){
    if(!ctx || !view) return Promise.resolve();
    var gen = generation;
    if(view.screen === 'run' && view.runId) return loadRun(view.runId, gen);
    if(view.screen === 'workflow' && view.workflowId) return loadWorkflow(view.workflowId, gen);
    if(view.screen === 'home') return loadHome(gen);
    return Promise.resolve(); // Never redraw a form under someone typing.
  }
  function reloadSoon(){
    if(reloadTimer) return;
    reloadTimer = root.setTimeout(function(){ reloadTimer = null; if(mount && mount.isConnected) new Promise(function(done){ done(reload()); }).catch(function(){}); }, 300); // A background refresh that fails keeps what is on screen.
  }
  // One feed event from the Hub. A step queued for this person wakes the queue
  // right away; the rest only redraw what is open.
  function onEvent(event){
    if(!ctx || !event) return;
    if(event.kind === 'members'){ loadMembers(); return; }
    if(event.kind === 'workflow_step') queueFor(ctx.teamId).wake();
    if(event.kind === 'workflow_fix' && ctx.toast) ctx.toast('A team workflow is paused and needs a fix.');
    if(event.kind === 'workflow_reminder' && ctx.toast) ctx.toast('A team workflow step is waiting.');
    reloadSoon();
  }
  var EVENT_KINDS = ['workflow', 'workflow_run', 'workflow_step', 'workflow_approval', 'workflow_fix', 'workflow_reminder', 'members'];
  function handles(kind){ return EVENT_KINDS.indexOf(kind) >= 0; }
  function onReset(){ if(ctx){ queueFor(ctx.teamId).wake(); reloadSoon(); } }

  function go(screen, fields){
    Object.assign(view, {screen: screen, notice: '', error: '', errors: null}, fields || {});
    render();
    if(ctx && ctx.showPage) ctx.showPage();
    return reload();
  }
  function openRun(id){ if(!ctx || !wf.ID.test(id || '')) return; go('run', {runId: id, run: null, steps: [], fixDrafts: {}}); }
  function openWorkflow(id){ if(!wf.ID.test(id || '')) return; go('workflow', {workflowId: id, workflow: null, workflowRuns: []}); }
  function back(){
    if(view.screen === 'start' || (view.screen === 'edit' && view.draft && view.draft.id)) return go('workflow');
    if(view.screen === 'workflow' || view.screen === 'run' || view.screen === 'edit') return go('home');
  }
  function openEditor(draft){
    view.screen = 'edit'; view.draft = draft; view.errors = null; view.notice = ''; view.saving = false; view.channelMembers = view.members;
    render();
    var loads = [loadBots(), loadChannelPeople(draft.channelId)];
    if(!view.channels) loads.push(client.channels().then(function(result){ view.channels = result.channels || []; }).catch(function(){ view.channels = []; }));
    Promise.all(loads).then(render);
  }
  function save(){
    var checked = wf.checkDraft(view.draft);
    if(checked.errors.length){ view.errors = checked.errors; render(); return; }
    view.saving = true; view.errors = null; view.notice = ''; render();
    var draft = view.draft;
    var request = draft.id ? client.propose(draft.id, checked.definition)
      : client.create({id: draft.newId || (draft.newId = wf.randomId()), name: checked.name, channelId: draft.channelId, definition: checked.definition});
    request.then(function(result){
      var id = draft.id || (result.workflow && result.workflow.id) || draft.newId;
      go('workflow', {workflowId: id, workflow: null, workflowRuns: [], saving: false});
    }).catch(function(error){ view.saving = false; fail(error, 'Mia could not save this workflow.'); });
  }
  function act(control, promise, fallback, after){
    if(control) control.disabled = true;
    return promise.then(function(result){ view.notice = ''; if(after) return after(result); return reload(); }).catch(function(error){ fail(error, fallback); })
      .then(function(){ if(control && control.isConnected) control.disabled = false; });
  }
  function confirmThen(message, label, action){
    var ask = ctx.confirm ? ctx.confirm(message, label) : Promise.resolve(root.confirm ? root.confirm(message) : true);
    return Promise.resolve(ask).then(function(yes){ if(yes) return action(); });
  }
  function saveBlob(blob, name){
    var url = root.URL.createObjectURL(blob), link = root.document.createElement('a');
    link.href = url; link.download = tf.safeFilename(name); root.document.body.appendChild(link); link.click(); link.remove();
    root.setTimeout(function(){ root.URL.revokeObjectURL(url); }, 60000);
  }
  function download(fileId, n, control){
    var step = (view.steps || []).filter(function(s){ return s.n === n; })[0];
    var file = step && (step.files || []).filter(function(f){ return f.fileId === fileId; })[0];
    if(!file || !view.run) return;
    control.disabled = true;
    tf.downloadFile({client: tf.createClient({teamId: ctx.teamId, call: ctx.call}), file: {fileId: file.fileId, sizeBytes: file.sizeBytes, sha256: file.sha256, spaceId: view.run.space_id}})
      .then(function(blob){ saveBlob(blob, file.filename); })
      .catch(function(error){ view.notice = tf.errorMessage(error.code, error.status); render(); })
      .then(function(){ if(control.isConnected) control.disabled = false; });
  }
  function decide(control){
    var card = control.closest('[data-wf-card]'), feedback = card && card.querySelector('[data-wf-feedback]');
    var id = control.getAttribute('data-wf-approval'), decision = control.getAttribute('data-wf-decide');
    var buttons = card ? [].slice.call(card.querySelectorAll('[data-wf-decide]')) : [control];
    function send(){
      buttons.forEach(function(b){ b.disabled = true; });
      if(feedback) feedback.textContent = 'Saving…';
      return client.decide(id, decision).then(function(){
        if(feedback && feedback.isConnected) feedback.textContent = decision === 'approve' ? 'Approved.' : 'Rejected.';
        reloadSoon();
      }).catch(function(error){
        buttons.forEach(function(b){ if(b.isConnected) b.disabled = false; });
        if(feedback && feedback.isConnected) feedback.textContent = wf.errorMessage(error, 'Mia could not save your decision.');
      });
    }
    if(decision === 'reject') return confirmThen('Reject this step? The whole run ends and later steps never start.', 'Reject', send);
    return send();
  }
  // Works on approval cards wherever they are drawn, including in channels.
  function onDocumentClick(event){
    if(!ctx || !event.target.closest) return;
    var control = event.target.closest('[data-wf-decide]');
    if(control && !control.disabled){ decide(control); return; }
    var open = event.target.closest('[data-wf-card] [data-wf-open-run]');
    if(open && !(mount && mount.contains(open))) openRun(open.getAttribute('data-wf-open-run'));
  }
  function onClick(event){
    var target = event.target.closest && event.target.closest('button');
    if(!target || target.disabled || !ctx) return;
    var read = function(name){ return target.getAttribute(name); };
    if(target.hasAttribute('data-wf-back')) return back();
    if(target.hasAttribute('data-wf-reload')) return reload();
    if(target.hasAttribute('data-wf-open-run')) return openRun(read('data-wf-open-run'));
    if(target.hasAttribute('data-wf-open-workflow')) return openWorkflow(read('data-wf-open-workflow'));
    if(target.hasAttribute('data-wf-new')) return openEditor(wf.blankDraft());
    if(target.hasAttribute('data-wf-edit')) return openEditor(wf.draftFromWorkflow(view.workflow));
    if(target.hasAttribute('data-wf-save')) return save();
    if(target.hasAttribute('data-wf-start')){ view.screen = 'start'; view.summary = ''; view.startId = wf.randomId(); view.notice = ''; view.starting = false; return render(); }
    if(target.hasAttribute('data-wf-start-confirm')){
      view.starting = true;
      return act(target, Promise.resolve().then(function(){ return client.start(view.workflow.id, view.startId, view.summary); }), 'Mia could not start this workflow.', function(result){
        view.starting = false; openRun(result.run && result.run.id);
      }).then(function(){ if(view && view.starting){ view.starting = false; render(); } });
    }
    if(target.hasAttribute('data-wf-toggle')) return act(target, client.setEnabled(view.workflow.id, read('data-wf-toggle') === 'on'), 'Mia could not change this workflow.');
    if(target.hasAttribute('data-wf-archive')){
      return confirmThen('Archive this workflow? Runs in progress will finish, and no new ones will start.', 'Archive', function(){
        return act(target, client.archive(view.workflow.id), 'Mia could not archive this workflow.', function(){ return go('home'); });
      });
    }
    if(target.hasAttribute('data-wf-version')){
      var version = Number(read('data-wf-v')), approve = read('data-wf-version') === 'approve';
      return act(target, approve ? client.approveVersion(view.workflow.id, version) : client.rejectVersion(view.workflow.id, version), 'Mia could not save your decision.');
    }
    if(target.hasAttribute('data-wf-cancel')){
      return confirmThen('Cancel this run? Open steps stop and it cannot be restarted.', 'Cancel run', function(){
        return act(target, client.cancel(view.run.id), 'Mia could not cancel this run.');
      });
    }
    if(target.hasAttribute('data-wf-retry')) return act(target, client.retry(view.run.id, Number(read('data-wf-retry'))), 'Mia could not retry this step.');
    if(target.hasAttribute('data-wf-fix')){
      var n = Number(read('data-wf-fix')), fix = (view.fixDrafts && view.fixDrafts[n]) || {};
      if(!fix.ownerMemberId || !fix.botId){ view.notice = 'Choose who takes this step and which bot runs it.'; return render(); }
      return act(target, client.fix(view.run.id, n, fix), 'Mia could not save the fix.', function(){ delete view.fixDrafts[n]; return reload(); });
    }
    if(target.hasAttribute('data-wf-resume')){
      return act(target, queueFor(ctx.teamId).resume(read('data-wf-run'), Number(read('data-wf-n')), read('data-wf-resume'), read('data-wf-digest')), 'Mia could not do that.', function(){ render(); return reload(); });
    }
    if(target.hasAttribute('data-wf-download')) return download(read('data-wf-download'), Number(read('data-wf-n')), target);
    var draft = view.draft;
    if(!draft) return;
    if(target.hasAttribute('data-wf-step-add')){ draft.steps.push(wf.blankStep()); return render(); }
    if(target.hasAttribute('data-wf-step-remove')){ draft.steps.splice(Number(read('data-wf-step-remove')), 1); return render(); }
    if(target.hasAttribute('data-wf-step-up')){
      var at = Number(read('data-wf-step-up')), moved = draft.steps.splice(at, 1)[0];
      draft.steps.splice(at - 1, 0, moved); return render();
    }
  }
  function onInput(event){
    var input = event.target;
    if(input.hasAttribute('data-wf-summary')){
      view.summary = input.value;
      var count = mount.querySelector('[data-wf-summary-count]');
      if(count) count.textContent = input.value.length + ' of ' + wf.SUMMARY_MAX + ' characters';
      return;
    }
    if(!view.draft) return;
    if(input.hasAttribute('data-wf-step-field')) view.draft.steps[Number(input.getAttribute('data-wf-step'))][input.getAttribute('data-wf-step-field')] = input.value;
    else if(input.hasAttribute('data-wf-field') && input.type !== 'checkbox') view.draft[input.getAttribute('data-wf-field')] = input.value;
  }
  function onChange(event){
    var input = event.target;
    if(input.hasAttribute('data-wf-fix-field')){
      var n = input.getAttribute('data-wf-n');
      view.fixDrafts[n] = view.fixDrafts[n] || {};
      view.fixDrafts[n][input.getAttribute('data-wf-fix-field')] = input.value;
      return;
    }
    if(!view.draft) return;
    if(input.hasAttribute('data-wf-starter')){
      var id = input.getAttribute('data-wf-starter'), list = view.draft.starters.filter(function(s){ return s !== id; });
      if(input.checked) list.push(id);
      view.draft.starters = list;
      return;
    }
    if(input.type === 'checkbox' && input.hasAttribute('data-wf-field')){ view.draft[input.getAttribute('data-wf-field')] = input.checked; return; }
    if(input.getAttribute('data-wf-field') === 'channelId'){ view.draft.channelId = input.value; loadChannelPeople(input.value).then(render); return; }
    if(input.hasAttribute('data-wf-rerender')){ view.draft[input.getAttribute('data-wf-field')] = input.value; render(); }
  }
  if(root.document && root.document.addEventListener) root.document.addEventListener('click', onDocumentClick);

  // What a channel needs to draw a card: the members are already loaded here.
  function channelCardHtml(approval){ return approvalCardHtml(approval, view ? view.people : {}); }

  return {
    attach: attach, detach: detach, setTeams: setTeams, mountInto: mountInto, fullScreen: fullScreen, pageOpened: pageOpened, handles: handles, onEvent: onEvent, onReset: onReset, openRun: openRun,
    channelCardHtml: channelCardHtml, onDocumentClick: onDocumentClick,
    approvalCardHtml: approvalCardHtml, homeHtml: homeHtml, runHtml: runHtml, workflowHtml: workflowHtml, startHtml: startHtml, editorHtml: editorHtml, fixCardHtml: fixCardHtml, needsYouHtml: needsYouHtml
  };
});
