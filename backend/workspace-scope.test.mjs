import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_WORKSPACE_ID,
  departmentsMetaKey,
  recordBelongsToCompany,
  workspaceCompanyId,
  workspaceIdForRecord,
  workspaceIdFromRequest,
} = require('./workspace-scope.js');

test('legacy records and requests stay in Multiplayer Test while Solo gets an isolated company scope', () => {
  const owner = 'alice@example.com';
  const multiplayerCompany = workspaceCompanyId('example.com', 'multiplayer_test', owner);
  const soloCompany = workspaceCompanyId('example.com', 'solo', owner);

  assert.equal(DEFAULT_WORKSPACE_ID, 'multiplayer_test');
  assert.equal(workspaceIdForRecord({ owner }), 'multiplayer_test');
  assert.equal(multiplayerCompany, 'example.com');
  assert.notEqual(soloCompany, multiplayerCompany);
  assert.match(soloCompany, /^example\.com:solo:[0-9a-f]{20}$/);
  assert.equal(recordBelongsToCompany({ owner, workspaceId: 'multiplayer_test' }, 'example.com', multiplayerCompany), true);
  assert.equal(recordBelongsToCompany({ owner, workspaceId: 'multiplayer_test' }, 'example.com', soloCompany), false);
});

test('workspace request and department persistence use separate validated scopes', () => {
  assert.equal(workspaceIdFromRequest({ headers: { 'x-miaos-workspace': 'solo' }, query: {} }), 'solo');
  assert.equal(workspaceIdFromRequest({ headers: {}, query: { workspace: 'multiplayer_test' } }), 'multiplayer_test');
  assert.equal(workspaceIdFromRequest({ headers: { 'x-miaos-workspace': 'friends' }, query: {} }), 'multiplayer_test');
  assert.equal(departmentsMetaKey('Alice@Example.com', 'multiplayer_test'), 'departments:alice@example.com');
  assert.equal(departmentsMetaKey('Alice@Example.com', 'solo'), 'departments:alice@example.com:solo');
});
