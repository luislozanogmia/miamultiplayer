import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import Database from 'better-sqlite3';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createWorkspaceArtifactService } = require('./workspace-artifacts.js');
const { createWorkspaceArtifactRouter } = require('./workspace-artifact-router.js');

async function fixture() {
  const database = new Database(':memory:');
  const rootDir = await mkdtemp(join(tmpdir(), 'mia-workspace-artifacts-'));
  const service = createWorkspaceArtifactService({ database, rootDir });
  const principals = new Map([
    ['alice', { principalId: 'alice@example.test', principalType: 'user' }],
    ['bob', { principalId: 'bob@example.test', principalType: 'user' }],
    ['viewer', { principalId: 'viewer@example.test', principalType: 'user' }],
    ['outsider', { principalId: 'outsider@example.test', principalType: 'user' }],
    ['bot', { principalId: 'bot_due_diligence', principalType: 'bot' }],
  ]);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', createWorkspaceArtifactRouter({
    service,
    resolvePrincipal: (req) => principals.get(req.headers['x-principal']) || null,
  }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  async function request(path, { principal = 'alice', method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'x-principal': principal,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { response, payload };
  }

  return {
    database,
    request,
    async close() {
      server.close();
      await once(server, 'close');
      database.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test('local workspace membership authorizes immutable artifact versions for people and bots', async () => {
  const app = await fixture();
  try {
    let result = await app.request('/workspaces', {
      method: 'POST',
      body: { name: 'Quarterly reports', id: 'client-cannot-pick-this' },
    });
    assert.equal(result.response.status, 201);
    const workspaceId = result.payload.workspace.id;
    assert.match(workspaceId, /^ws_/);

    for (const member of [
      { principalId: 'bob@example.test', principalType: 'user', role: 'member' },
      { principalId: 'viewer@example.test', principalType: 'user', role: 'viewer' },
      { principalId: 'bot_due_diligence', principalType: 'bot', role: 'bot' },
    ]) {
      result = await app.request(`/workspaces/${workspaceId}/members`, { method: 'POST', body: member });
      assert.equal(result.response.status, 201);
    }

    result = await app.request(`/workspaces/${workspaceId}/members`, { principal: 'bot' });
    assert.equal(result.response.status, 403, 'bots cannot enumerate human workspace membership');

    result = await app.request('/workspaces', { method: 'POST', body: { name: 'Secondary workspace' } });
    assert.equal(result.response.status, 201);
    const otherWorkspaceId = result.payload.workspace.id;
    result = await app.request(`/workspaces/${otherWorkspaceId}/artifacts`, { principal: 'bot' });
    assert.equal(result.response.status, 404, 'bot membership never crosses workspace boundaries');

    const firstBytes = Buffer.from('analysis memo v1');
    result = await app.request(`/workspaces/${workspaceId}/artifacts`, {
      method: 'POST',
      body: {
        workspaceId: 'spoofed-workspace',
        name: 'Analysis memo',
        filename: 'analysis.txt',
        mimeType: 'text/plain',
        taskId: 'task_alpha_001',
        contentBase64: firstBytes.toString('base64'),
        metadata: { source: 'local-test' },
      },
    });
    assert.equal(result.response.status, 201);
    const artifactId = result.payload.artifact.id;
    const firstVersion = result.payload.version;
    assert.equal(firstVersion.version, 1);
    assert.equal(firstVersion.workspaceId, workspaceId);

    result = await app.request(`/workspaces/${workspaceId}/artifacts`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.artifacts[0].latestVersion.id, firstVersion.id);

    result = await app.request(
      `/workspaces/${workspaceId}/artifacts/${artifactId}/versions/${firstVersion.id}/content`,
      { principal: 'bob' }
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, firstBytes);
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');

    result = await app.request(`/workspaces/${workspaceId}/artifacts`, { principal: 'outsider' });
    assert.equal(result.response.status, 404);
    result = await app.request(
      `/workspaces/${workspaceId}/artifacts/${artifactId}/versions/${firstVersion.id}/content`,
      { principal: 'outsider' }
    );
    assert.equal(result.response.status, 404);

    result = await app.request(`/workspaces/${workspaceId}/artifacts/${artifactId}/versions`, {
      principal: 'viewer',
      method: 'POST',
      body: {
        parentVersionId: firstVersion.id,
        filename: 'forbidden.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('viewer write').toString('base64'),
      },
    });
    assert.equal(result.response.status, 403);

    const botBytes = Buffer.from('bot-produced analysis memo v2');
    result = await app.request(`/workspaces/${workspaceId}/artifacts/${artifactId}/versions`, {
      principal: 'bot',
      method: 'POST',
      body: {
        parentVersionId: firstVersion.id,
        filename: 'analysis-v2.txt',
        mimeType: 'text/plain',
        contentBase64: botBytes.toString('base64'),
        metadata: { producer: 'bot_due_diligence' },
      },
    });
    assert.equal(result.response.status, 201);
    const secondVersion = result.payload.version;
    assert.equal(secondVersion.version, 2);
    assert.equal(secondVersion.parentVersionId, firstVersion.id);

    result = await app.request(`/workspaces/${workspaceId}/artifacts/${artifactId}/versions`, {
      principal: 'bob',
      method: 'POST',
      body: {
        parentVersionId: firstVersion.id,
        filename: 'stale.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('stale overwrite').toString('base64'),
      },
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error, 'VERSION_CONFLICT');

    result = await app.request(`/workspaces/${workspaceId}/artifacts/${artifactId}/versions`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.versions.map((version) => version.id), [firstVersion.id, secondVersion.id]);

    result = await app.request(
      `/workspaces/${workspaceId}/artifacts/${artifactId}/versions/${firstVersion.id}/content`,
      { principal: 'bob' }
    );
    assert.deepEqual(result.payload, firstBytes, 'adding v2 never mutates v1 bytes');
    result = await app.request(
      `/workspaces/${workspaceId}/artifacts/${artifactId}/versions/${secondVersion.id}/content`,
      { principal: 'bob' }
    );
    assert.deepEqual(result.payload, botBytes);

    result = await app.request(
      `/workspaces/${workspaceId}/members/user/${encodeURIComponent('bob@example.test')}`,
      { method: 'DELETE' }
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.state, 'removed');
    result = await app.request(`/workspaces/${workspaceId}/artifacts`, { principal: 'bob' });
    assert.equal(result.response.status, 404, 'revoked membership stops artifact access immediately');

    result = await app.request(
      `/workspaces/${workspaceId}/members/user/${encodeURIComponent('alice@example.test')}`,
      { method: 'DELETE' }
    );
    assert.equal(result.response.status, 403, 'the member endpoint cannot remove the workspace owner');

    const versionRows = app.database.prepare(
      'SELECT version, storage_path AS storagePath FROM workspace_artifact_versions ORDER BY version'
    ).all();
    assert.equal(versionRows.length, 2);
    assert.ok(versionRows.every((row) => row.storagePath.startsWith(`${workspaceId}/${artifactId}/`)));
  } finally {
    await app.close();
  }
});
