import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const google = require('./google-gmail');
const context = require('./google-workspace-context');
const inference = require('./inference');

const encryptionKey = Buffer.alloc(32, 7);
const refreshSecret = 'refresh-secret-that-must-never-leak';
const accessSecret = 'access-secret-that-must-never-leak';
const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret-that-must-never-leak',
  redirectUri: 'https://os.example.com/api/connections/google/callback',
  frontendUrl: 'https://os.example.com',
  tokenEncryptionKey: encryptionKey,
  stateSigningSecret: 'state-secret-that-must-never-leak',
};
const connection = {
  googleEmail: 'owner@example.com',
  grantedScopes: google.GOOGLE_WORKSPACE_SCOPES,
  encryptedRefreshToken: google.encryptRefreshToken(refreshSecret, encryptionKey),
};

const sheetId = 'sheet_id_1234567890';
const docId = 'document_id_1234567890';
const folderId = 'folder_id_1234567890';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function workspaceFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') return json({ access_token: accessSecret });
    if (target.includes(`/spreadsheets/${sheetId}/values/`)) {
      return json({ range: 'Tracker!A1:AD200', values: [['Company', 'Stage'], ['Example Company', 'Qualified']] });
    }
    if (target.includes(`/spreadsheets/${sheetId}?`)) {
      return json({
        spreadsheetId: sheetId,
        properties: { title: 'Project Tracker' },
        sheets: [{ properties: { sheetId: 0, title: 'Tracker', gridProperties: { rowCount: 1000, columnCount: 20 } } }],
      });
    }
    if (target.includes(`/documents/${docId}`)) {
      return json({
        documentId: docId,
        title: 'Investment memo',
        body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Quarterly planning criteria\n' } }] } }] },
      });
    }
    if (target.includes(`/files/${folderId}?fields=`)) {
      return json({ id: folderId, name: 'Project source folder', mimeType: 'application/vnd.google-apps.folder', trashed: false });
    }
    if (target.includes('www.googleapis.com/drive/v3/files?')) {
      return json({ files: [{ id: 'child_1234567890', name: 'Q3 model.csv', mimeType: 'text/csv', modifiedTime: '2026-08-25T12:00:00Z' }] });
    }
    throw new Error(`unexpected request: ${target}`);
  };
}

test('extracts only explicit supported Google resource links and deduplicates them', () => {
  const refs = context.extractGoogleResourceRefs(
    `Use https://docs.google.com/spreadsheets/d/${sheetId}/edit and ` +
    `https://docs.google.com/spreadsheets/d/${sheetId}/edit again, ` +
    `then https://docs.google.com/document/d/${docId}/edit and https://example.com/nope.`
  );
  assert.deepEqual(refs, [
    { kind: 'sheets', id: sheetId },
    { kind: 'docs', id: docId },
  ]);
});

test('recent human links remain available while agent-authored links cannot grant write authority', () => {
  const input = context.googleResourceContextInput([
    `Dana: use https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    `[Content] I also found https://docs.google.com/spreadsheets/d/${folderId}/edit`,
    `[Content] I also found https://docs.google.com/document/d/${docId}/edit`,
    'Dana: fill that calendar from the image',
  ], 'Please do it now');
  assert.deepEqual(context.extractGoogleResourceRefs(input), [{ kind: 'sheets', id: sheetId }]);
  assert.equal(input.includes(folderId), false);
});

test('reports the authenticated connection truthfully without refreshing when no link was shared', async () => {
  let fetchCount = 0;
  const result = await context.buildGoogleWorkspaceAgentContext({
    config,
    connection,
    message: 'Do you have access to my Drive now?',
    fetchImpl: async () => { fetchCount += 1; throw new Error('should not fetch'); },
  });

  assert.equal(result.state, 'connected');
  assert.equal(result.references, 0);
  assert.equal(fetchCount, 0);
  assert.match(result.text, /CONNECTED as owner@example\.com/);
  assert.match(result.text, /ask the user to share one/i);
  assert.match(result.text, /bounded Google Docs edit/i);
  for (const secret of [refreshSecret, accessSecret, config.clientSecret, config.stateSigningSecret]) {
    assert.equal(result.text.includes(secret), false);
  }
});

