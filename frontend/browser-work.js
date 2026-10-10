/* Browser work UI consumes durable coordinator records and trusted browser state.
 * It does not grant approvals, execute page actions, or infer model progress. */
(function (root, factory) {
  var exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.MiaBrowserWork = exports;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var browserState = { tabs: [] }, works = [], host, bridge, transport, loaded = false;
  var requestGeneration = 0, timer, pending = new Set(), getBots, lastWorkRender = '', lastGroupRender = '';
  var labels = { queued: 'Queued', working: 'Working', waiting_for_user: 'Waiting for you', needs_approval: 'Needs approval', done: 'Done', failed: 'Failed', cancelled: 'Stopped' };
  function visibleTabs(state) {
    var group = (state.groups || []).find(function (g) { return g.id === state.selectedGroupId; });
    if (!group) return state.tabs || [];
    return group.tabIds.map(function (id) { return (state.tabs || []).find(function (t) { return t.id === id; }); }).filter(Boolean);
  }
  function projection(work, groupId) {
    if (!work || work.groupId !== groupId) return null;
    return { id: work.id, goal: String(work.goal || ''), status: labels[work.status] || 'Unknown state',
      terminal: ['done', 'failed', 'cancelled'].includes(work.status),
      workers: Array.isArray(work.workers) ? work.workers : [],
      results: Array.isArray(work.results) ? work.results : Object.keys(work.results || {}).map(function (id) { return Object.assign({ title: 'Stored result · ' + id }, work.results[id]); }),
      approvals: (Array.isArray(work.approvals) ? work.approvals : []).filter(function (a) { return a.status === 'pending'; }),
      synthesis: work.synthesis || null };
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
    var signature = JSON.stringify([records, loaded, !!transport, Array.from(pending)]);
    if (signature === lastWorkRender) return; lastWorkRender = signature;
    var list = document.getElementById('browserWorkList'); list.replaceChildren();
    document.getElementById('browserWorkEmpty').hidden = records.length > 0;
    document.getElementById('browserWorkEmpty').textContent = !transport ? 'Browser work is unavailable in this build.' : !loaded ? 'Loading browser work…' : 'No browser work in this group.';
    records.forEach(function (work) {
      var card = node('article', 'browser-work-card'); card.append(node('strong', '', work.goal));
      var header = node('div', 'browser-work-heading'); header.append(node('span', 'browser-work-status', work.status));
      if (!work.terminal) header.append(button('Stop group work', function () { mutate('stop:' + work.id, function () { return transport.cancel(work.id); }); }, !transport || pending.has('stop:' + work.id)));
      card.append(header);
      card.append(node('div', 'browser-work-coordinator', 'Mia · Personal agent · Planning and synthesis'));
      work.workers.forEach(function (worker) {
        var row = node('div', 'browser-work-worker'); var mote = node('img', 'browser-work-mote'); mote.src = 'assets/mote/mote.svg'; mote.alt = '';
        row.append(mote, node('span', '', String(worker.name || worker.botId || worker.actorId) + ' · Tab ' + worker.tabId), node('span', 'browser-work-status', labels[worker.status] || 'Unknown state'));
        if (worker.task || worker.goal) row.append(node('p', '', worker.task || worker.goal));
        if (!work.terminal && !['done', 'failed', 'cancelled'].includes(worker.status)) row.append(button('Stop bot', function () { mutate('stop:' + worker.actorId, function () { return transport.cancel(work.id, worker.id); }); }, !transport || pending.has('stop:' + worker.actorId)));
        card.append(row);
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
  async function chooseBots() {
    var box = document.getElementById('browserWorkCandidates'); box.replaceChildren(); error('');
    var groupId = browserState.selectedGroupId;
    try {
      var bots = await getBots(); if (groupId !== browserState.selectedGroupId) return;
      visibleTabs(browserState).forEach(function (tab) {
        var row = node('label', 'browser-work-candidate'); row.setAttribute('data-tab-id', tab.id);
        row.append(node('span', '', 'Tab ' + tab.id + ' · ' + (tab.title || 'New tab')));
        var select = node('select'); select.setAttribute('aria-label', 'Bot for tab ' + tab.id);
        var blank = node('option', '', 'Human · no bot'); blank.value = ''; select.append(blank);
        bots.forEach(function (bot) { var option = node('option', '', bot.name || bot.id); option.value = bot.id; select.append(option); });
        var model = node('input'); model.placeholder = 'Model'; model.setAttribute('aria-label', 'Model for tab ' + tab.id);
        var provider = node('input'); provider.placeholder = 'Provider'; provider.setAttribute('aria-label', 'Provider for tab ' + tab.id);
        select.addEventListener('change', function () { var bot = bots.find(function (b) { return b.id === select.value; }); model.value = bot && bot.model || ''; provider.value = bot && bot.provider || ''; });
        row.append(select, model, provider); box.append(row);
      });
    } catch (e) { error(e.message || 'Could not load your bots.'); }
  }
  async function startWork(event) {
    event.preventDefault(); if (!transport || pending.has('start')) return;
    var candidates = Array.from(document.querySelectorAll('.browser-work-candidate')).map(function (row) {
      var botId = row.querySelector('select').value; var inputs = row.querySelectorAll('input');
      return { botId: botId, tabId: Number(row.getAttribute('data-tab-id')), model: inputs[0].value.trim(), provider: inputs[1].value.trim() };
    }).filter(function (c) { return c.botId; });
    if (!candidates.length || candidates.some(function (c) { return !c.model || !c.provider; })) { error('Choose at least one bot with a model and provider.'); return; }
    if (new Set(candidates.map(function (c) { return c.botId; })).size !== candidates.length) { error('Each bot can own one tab. Choose a different bot for each tab.'); return; }
    var selected = (browserState.groups || []).find(function (g) { return g.id === browserState.selectedGroupId; });
    if (!selected || candidates.some(function (c) { return !selected.tabIds.includes(c.tabId); })) { error('Tabs changed. Choose bots again.'); return; }
    var goal = document.getElementById('browserWorkGoal').value.trim(); if (!goal) return;
    pending.add('start'); var start = document.getElementById('browserWorkStart'); start.disabled = true; error('');
    try { await transport.plan({ groupId: selected.id, goal: goal, context: { groupName: selected.name, tabs: visibleTabs(browserState).map(function (t) { return { id: t.id, title: t.title, url: t.url }; }) }, candidates: candidates }); await refresh(); }
    catch (e) { error(e.message || 'Mia could not start browser work.'); }
    finally { pending.delete('start'); start.disabled = false; }
  }
  function mount(options) {
    host = document.getElementById('browserWorkPanel'); if (!host) return;
    bridge = options.browser; transport = options.transport || null; getBots = options.getBots;
    document.getElementById('browserWorkAssignments').onclick = chooseBots;
    document.getElementById('browserWorkCreate').addEventListener('submit', startWork);
    document.getElementById('browserWorkStart').disabled = !transport;
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
  return { visibleTabs: visibleTabs, projection: projection, decorateTabs: decorateTabs, updateBrowserState: updateBrowserState, mount: mount, refresh: refresh };
});
