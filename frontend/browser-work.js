/* Browser work UI consumes durable coordinator records and trusted browser state.
 * It does not grant approvals, execute page actions, or infer model progress. */
(function (root, factory) {
  var exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.MiaBrowserWork = exports;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var browserState = { tabs: [] }, works = [], host, bridge, transport, loaded = false;
  var requestGeneration = 0, timer, pending = new Set(), getBots, getModels, modelInventory = [], personalSelection = null, lastWorkRender = '', lastGroupRender = '';
  var labels = { idle: 'Idle', queued: 'Queued', working: 'Working', waiting_for_user: 'Waiting for you', needs_approval: 'Needs approval', done: 'Done', failed: 'Failed', cancelled: 'Stopped' };
  function visibleTabs(state) {
    var group = (state.groups || []).find(function (g) { return g.id === state.selectedGroupId; });
    if (!group) return state.tabs || [];
    return group.tabIds.map(function (id) { return (state.tabs || []).find(function (t) { return t.id === id; }); }).filter(Boolean);
  }
  function connectedModels(providers) {
    var entries = [];
    (Array.isArray(providers) ? providers : []).forEach(function (p) {
      if (!p || !p.id || !Array.isArray(p.models)) return;
      p.models.forEach(function (model) { if (typeof model === 'string' && model.trim()) entries.push({ provider: p.id, model: model, label: (p.label || p.id) + ' · ' + model }); });
    });
    return entries;
  }
  function selectedConnectedModel(entries, value) { return typeof value === 'string' && /^\d+$/.test(value) ? entries[Number(value)] || null : null; }
  function configuredModelIndex(entries, bot) { return entries.findIndex(function (entry) { return bot && entry.model === bot.model && entry.provider === (bot.modelProvider || bot.provider); }); }
  function recoveryState(work, workerId) {
    var reset = new Set([workerId]), changed = true;
    while (changed) {
      changed = false;
      (work.workers || []).forEach(function (w) { if (!reset.has(w.id) && ((work.dependencies || {})[w.id] || []).some(function (id) { return reset.has(id); })) { reset.add(w.id); changed = true; } });
    }
    var uncertain = (work.operations || []).some(function (op) { return op.status === 'uncertain' && reset.has(op.workerId); });
    var worker = (work.workers || []).find(function (w) { return w.id === workerId; });
    return { held: uncertain, eligible: !uncertain && !!worker && ['waiting_for_user', 'failed', 'cancelled'].includes(work.rawStatus || work.status) && ['waiting_for_user', 'failed', 'cancelled'].includes(worker.status), workerIds: Array.from(reset) };
  }
  function taskRecoveryState(work) {
    var held = (work.operations || []).some(function (operation) { return operation.status === 'uncertain'; });
    var workerIds = (work.workers || []).map(function (worker) { return worker.id; });
    return { held: held, workerIds: workerIds, eligible: !held && workerIds.length > 0 && ['waiting_for_user', 'failed', 'cancelled'].includes(work.rawStatus || work.status) };
  }
  function preservedResponse(result, worker, work, historical, personal) {
    if (!result || typeof result.text !== 'string' || !result.text.trim()) return null;
    var incomplete = result.incomplete === true || ['stopped', 'incomplete'].includes(result.status);
    if (!historical && !incomplete) return null;
    var tags = historical ? ['Previous attempt'] : [];
    if (result.status === 'stopped') tags.push('Stopped');
    if (incomplete) tags.push('Incomplete');
    tags.push(historical ? 'Unverified for current attempt' : 'Unverified');
    if (result.truncated === true) tags.push('Saved text truncated');
    return { text: result.text, tags: tags, historical: !!historical, workerId: worker && worker.id || result.workerId,
      name: personal ? 'Mia · Personal agent' : worker && (worker.botName || worker.name || worker.botId || worker.id) || result.workerId || 'Bot',
      personal: !!personal, goal: result.goal || (personal ? work.goal : worker && worker.goal) || '', overallGoal: String(work.goal || ''), context: typeof work.context === 'string' ? work.context : JSON.stringify(work.context || ''),
      workEpoch: result.workEpoch, workerEpoch: result.workerEpoch, at: result.at };
  }
  function projection(work, groupId) {
    if (!work || work.groupId !== groupId) return null;
    var workers = Array.isArray(work.workers) ? work.workers : [];
    var results = Array.isArray(work.results) ? work.results : Object.keys(work.results || {}).map(function (id) { return Object.assign({ workerId: id, title: (work.results[id].verified === false ? 'Unverified bot response · ' : 'Stored result · ') + id }, work.results[id]); });
    var preserved = results.map(function (result) { return preservedResponse(result, workers.find(function (w) { return w.id === result.workerId; }), work, false); }).filter(Boolean);
    workers.forEach(function (worker) { (Array.isArray(worker.previousAttempts) ? worker.previousAttempts : []).forEach(function (attempt) { var response = preservedResponse(attempt, worker, work, true); if (response) preserved.push(response); }); });
    var personalPartial = preservedResponse(work.synthesis, null, work, false, true);
    if (personalPartial) preserved.push(personalPartial);
    (Array.isArray(work.previousSynthesisAttempts) ? work.previousSynthesisAttempts : []).forEach(function (attempt) { var response = preservedResponse(attempt, null, work, true, true); if (response) preserved.push(response); });
    return { id: work.id, goal: String(work.goal || ''), status: labels[work.status] || 'Unknown state',
      terminal: ['done', 'failed', 'cancelled'].includes(work.status),
      workers: workers, preservedResponses: preserved,
      results: results.filter(function (result) { return result.incomplete !== true && !['stopped', 'incomplete'].includes(result.status); }),
      approvals: (Array.isArray(work.approvals) ? work.approvals : []).filter(function (a) { return a.status === 'pending'; }),
      personalSelection: work.personalSelection || null, synthesis: work.synthesis && work.synthesis.incomplete !== true && !['stopped', 'incomplete'].includes(work.synthesis.status) ? work.synthesis : null, rawStatus: work.status, dependencies: work.dependencies || {}, operations: work.operations || [], reusable: work.reusable || [] };
  }
  function node(tag, className, text) {
    var n = document.createElement(tag); if (className) n.className = className;
    if (text !== undefined) n.textContent = String(text); return n;
  }
  function button(text, action, disabled) {
    var b = node('button', '', text); b.type = 'button'; b.disabled = !!disabled; b.addEventListener('click', action); return b;
  }
  function error(message) { var n = document.getElementById('browserWorkError'); if (n) { n.textContent = message || ''; n.hidden = !message; } }
  async function groupCommand(action, fields) {
    error('');
    try {
      var next = await bridge.command(Object.assign({ action: action }, fields));
      if (next && next.error) throw new Error(next.error);
      if (next && next.tabs) updateBrowserState(next);
    } catch (e) { error(e.message || 'Could not update browser groups.'); }
  }
  function decorateTabs(strip, state) {
    Array.from(strip.querySelectorAll('[data-tab-id]')).forEach(function (tab) {
      var id = Number(tab.getAttribute('data-tab-id'));
      var ownership = (state.ownership || []).find(function (o) { return o.tabId === id; });
      var old = tab.querySelector('.browser-worker-mote'); if (old) old.remove();
      tab.classList.toggle('browser-worker-owned', !!ownership);
      if (ownership) {
        var mote = node('span', 'browser-worker-mote', '');
        mote.title = String(ownership.name || ownership.botId || ownership.actorId) + ' · ' + (labels[ownership.status] || 'Assigned');
        mote.setAttribute('aria-label', mote.title);
        mote.append(node('img')); mote.firstChild.src = 'assets/mote/mote.svg'; mote.firstChild.alt = '';
        tab.append(mote);
      }
    });
  }
  function renderGroups() {
    if (!host) return;
    var signature = JSON.stringify([browserState.groups, browserState.selectedGroupId, browserState.activeId]);
    if (signature === lastGroupRender) return; lastGroupRender = signature;
    var list = document.getElementById('browserGroupList'); list.replaceChildren();
    (browserState.groups || []).forEach(function (group, index) {
      var cell = node('div', 'browser-group-cell');
      var select = button(group.name, function () { groupCommand('group-select', { groupId: group.id }); });
      select.setAttribute('aria-pressed', String(group.id === browserState.selectedGroupId));
      cell.append(select);
      cell.draggable = true;
      cell.addEventListener('dragstart', function (e) { e.dataTransfer.setData('application/x-mia-group', group.id); });
      cell.addEventListener('dragover', function (e) { if (e.dataTransfer.types.includes('application/x-mia-group')) e.preventDefault(); });
      cell.addEventListener('drop', function (e) {
        var id = e.dataTransfer.getData('application/x-mia-group'); if (!id) return; e.preventDefault();
        var order = browserState.groups.map(function (g) { return g.id; });
        if (!order.includes(id)) return;
        order.splice(order.indexOf(id), 1); order.splice(index, 0, id); groupCommand('group-reorder', { groupIds: order });
      });
      list.append(cell);
    });
    var selected = (browserState.groups || []).find(function (g) { return g.id === browserState.selectedGroupId; });
    var rename = document.getElementById('browserGroupName');
    if (document.activeElement !== rename) rename.value = selected ? selected.name : '';
    var move = document.getElementById('browserMoveTabGroup'); var movingTo = move.value; var focusedMove = document.activeElement === move; move.replaceChildren();
    (browserState.groups || []).forEach(function (g) { var option = node('option', '', g.name); option.value = g.id; option.selected = g.id === (focusedMove ? movingTo : browserState.selectedGroupId); move.append(option); });
    document.getElementById('browserMoveTab').disabled = !browserState.activeId;
    var up = document.getElementById('browserGroupEarlier'); up.disabled = !selected || browserState.groups[0].id === selected.id;
  }
  async function refresh() {
    if (!transport || !host || document.getElementById('localBrowserOverlay').hidden) return;
    var generation = ++requestGeneration;
    try {
      var records = await transport.list(browserState.selectedGroupId);
      if (generation !== requestGeneration) return;
      works = Array.isArray(records) ? records : []; loaded = true; error(''); renderWorks();
    } catch (e) { if (generation === requestGeneration) { error(e.message || 'Browser work unavailable.'); } }
  }
  async function mutate(key, callback) {
    if (pending.has(key)) return; pending.add(key); renderWorks(); error('');
    try { await callback(); await refresh(); } catch (e) { error(e.message || 'Could not update browser work.'); }
    finally { pending.delete(key); renderWorks(); }
  }
  function renderWorks() {
    if (!host) return;
    var records = works.map(function (w) { return projection(w, browserState.selectedGroupId); }).filter(Boolean);
    var expiredApprovals = records.map(function (w) { return w.approvals.map(function (a) { var expiry = typeof a.expiresAt === 'number' ? a.expiresAt : Date.parse(a.expiresAt); return Number.isFinite(expiry) && expiry <= Date.now(); }); });
    var signature = JSON.stringify([records, loaded, !!transport, Array.from(pending), expiredApprovals]);
    if (signature === lastWorkRender) return; lastWorkRender = signature;
    var list = document.getElementById('browserWorkList'); list.replaceChildren();
    document.getElementById('browserWorkEmpty').hidden = records.length > 0;
    document.getElementById('browserWorkEmpty').textContent = !transport ? 'Browser work is unavailable in this build.' : !loaded ? 'Loading browser work…' : 'No browser work in this group.';
    records.forEach(function (work) {
      var card = node('article', 'browser-work-card'); card.append(node('strong', '', work.goal));
      var header = node('div', 'browser-work-heading'); header.append(node('span', 'browser-work-status', work.status));
      if (!work.terminal) header.append(button('Stop this task', function () { mutate('stop:' + work.id, function () { return transport.cancel(work.id); }); }, !transport || pending.has('stop:' + work.id)));
      if (work.rawStatus === 'queued' && transport && transport.start) header.append(button('Start queued task', function () { mutate('start:' + work.id, function () { return transport.start(work.id); }); }, pending.has('start:' + work.id)));
      var taskRecovery = taskRecoveryState(work);
      if (taskRecovery.held) header.append(node('span', 'browser-work-hold', 'Task recovery held · uncertain write outcome'));
      else if (taskRecovery.eligible && transport && transport.recover) {
        header.append(button('Recover task with fresh page checks', function () { mutate('recover-task:' + work.id, function () { return transport.recover(work.id, taskRecovery.workerIds); }); }, pending.has('recover-task:' + work.id)));
      }
      card.append(header);
      if (taskRecovery.eligible) card.append(node('p', 'browser-work-preserved-notice', 'Task recovery starts every bot in a fresh session. Earlier answers and Mia synthesis remain context; every page must be checked again before new completion.'));
      card.append(node('div', 'browser-work-coordinator', 'Mia · Personal agent · Planning and synthesis' + (work.personalSelection ? ' · ' + work.personalSelection.model + ' · ' + work.personalSelection.provider : '')));
      work.workers.forEach(function (worker) {
        var row = node('div', 'browser-work-worker'); var mote = node('img', 'browser-work-mote'); mote.src = 'assets/mote/mote.svg'; mote.alt = '';
        row.append(mote, node('span', '', String(worker.botName || worker.name || worker.botId || worker.actorId) + ' · Tab ' + worker.tabId), node('span', 'browser-work-status', labels[worker.status] || 'Unknown state'));
        if (worker.previousAttemptsOmitted > 0) row.append(node('small', '', worker.previousAttemptsOmitted + ' older attempts are outside the retained history.'));
        if (worker.model) row.append(node('small', '', worker.model + ' · ' + (worker.provider || 'Provider unavailable')));
        if (worker.task || worker.goal) row.append(node('p', '', worker.task || worker.goal));
        if (!work.terminal && !['done', 'failed', 'cancelled'].includes(worker.status)) row.append(button('Stop bot', function () { mutate('stop:' + worker.actorId, function () { return transport.cancel(work.id, worker.id); }); }, !transport || pending.has('stop:' + worker.actorId)));
        var recovery = recoveryState(work, worker.id);
        if (recovery.held) row.append(node('p', 'browser-work-hold', 'Recovery held · a write outcome is uncertain. Review its external effect before recovery.'));
        else if (recovery.eligible && transport && transport.recover) {
          row.append(node('p', '', 'Recovering this bot also starts dependent bots in fresh sessions. Previous attempts stay available as context; fresh work must verify the current page again.'));
          row.append(button('Restart bot and dependents', function () { mutate('recover:' + worker.id, function () { return transport.recover(work.id, [worker.id]); }); }, pending.has('recover:' + worker.id)));
        }
        var steps = work.operations.filter(function (op) { return op.workerId === worker.id; });
        if (worker.status === 'done' && steps.length && steps.every(function (op) { return op.status === 'done'; }) && !work.operations.some(function (op) { return op.status === 'uncertain'; }) && transport && transport.exportReusable) {
          row.append(button('Save reusable steps', function () { mutate('export:' + worker.id, function () { return transport.exportReusable(work.id, worker.id); }); }, pending.has('export:' + worker.id)));
        }
        card.append(row);
      });
      work.reusable.forEach(function (saved) {
        var section = node('section', 'browser-work-reusable'); section.append(node('strong', '', 'Saved steps · ' + saved.workerId), node('p', '', String((saved.proof || []).length) + ' recorded execution proofs · each new run checks its current target and requests approvals.'));
        section.append(button('Choose tab for saved steps', function () { return chooseBots({ sourceWorkId: work.id, reusableId: saved.id }); }, !transport || !saved.proof || !saved.proof.length || work.operations.some(function (op) { return op.status === 'uncertain'; })));
        card.append(section);
      });
      work.approvals.forEach(function (approval) {
        var row = node('section', 'browser-work-approval'); row.append(node('strong', '', 'Approval required'), node('p', '', approval.description || (typeof approval.operation === 'string' ? approval.operation : JSON.stringify(approval.operation || {})) || 'Browser operation'), node('small', '', 'Tab ' + approval.tabId + ' · ' + (approval.actorId || 'Bot')));
        if (approval.expectedUrl) row.append(node('p', 'browser-work-url', approval.expectedUrl));
        var key = 'approval:' + approval.id;
        var expiration = typeof approval.expiresAt === 'number' ? approval.expiresAt : Date.parse(approval.expiresAt);
        var expired = Number.isFinite(expiration) && expiration <= Date.now();
        ['Reject', 'Approve once'].forEach(function (label, i) {
          row.append(button(label, function () { mutate(key, function () { return transport.approval(work.id, approval, i === 1); }); }, !transport || work.terminal || !!expired || pending.has(key)));
        });
        if (expired) row.append(node('small', '', 'Expired · request a new approval.')); card.append(row);
      });
      work.preservedResponses.forEach(function (response) {
        var section = node('section', 'browser-work-preserved');
        section.append(node('strong', '', response.name + ' · ' + (response.historical ? 'Previous answer' : 'Preserved answer')));
        var tags = node('div', 'browser-work-preserved-labels'); response.tags.forEach(function (tag) { tags.append(node('span', '', tag)); }); section.append(tags);
        section.append(node('p', 'browser-work-preserved-notice', 'This answer is retained as context. It is not a completed result or current page verification.'));
        section.append(node('pre', 'browser-work-preserved-text', response.text));
        var context = node('details', 'browser-work-attempt-context'); context.append(node('summary', '', 'Original task context'), node('p', '', 'Overall goal: ' + response.overallGoal), node('p', '', (response.personal ? 'Mia task: ' : 'Bot task: ') + response.goal));
        if (response.context) context.append(node('pre', '', response.context));
        section.append(context); card.append(section);
      });
      work.results.forEach(function (result) { var row = node('details', 'browser-work-result'); row.append(node('summary', '', result.title || 'Stored result'), node('pre', '', result.text || result.content || JSON.stringify(result))); card.append(row); });
      if (work.synthesis) card.append(node('pre', 'browser-work-synthesis', typeof work.synthesis === 'string' ? work.synthesis : work.synthesis.text || JSON.stringify(work.synthesis)));
      list.append(card);
    });
  }
  function updateBrowserState(state) {
    if (!state || !Array.isArray(state.tabs)) return;
    var changedGroup = browserState.selectedGroupId !== state.selectedGroupId;
    browserState = state; if (!host) return;
    if (changedGroup) { requestGeneration++; works = []; loaded = false; document.getElementById('browserWorkCandidates').replaceChildren(); refresh(); }
    renderGroups(); renderWorks();
  }
  async function chooseBots(selectedReusable) {
    var box = document.getElementById('browserWorkCandidates'); box.replaceChildren(); error('');
    var groupId = browserState.selectedGroupId;
    try {
      var inventory = await Promise.all([getBots(), getModels()]); var bots = inventory[0]; modelInventory = connectedModels(inventory[1]);
      if (!modelInventory.length) throw new Error('No connected models are available. Connect a model in setup.');
      if (groupId !== browserState.selectedGroupId) return;
      var personalRow = node('label', 'browser-work-personal-model'); personalRow.append(node('span', '', 'Mia · Personal agent model'));
      var personalModel = node('select'); personalModel.id = 'browserWorkPersonalModel'; personalModel.setAttribute('aria-label', 'Connected model for personal Mia');
      var choosePersonal = node('option', '', 'Choose Mia’s connected model'); choosePersonal.value = ''; personalModel.append(choosePersonal);
      modelInventory.forEach(function (entry, index) { var option = node('option', '', entry.label); option.value = String(index); personalModel.append(option); });
      var retained = configuredModelIndex(modelInventory, personalSelection); personalModel.value = retained >= 0 ? String(retained) : '';
      personalModel.addEventListener('change', function () { personalSelection = selectedConnectedModel(modelInventory, personalModel.value); });
      personalRow.append(personalModel); box.append(personalRow);
      visibleTabs(browserState).forEach(function (tab) {
        var row = node('label', 'browser-work-candidate'); row.setAttribute('data-tab-id', tab.id);
        row.append(node('span', '', 'Tab ' + tab.id + ' · ' + (tab.title || 'New tab')));
        var select = node('select'); select.setAttribute('aria-label', 'Bot for tab ' + tab.id);
        var blank = node('option', '', 'Human · no bot'); blank.value = ''; select.append(blank);
        bots.forEach(function (bot) { var option = node('option', '', bot.name || bot.id); option.value = bot.id; select.append(option); });
        var model = node('select'); model.setAttribute('aria-label', 'Connected model for tab ' + tab.id);
        var unselected = node('option', '', 'Choose connected model'); unselected.value = ''; model.append(unselected);
        modelInventory.forEach(function (entry, index) { var option = node('option', '', entry.label); option.value = String(index); model.append(option); });
        select.addEventListener('change', function () {
          var bot = bots.find(function (b) { return b.id === select.value; });
          var match = configuredModelIndex(modelInventory, bot);
          model.value = match >= 0 ? String(match) : '';
        });
        var reusable = node('select'); reusable.setAttribute('aria-label', 'Saved steps for tab ' + tab.id);
        var noSteps = node('option', '', 'New bot task'); noSteps.value = ''; reusable.append(noSteps);
        works.filter(function (work) { return work.groupId === groupId && !(work.operations || []).some(function (op) { return op.status === 'uncertain'; }); }).forEach(function (work) {
          (work.reusable || []).filter(function (saved) { return saved.proof && saved.proof.length; }).forEach(function (saved) { var option = node('option', '', 'Saved steps · ' + work.goal + ' · ' + saved.workerId); option.value = JSON.stringify({sourceWorkId:work.id,reusableId:saved.id}); reusable.append(option); });
        });
        row.append(select, model, reusable); box.append(row);
      });
      if (selectedReusable && selectedReusable.reusableId) { box.append(node('p', '', 'Choose a bot, connected model and the saved steps for the target tab, then ask Mia to plan and start.')); if (box.scrollIntoView) box.scrollIntoView({block:'nearest'}); }
    } catch (e) { error(e.message || 'Could not load your bots.'); }
  }
  // Planning receives site origins, never credential-bearing paths/query/hash.
  function pageOrigin(value) { try { var url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.origin : ''; } catch (_) { return ''; } }
  async function startWork(event) {
    event.preventDefault(); if (!transport || pending.has('start')) return;
    var candidates = Array.from(document.querySelectorAll('.browser-work-candidate')).map(function (row) {
      var selects = row.querySelectorAll('select'); var botId = selects[0].value; var entry = selectedConnectedModel(modelInventory, selects[1].value);
      var candidate = { botId: botId, tabId: Number(row.getAttribute('data-tab-id')), model: entry && entry.model, provider: entry && entry.provider };
      if (selects[2].value) candidate.reusable = JSON.parse(selects[2].value);
      return candidate;
    }).filter(function (c) { return c.botId; });
    var personalModel = document.getElementById('browserWorkPersonalModel');
    var chosenPersonal = personalModel && selectedConnectedModel(modelInventory, personalModel.value);
    if (!chosenPersonal) { error('Choose a connected model for your personal Mia agent.'); return; }
    if (!candidates.length || candidates.some(function (c) { return !c.model || !c.provider; })) { error('Choose at least one bot and a connected model for each assigned tab.'); return; }
    if (new Set(candidates.map(function (c) { return c.botId; })).size !== candidates.length) { error('Each bot can own one tab. Choose a different bot for each tab.'); return; }
    var selected = (browserState.groups || []).find(function (g) { return g.id === browserState.selectedGroupId; });
    if (!selected || candidates.some(function (c) { return !selected.tabIds.includes(c.tabId); })) { error('Tabs changed. Choose bots again.'); return; }
    var goal = document.getElementById('browserWorkGoal').value.trim(); if (!goal) return;
    pending.add('start'); var start = document.getElementById('browserWorkStart'); start.disabled = true; error('');
    try { await transport.plan({ groupId: selected.id, goal: goal, personalSelection: { provider: chosenPersonal.provider, model: chosenPersonal.model }, context: { groupName: selected.name, tabs: visibleTabs(browserState).map(function (t) { return { id: t.id, title: t.title, origin: pageOrigin(t.url) }; }) }, candidates: candidates }); await refresh(); }
    catch (e) { error(e.message || 'Mia could not start browser work.'); }
    finally { pending.delete('start'); start.disabled = false; }
  }
  function mount(options) {
    host = document.getElementById('browserWorkPanel'); if (!host) return;
    bridge = options.browser; transport = options.transport || null; getBots = options.getBots; getModels = options.getModels;
    document.getElementById('browserWorkAssignments').onclick = chooseBots;
    document.getElementById('browserWorkCreate').addEventListener('submit', startWork);
    document.getElementById('browserWorkStart').disabled = !transport;
    var stopGroup = document.getElementById('browserWorkStopGroup');
    if (stopGroup) { stopGroup.disabled = !transport || !transport.stopGroup; stopGroup.onclick = function () { var groupId = browserState.selectedGroupId; if (!groupId) return; stopGroup.disabled = true; mutate('stop-group:' + groupId, function () { return transport.stopGroup(groupId); }).finally(function () { stopGroup.disabled = false; }); }; }
    bridge.onState(updateBrowserState);
    document.getElementById('browserGroupAdd').onclick = function () {
      groupCommand('group-create', { name: document.getElementById('browserGroupNewName').value });
    };
    document.getElementById('browserGroupRename').onclick = function () { groupCommand('group-rename', { groupId: browserState.selectedGroupId, name: document.getElementById('browserGroupName').value }); };
    document.getElementById('browserGroupRemove').onclick = function () { groupCommand('group-remove', { groupId: browserState.selectedGroupId }); };
    document.getElementById('browserMoveTab').onclick = function () { groupCommand('group-move-tab', { id: browserState.activeId, groupId: document.getElementById('browserMoveTabGroup').value }); };
    document.getElementById('browserGroupEarlier').onclick = function () { var order = browserState.groups.map(function (g) { return g.id; }); var i = order.indexOf(browserState.selectedGroupId); if (i > 0) { var id = order.splice(i, 1)[0]; order.splice(i - 1, 0, id); groupCommand('group-reorder', { groupIds: order }); } };
    new MutationObserver(function () { if (!document.getElementById('localBrowserOverlay').hidden) refresh(); }).observe(document.getElementById('localBrowserOverlay'), { attributes: true, attributeFilter: ['hidden'] });
    bridge.command({ action: 'state' }).then(updateBrowserState).catch(function () { error('Browser unavailable.'); });
    if (timer) clearInterval(timer); timer = setInterval(refresh, 2000); refresh();
  }
  return { selectedConnectedModel: selectedConnectedModel, taskRecoveryState: taskRecoveryState, preservedResponse: preservedResponse, configuredModelIndex: configuredModelIndex, connectedModels: connectedModels, recoveryState: recoveryState, pageOrigin: pageOrigin, visibleTabs: visibleTabs, projection: projection, decorateTabs: decorateTabs, updateBrowserState: updateBrowserState, mount: mount, refresh: refresh };
});