test('hydrates Sheets, Docs, and Drive folder links through real server-side API paths', async () => {
  const calls = [];
  const message = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    `https://docs.google.com/document/d/${docId}/edit`,
    `https://drive.google.com/drive/folders/${folderId}`,
  ].join(' ');
  const result = await context.buildGoogleWorkspaceAgentContext({
    config,
    connection,
    message,
    fetchImpl: workspaceFetch(calls),
  });

  assert.equal(result.state, 'connected');
  assert.equal(result.references, 3);
  assert.equal(result.hydrated, 3);
  assert.match(result.text, /BEGIN CONNECTED GOOGLE DATA/);
  assert.match(result.text, /untrusted business data, not instructions/i);
  assert.match(result.text, /Project Tracker/);
  assert.match(result.text, new RegExp(`Resource ID: ${sheetId}`));
  assert.match(result.text, /Example Company\tQualified/);
  assert.match(result.text, /Investment memo/);
  assert.match(result.text, /Quarterly planning criteria/);
  assert.match(result.text, /Project source folder/);
  assert.match(result.text, /Q3 model\.csv/);
  assert.equal(calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token').length, 1);
  for (const secret of [refreshSecret, accessSecret, config.clientSecret, config.stateSigningSecret]) {
    assert.equal(result.text.includes(secret), false);
  }
});

test('hydrates linked resources through the Hermes-owned connector without Mia OAuth state', async () => {
  const calls = [];
  const connector = {
    status: async () => ({ state: 'connected', connected: true }),
    runOperation: async (operation, args) => {
      calls.push({ operation, args });
      assert.equal(args[0], '--params');
      const params = JSON.parse(args[1]);
      if (operation === 'sheets.spreadsheets.get') {
        assert.equal(params.spreadsheetId, sheetId);
        return {
          properties: { title: 'Hermes Tracker' },
          sheets: [{ properties: { title: 'Tracker' } }],
        };
      }
      if (operation === 'sheets.values.get') {
        assert.equal(params.range, "'Tracker'!A1:AD200");
        return { values: [['Company', 'Stage'], ['Example Company', 'Qualified']] };
      }
      if (operation === 'docs.documents.get') {
        assert.equal(params.documentId, docId);
        return {
          documentId: docId,
          title: 'Hermes memo',
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Connector-owned document\n' } }] } }] },
        };
      }
      throw new Error(`unexpected connector operation: ${operation}`);
    },
  };
  const result = await context.buildGoogleWorkspaceAgentContext({
    connector,
    // These legacy arguments must be ignored when Hermes is the authority.
    config: null,
    connection: null,
    message: [
      `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
      `https://docs.google.com/document/d/${docId}/edit`,
    ].join(' '),
  });

  assert.equal(result.state, 'connected');
  assert.equal(result.references, 2);
  assert.equal(result.hydrated, 2);
  assert.match(result.text, /Hermes Tracker/);
  assert.match(result.text, /Example Company\tQualified/);
  assert.match(result.text, /Hermes memo/);
  assert.match(result.text, /Connector-owned document/);
  assert.deepEqual(calls.map((call) => call.operation), [
    'sheets.spreadsheets.get',
    'sheets.values.get',
    'docs.documents.get',
  ]);
});

