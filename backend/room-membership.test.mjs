import assert from 'node:assert/strict';
import test from 'node:test';
import db from './db.js';

test('room human memberships are idempotent and preserve removal state', () => {
  const conn = db.openDb(':memory:', '');

  db.upsertRoomHumanMembership(conn, {
    roomId: '!room:example.com',
    userEmail: 'alice@example.com',
    addedBy: 'alice@example.com',
  });
  db.upsertRoomHumanMembership(conn, {
    roomId: '!room:example.com',
    userEmail: 'bob@example.com',
    addedBy: 'alice@example.com',
  });

  assert.deepEqual(
    db.listRoomHumanMemberships(conn, '!room:example.com')
      .map((row) => [row.userEmail, row.state])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['alice@example.com', 'active'],
      ['bob@example.com', 'active'],
    ],
  );

  db.setRoomHumanMembershipState(conn, '!room:example.com', 'bob@example.com', 'removed');
  db.upsertRoomHumanMembership(conn, {
    roomId: '!room:example.com',
    userEmail: 'alice@example.com',
    addedBy: 'bob@example.com',
  });

  const rows = db.listRoomHumanMemberships(conn, '!room:example.com');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.userEmail === 'bob@example.com').state, 'removed');
  assert.equal(rows.find((row) => row.userEmail === 'alice@example.com').state, 'active');
  conn.close();
});

test('re-adding a removed human explicitly restores active membership', () => {
  const conn = db.openDb(':memory:', '');
  db.upsertRoomHumanMembership(conn, {
    roomId: '!group:example.com',
    userEmail: 'bob@example.com',
  });
  db.setRoomHumanMembershipState(conn, '!group:example.com', 'bob@example.com', 'removed');
  db.upsertRoomHumanMembership(conn, {
    roomId: '!group:example.com',
    userEmail: 'bob@example.com',
    addedBy: 'alice@example.com',
  });
  assert.equal(
    db.getRoomHumanMembership(conn, '!group:example.com', 'bob@example.com').state,
    'active',
  );
  conn.close();
});
