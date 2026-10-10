'use strict';

const { randomUUID } = require('node:crypto');
const DEFAULT_GROUP = 'default';
const validTab = id => Number.isSafeInteger(id) && id > 0;
const nameOf = value => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80) throw new Error('Group names must contain 1–80 characters.');
  return name;
};

// Pure state owner: browser.cjs supplies live tab IDs and persists snapshot()
// alongside tabs. It must select the ID returned by selectGroup(). Never focus
// a native view from this module, and never treat a group as actor authorization.
function createBrowserGroups({ saved = {}, tabs = [], activeId = null } = {}) {
  let groups = [];
  let selectedGroupId = null;
  const ids = list => list.map(t => typeof t === 'object' ? t.id : t).filter(validTab);
  const known = new Set(ids(tabs));
  const claimed = new Set();
  for (const item of Array.isArray(saved.groups) ? saved.groups.slice(0, 100) : []) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || groups.some(g => g.id === item.id)) continue;
    let name;
    try { name = nameOf(item.name); } catch (_) { continue; }
    const tabIds = (Array.isArray(item.tabIds) ? item.tabIds : []).filter(id => {
      if (!known.has(id) || claimed.has(id)) return false;
      claimed.add(id); return true;
    });
    groups.push({ id: item.id, name, tabIds, selectedTabId: tabIds.includes(item.selectedTabId) ? item.selectedTabId : tabIds[0] || null });
  }
  if (!groups.length) groups.push({ id: DEFAULT_GROUP, name: 'Browser', tabIds: [], selectedTabId: null });
  selectedGroupId = groups.some(g => g.id === saved.selectedGroupId) ? saved.selectedGroupId : groups[0].id;
  const get = id => { const group = groups.find(g => g.id === id); if (!group) throw new Error('Browser group was not found.'); return group; };
  function reconcile(nextTabs, nextActiveId) {
    const liveIds = [...new Set(ids(nextTabs))];
    const live = new Set(liveIds);
    const existing = new Set();
    for (const group of groups) {
      group.tabIds = group.tabIds.filter(id => live.has(id));
      group.tabIds.forEach(id => existing.add(id));
      if (!group.tabIds.includes(group.selectedTabId)) group.selectedTabId = group.tabIds[0] || null;
    }
    const selected = get(selectedGroupId);
    for (const id of liveIds) if (!existing.has(id)) selected.tabIds.push(id);
    if (live.has(nextActiveId)) {
      const group = groups.find(g => g.tabIds.includes(nextActiveId));
      group.selectedTabId = nextActiveId;
      selectedGroupId = group.id;
    } else if (!selected.tabIds.includes(selected.selectedTabId)) selected.selectedTabId = selected.tabIds[0] || null;
    return snapshot();
  }
  function snapshot() { return { groups: groups.map(g => ({ ...g, tabIds: [...g.tabIds] })), selectedGroupId }; }
  reconcile(tabs, activeId);
  return {
    snapshot, reconcile,
    create(name, id = randomUUID()) {
      name = nameOf(name);
      if (typeof id !== 'string' || !id || id.length > 128 || groups.some(g => g.id === id) || groups.length >= 100) throw new Error('Invalid or duplicate browser group.');
      groups.push({ id, name, tabIds: [], selectedTabId: null });
      return id;
    },
    rename(id, name) { get(id).name = nameOf(name); return snapshot(); },
    reorder(order) {
      if (!Array.isArray(order) || order.length !== groups.length || new Set(order).size !== groups.length || order.some(id => !groups.some(g => g.id === id))) throw new Error('Supply every group exactly once.');
      groups = order.map(get); return snapshot();
    },
    moveTab(tabId, groupId, index) {
      const target = get(groupId);
      const source = groups.find(g => g.tabIds.includes(tabId));
      if (!source) throw new Error('Browser tab was not found.');
      if (index !== undefined && (!Number.isInteger(index) || index < 0 || index > target.tabIds.length)) throw new Error('Invalid tab position.');
      source.tabIds = source.tabIds.filter(id => id !== tabId);
      if (source.selectedTabId === tabId) source.selectedTabId = source.tabIds[0] || null;
      target.tabIds.splice(index === undefined ? target.tabIds.length : index, 0, tabId);
      if (target.selectedTabId === null) target.selectedTabId = tabId;
      return snapshot();
    },
    selectGroup(id) { const group = get(id); selectedGroupId = id; return group.selectedTabId; },
    selectTab(tabId) {
      const group = groups.find(g => g.tabIds.includes(tabId));
      if (!group) throw new Error('Browser tab was not found.');
      selectedGroupId = group.id; group.selectedTabId = tabId; return snapshot();
    },
    remove(id) {
      const group = get(id);
      if (groups.length === 1) throw new Error('Keep at least one browser group.');
      if (group.tabIds.length) throw new Error('Move or close this group’s tabs first.');
      groups = groups.filter(g => g.id !== id);
      if (selectedGroupId === id) selectedGroupId = groups[0].id;
      return get(selectedGroupId).selectedTabId;
    },
  };
}
module.exports = { createBrowserGroups };
