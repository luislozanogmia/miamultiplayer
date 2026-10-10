'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserGroups } = require('./browser-groups.cjs');
test('legacy tabs load, group names/order/selection round trip without aliasing', () => {
  const groups = createBrowserGroups({ tabs: [{ id: 1 }, { id: 2 }, { id: 3 }], activeId: 2 });
  assert.equal(groups.snapshot().groups[0].selectedTabId, 2);
  groups.create('Research', 'research'); groups.moveTab(3, 'research');
  groups.rename('default', 'Human'); groups.reorder(['research', 'default']);
  assert.equal(groups.selectGroup('research'), 3);
  const saved = groups.snapshot();
  const restored = createBrowserGroups({ saved: JSON.parse(JSON.stringify(saved)), tabs: [1, 2, 3], activeId: 3 });
  assert.deepEqual(restored.snapshot(), saved);
  restored.selectGroup('default'); assert.equal(restored.snapshot().groups[1].selectedTabId, 2);
  saved.groups[0].tabIds.push(999); assert.equal(restored.snapshot().groups[0].tabIds.length, 1);
});
test('reconcile removes closed IDs, assigns new tabs to selected group, repairs selected tab', () => {
  const groups = createBrowserGroups({ tabs: [1, 2], activeId: 2 });
  groups.create('New', 'new'); groups.selectGroup('new'); groups.reconcile([1, 2, 3], 3);
  groups.reconcile([1, 2], null);
  assert.deepEqual(groups.snapshot().groups[1].tabIds, []);
  assert.equal(groups.snapshot().groups[1].selectedTabId, null);
});
test('invalid saved groups are repaired and duplicate membership is removed', () => {
  const groups = createBrowserGroups({ tabs: [1, 2, 3], saved: { groups: [null, { id: 'a', name: 'A', tabIds: [1, 1, 99] }, { id: 'b', name: 'B', tabIds: [1, 2], selectedTabId: 99 }] } });
  assert.deepEqual(groups.snapshot().groups.map(g => g.tabIds), [[1, 3], [2]]);
});
test('invalid mutations fail without losing state; nonempty groups cannot be removed', () => {
  const groups = createBrowserGroups({ tabs: [1], activeId: 1 }); groups.create('Other', 'other');
  const before = groups.snapshot();
  for (const action of [() => groups.reorder(['other', 'other']), () => groups.moveTab(1, 'missing'), () => groups.moveTab(1, 'other', -1), () => groups.rename('default', ''), () => groups.remove('default')]) {
    assert.throws(action); assert.deepEqual(groups.snapshot(), before);
  }
  groups.moveTab(1, 'other'); groups.remove('default'); assert.equal(groups.selectGroup('other'), 1);
});
