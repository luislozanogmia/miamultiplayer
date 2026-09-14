import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

function sourceFunction(source, name, context = {}) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return vm.runInNewContext(`(${source.slice(start, index + 1)})`, context);
  }
  throw new Error(`Could not extract ${name}`);
}

function frontendFunction(name) {
  return sourceFunction(appSource, name);
}

test('chat roster shows active humans from native membership state', () => {
  const visibleHumans = frontendFunction('chatVisibleHumans');
  const joined = { email: 'alice@example.com', roomState: 'active', membership: 'join' };
  const invited = { email: 'bob@example.com', roomState: 'active', membership: 'invite' };
  const removed = { email: 'removed@example.com', roomState: 'removed', membership: 'join', inChat: true };

  assert.deepEqual(visibleHumans([joined, invited, removed]), [joined, invited]);
});

test('legacy roster responses still show an explicitly in-chat human', () => {
  const visibleHumans = frontendFunction('chatVisibleHumans');
  const legacyJoined = { email: 'alice@example.com', inChat: true };
  const legacyAbsent = { email: 'bob@example.com', inChat: false };

  assert.deepEqual(visibleHumans([legacyJoined, legacyAbsent]), [legacyJoined]);
});

test('one-to-one headers identify one agent or one bot without a combined count', () => {
  const countLabel = frontendFunction('chatRosterAgentCountLabel');
  const peopleLabel = frontendFunction('chatRosterPeopleCountLabel');
  assert.equal(peopleLabel([{}]), '1 user');
  assert.equal(peopleLabel([{}, {}]), '2 users');
  assert.equal(countLabel([{ principalType: 'agent' }]), '1 agent');
  assert.equal(countLabel([{ principalType: 'bot' }]), '1 bot');
  assert.equal(countLabel([{ principalType: 'agent' }, { principalType: 'bot' }]), '2 agents &amp; bots');
});

test('server human directory is available in Multiplayer Test and empty in Solo', () => {
  const projectUsers = sourceFunction(serverSource, 'humanDirectoryUsersForWorkspace', {
    DEFAULT_WORKSPACE_ID: 'multiplayer_test',
  });
  const users = [
    { email: 'alice@example.com', displayName: 'Dana', initials: 'DA' },
    { email: 'bob@example.com', displayName: 'Example User', initials: 'EU' },
  ];

  assert.deepEqual(Array.from(projectUsers(users, 'alice@example.com', 'solo')), []);
  assert.deepEqual(Array.from(projectUsers(users, 'alice@example.com', 'multiplayer_test'), (user) => ({ ...user })), [
    { email: 'bob@example.com', displayName: 'Example User', initials: 'EU' },
  ]);

  const routeStart = serverSource.indexOf("app.get('/api/users'");
  const routeEnd = serverSource.indexOf("\napp.put('/api/me'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(
    serverSource.slice(routeStart, routeEnd),
    /humanDirectoryUsersForWorkspace\(activeWorkspaceUsers\(\), caller, workspaceIdFromRequest\(req\)\)/
  );
});

function departmentLoader({ meta = null, bots = [] } = {}) {
  const writes = [];
  const context = {
    DEFAULT_DEPARTMENTS: ['Product', 'Operations', 'Finance', 'Support'],
    DEFAULT_OWNER: 'alice@example.com',
    DEFAULT_WORKSPACE_ID: 'multiplayer_test',
    conn: {},
    db: {
      getMeta: () => meta,
      setMeta: (_conn, key, value) => writes.push({ key, value }),
      loadAll: () => bots,
    },
    departmentsMetaKey: (owner, workspaceId) => `departments:${owner}${workspaceId === 'solo' ? ':solo' : ''}`,
    workspaceIdForRecord: (record) => record.workspaceId || 'multiplayer_test',
    sameOwner: (record, email) => String(record.owner || '').toLowerCase() === String(email || '').toLowerCase(),
    departmentsOf: (record) => Array.isArray(record.departments) ? record.departments : [],
  };
  context.initialDepartmentsForWorkspace = sourceFunction(serverSource, 'initialDepartmentsForWorkspace', context);
  context.reconcileLegacySoloDepartments = sourceFunction(serverSource, 'reconcileLegacySoloDepartments', context);
  return {
    load: sourceFunction(serverSource, 'loadDepartmentsList', context),
    writes,
  };
}

test('new Solo departments derive only from that owner\'s Solo bots', () => {
  const empty = departmentLoader();
  assert.deepEqual(Array.from(empty.load('alice@example.com', 'solo')), []);
  assert.deepEqual(empty.writes, [
    { key: 'departments:alice@example.com:solo', value: '[]' },
  ]);

  const owned = departmentLoader({ bots: [
    { owner: 'alice@example.com', workspaceId: 'solo', departments: ['Research'] },
    { owner: 'bob@example.com', workspaceId: 'solo', departments: ['Finance'] },
    { owner: 'alice@example.com', workspaceId: 'multiplayer_test', departments: ['Operations'] },
  ] });
  assert.deepEqual(Array.from(owned.load('alice@example.com', 'solo')), ['Research']);
});

test('legacy synthetic Solo defaults reconcile without changing Multiplayer Test defaults', () => {
  const defaultsOnly = departmentLoader({
    meta: JSON.stringify(['Product', 'Operations', 'Finance', 'Support']),
  });
  assert.deepEqual(Array.from(defaultsOnly.load('alice@example.com', 'solo')), []);
  assert.deepEqual(defaultsOnly.writes, [{
    key: 'departments:alice@example.com:solo',
    value: '[]',
  }]);

  const legacySolo = departmentLoader({
    meta: JSON.stringify(['Product', 'Operations', 'Finance', 'Support', 'Research']),
    bots: [{ owner: 'alice@example.com', workspaceId: 'solo', departments: ['Finance'] }],
  });
  assert.deepEqual(Array.from(legacySolo.load('alice@example.com', 'solo')), ['Finance', 'Research']);
  assert.deepEqual(legacySolo.writes, [{
    key: 'departments:alice@example.com:solo',
    value: JSON.stringify(['Finance', 'Research']),
  }]);

  const multiplayer = departmentLoader({
    bots: [{ owner: 'alice@example.com', workspaceId: 'multiplayer_test', departments: ['Research'] }],
  });
  assert.deepEqual(Array.from(multiplayer.load('alice@example.com', 'multiplayer_test')), [
    'Product', 'Operations', 'Finance', 'Support', 'Research',
  ]);
});
