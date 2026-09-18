import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('./app.js', import.meta.url);

test('New Channel creates a shared channel without attaching the private Mia agent', async () => {
  const source = await readFile(appUrl, 'utf8');
  const flowStart = source.indexOf('function openNewChannelFlow(){');
  const flowEnd = source.indexOf('\n\n  (function(){', flowStart);
  const selectStart = source.indexOf('function selectDepartmentRoom(dept, displayName){');
  const selectEnd = source.indexOf('\n\n  function nativeThinkingAgentName', selectStart);
  assert.ok(flowStart >= 0 && flowEnd > flowStart, 'New Channel flow exists');
  assert.ok(selectStart >= 0 && selectEnd > selectStart, 'shared channel selection exists');
  const flow = source.slice(flowStart, flowEnd);
  const selection = source.slice(selectStart, selectEnd);

  assert.match(flow, /channelNameCompose\.open = true/);
  assert.match(selection, /type: 'channel'/);
  assert.match(selection, /loadChatRoom\(res\.data\.conversation\.id, 'department', label\)/);
  assert.doesNotMatch(selection, /gateway|principalType:\s*'agent'|ensureNativeMiaChannelMember/);
  assert.doesNotMatch(flow, /startAgentSetupChat\(\)/);
  assert.doesNotMatch(source, /function ensureNativeMiaChannelMember|function seedNewChannelWelcome/);
  assert.match(source, /action === 'new-channel'\) openNewChannelFlow\(\)/);
});

test('New Channel renders only the DB-confirmed conversation record', async () => {
  const source = await readFile(appUrl, 'utf8');
  const createStart = source.indexOf('function createNamedChannel(){');
  const createEnd = source.indexOf('\n  function openNewChannelFlow(){', createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, 'New Channel creation block exists');
  const flow = source.slice(createStart, createEnd);

  assert.match(source, /deptCache is only the latest server-confirmed snapshot/);
  assert.doesNotMatch(source, /LS_DEPARTMENTS|departmentsStorageKey|var DEFAULT_DEPARTMENTS/);
  assert.match(flow, /selectDepartmentRoom\(\{department:name\}, name\)\.then/);
  assert.match(flow, /closeChannelNameFlow\(\)/);
  assert.doesNotMatch(flow, /saveDepartments|chatWs\.allDepartments|renderChatSidebar/);
  assert.equal((source.match(/chatWs\.allDepartments\s*=/g) || []).length, 1,
    'only applyNativeConversationList may project channel names into the sidebar');
  assert.match(source, /createdTs: Date\.parse\(deptRoom && deptRoom\.createdAt \|\| ''\) \|\| 0/);
  assert.match(source, /return Math\.max\(Number\(entry\.lastTs\) \|\| 0, Number\(entry\.createdTs\) \|\| 0\)/);
});