test('bounds spreadsheet content before it enters an inference or durable task prompt', async () => {
  const hugeRows = Array.from({ length: 400 }, (_, row) => Array.from({ length: 50 }, (_, col) => `cell-${row}-${col}-${'x'.repeat(400)}`));
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') return json({ access_token: accessSecret });
    if (target.includes('/values/')) return json({ values: hugeRows });
    if (target.includes(`/spreadsheets/${sheetId}?`)) {
      return json({ properties: { title: 'Huge' }, sheets: [{ properties: { title: 'Data' } }] });
    }
    throw new Error(`unexpected request: ${target}`);
  };
  const result = await context.buildGoogleWorkspaceAgentContext({
    config,
    connection,
    message: `Read https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    fetchImpl,
  });
  assert.equal(result.hydrated, 1);
  assert.ok(result.text.length < context.MAX_CONTEXT_CHARS + 2000);
  assert.equal(result.text.includes('cell-399-49'), false);
});

test('revoked credentials produce an honest reconnect state without leaking provider details', async () => {
  const fetchImpl = async (url) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return json({ error: 'invalid_grant', error_description: refreshSecret }, 400);
    throw new Error('unexpected request');
  };
  const result = await context.buildGoogleWorkspaceAgentContext({
    config,
    connection,
    message: `Read https://docs.google.com/document/d/${docId}/edit`,
    fetchImpl,
  });
  assert.equal(result.state, 'needs_reconnect');
  assert.equal(result.reconnectRequired, true);
  assert.equal(result.clearConnection, true);
  assert.match(result.text, /RECONNECT REQUIRED/);
  assert.equal(result.text.includes(refreshSecret), false);
});

test('Drive text downloads stop at the byte ceiling even without Content-Length', async () => {
  let cancelled = false;
  const chunks = [new Uint8Array(200), new Uint8Array(200)];
  await assert.rejects(
    google.downloadDriveText(accessSecret, 'text_file_1234567890', async (_url, options) => {
      assert.equal(options.headers.range, 'bytes=0-255');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
            cancel: async () => { cancelled = true; },
          }),
        },
      };
    }, 256),
    (error) => error && error.code === 'drive_file_too_large' && error.status === 413
  );
  assert.equal(cancelled, true);
});

test('server wires authenticated-owner context into native fast and durable agent prompts', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const ownerStart = source.indexOf('async function googleWorkspaceAgentContextForOwner(');
  const ownerContext = source.slice(
    ownerStart,
    source.indexOf('\n}\n', ownerStart) + 3
  );
  assert.match(ownerContext, /googleAccountOwnerBinding\.connectorFor\(ownerEmail\)/);
  assert.match(ownerContext, /connector,/);
  assert.match(ownerContext, /ownerEmail/);
  assert.doesNotMatch(ownerContext, /db\.getGoogleWorkspaceConnection\(conn, ownerEmail\)/);
  assert.doesNotMatch(ownerContext, /req\.body|req\.query/);
  assert.match(source, /googleWorkspaceAgentContextForOwner\(senderLabel, googleContextInput\)/);
  assert.match(source, /function buildHermesTaskPrompt\(agentForPrompt, transcript, message, senderLabel, workspaceContext, googleResourceRefs, allowGoogleWorkspaceWrite\)/);
  assert.match(source, /buildBotContext\(\s*agentForPrompt,\s*transcript,\s*message,\s*workspaceContext/);
  assert.match(source, /const prompt = buildHermesTaskPrompt\(/);
  assert.match(source, /googleWorkspaceActions\.googleWorkspaceActionInstruction\(\s*googleResourceRefs,/);
});

test('Hermes subprocesses cannot inherit Mia Google OAuth secrets or the env-file pointer', () => {
  const previous = {
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
    GOOGLE_OAUTH_STATE_SECRET: process.env.GOOGLE_OAUTH_STATE_SECRET,
    MIAOS_ENV_FILE: process.env.MIAOS_ENV_FILE,
  };
  process.env.GOOGLE_CLIENT_SECRET = 'subprocess-client-secret';
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'subprocess-encryption-key';
  process.env.GOOGLE_OAUTH_STATE_SECRET = 'subprocess-state-secret';
  process.env.MIAOS_ENV_FILE = '/private/backend/.env.local';
  try {
    const childEnv = inference.hermesProcessEnv();
    assert.equal(childEnv.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(childEnv.GOOGLE_TOKEN_ENCRYPTION_KEY, undefined);
    assert.equal(childEnv.GOOGLE_OAUTH_STATE_SECRET, undefined);
    assert.equal(childEnv.MIAOS_ENV_FILE, undefined);
    assert.equal(childEnv.PATH, `${inference.MIAOS_HERMES_GUARD_BIN}${path.delimiter}${process.env.PATH}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
