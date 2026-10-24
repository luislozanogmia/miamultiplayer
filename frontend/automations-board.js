(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaAutomationsBoard = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The Automations page: every bot's automations as one board, grouped by
  // what they are doing or by the bot that owns them. Pure data shaping; the
  // app renders it.
  var STATUS_ORDER = ['running', 'needs', 'scheduled', 'paused'];
  var STATUS_TITLES = {running: 'Running now', needs: 'Needs you', scheduled: 'Scheduled', paused: 'Paused'};

  function steps(automation){
    var list = automation && Array.isArray(automation.steps) ? automation.steps : [];
    return list.map(function(step){ return String(step || '').trim(); }).filter(Boolean);
  }

  function hasTask(automation){
    return !!String(automation && automation.prompt || '').trim() || steps(automation).length > 0;
  }

  // An automation that is on but cannot run, whose last run failed, or whose
  // bot escalated a step needs the user; a live run outranks everything
  // except an escalation, which is the bot waiting on the user.
  function statusOf(automation, run, checklist){
    if(checklist && checklist.escalation) return 'needs';
    if(run) return 'running';
    if(automation.enabled === true && !hasTask(automation)) return 'needs';
    if(String(automation.lastRunStatus || '').toLowerCase() === 'failed') return 'needs';
    return automation.enabled === true ? 'scheduled' : 'paused';
  }

  function needsReason(automation, checklist){
    if(checklist && checklist.escalation){
      var note = checklist.escalation.note ? ': ' + checklist.escalation.note : '';
      return 'Step ' + checklist.escalation.step + ' needs you' + note;
    }
    if(!hasTask(automation)) return 'Needs a task before it can run';
    return 'Last run failed';
  }

  // "Step 2 of 4 · Reading the top stories · 1 done" while a run is going: the
  // step the bot reported it is working on, with its own one-line note.
  function runningDetail(checklist){
    if(!checklist || !checklist.total) return 'Running now';
    var doneText = checklist.done ? ' · ' + checklist.done + ' done' : '';
    var current = checklist.current;
    if(current) return 'Step ' + current.step + ' of ' + checklist.total + ' · ' + (current.note || current.text) + doneText;
    var next = (checklist.steps || []).filter(function(item){ return item.state === 'pending'; })[0];
    if(!next) return 'Finishing · ' + checklist.done + ' of ' + checklist.total + ' steps done';
    return 'Step ' + next.n + ' of ' + checklist.total + ' · ' + next.text;
  }

  function findChecklist(checklists, botId, automationId){
    return (checklists || []).filter(function(item){
      return item && String(item.botId) === String(botId) && String(item.automationId) === String(automationId);
    })[0] || null;
  }

  // entries(bots, runs, describeSchedule, checklists) -> one row per
  // automation. checklists are each automation's latest step reports.
  function entries(bots, runs, describeSchedule, checklists){
    var schedule = typeof describeSchedule === 'function' ? describeSchedule : function(){ return ''; };
    var rows = [];
    (bots || []).forEach(function(bot){
      if(!bot) return;
      (Array.isArray(bot.automations) ? bot.automations : []).forEach(function(automation){
        if(!automation || !automation.id) return;
        var run = (runs || []).filter(function(item){
          return item && String(item.botId) === String(bot.id) && String(item.automationId) === String(automation.id);
        })[0] || null;
        var checklist = findChecklist(checklists, bot.id, automation.id);
        var status = statusOf(automation, run, checklist);
        rows.push({
          botId: String(bot.id), botName: String(bot.name || 'Bot'), color: bot.avatarColor || null,
          automationId: String(automation.id), name: String(automation.name || 'Automation'),
          status: status, run: run, steps: steps(automation), checklist: checklist,
          schedule: schedule(automation),
          detail: status === 'running' ? runningDetail(checklist) : status === 'needs' ? needsReason(automation, checklist) : schedule(automation)
        });
      });
    });
    return rows;
  }

  function byStatus(a, b){ return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status); }

  // groups(rows, 'status' | 'bot') -> [{key, title, botId?, color?, rows}]
  function groups(rows, mode){
    var out = [];
    if(mode === 'bot'){
      var byBot = {};
      rows.forEach(function(row){
        var group = byBot[row.botId];
        if(!group){ group = byBot[row.botId] = {key: row.botId, title: row.botName, botId: row.botId, color: row.color, rows: []}; out.push(group); }
        group.rows.push(row);
      });
      out.forEach(function(group){ group.rows.sort(byStatus); });
      return out;
    }
    STATUS_ORDER.forEach(function(status){
      var matching = rows.filter(function(row){ return row.status === status; });
      if(matching.length) out.push({key: status, title: STATUS_TITLES[status], rows: matching});
    });
    return out;
  }

  // "3 running · 1 needs you · 2 scheduled"
  function summary(rows){
    var counts = {running: 0, needs: 0, scheduled: 0, paused: 0};
    rows.forEach(function(row){ counts[row.status] += 1; });
    var parts = [];
    if(counts.running) parts.push(counts.running + ' running');
    if(counts.needs) parts.push(counts.needs + ' need' + (counts.needs === 1 ? 's' : '') + ' you');
    if(counts.scheduled) parts.push(counts.scheduled + ' scheduled');
    if(counts.paused) parts.push(counts.paused + ' paused');
    return parts.length ? parts.join(' · ') : 'No automations yet';
  }

  return {STATUS_TITLES: STATUS_TITLES, steps: steps, entries: entries, groups: groups, summary: summary};
});
