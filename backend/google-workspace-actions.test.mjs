import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const google = require('./google-gmail');
const actions = require('./google-workspace-actions');

const sheetId = 'sheet_id_1234567890';
const otherSheetId = 'other_sheet_1234567890';
const refs = [{ kind: 'sheets', id: sheetId }];

test('extracts one private Sheets action and preserves only the user-facing report', () => {
  const raw = [
    'I updated the seven-day Content Engine calendar.',
    `${actions.ACTION_OPEN}{"type":"sheets.values.update","spreadsheetId":"${sheetId}","range":"Sheet1!A1:B2","values":[["Day","Topic"],["Monday","Authority"]]}${actions.ACTION_CLOSE}`,
  ].join('\n');
  const extracted = actions.extractGoogleWorkspaceAction(raw);
  assert.equal(extracted.error, null);
  assert.equal(extracted.text, 'I updated the seven-day Content Engine calendar.');
  assert.equal(extracted.text.includes('MIA_GOOGLE_ACTION'), false);
  assert.deepEqual(actions.validateGoogleWorkspaceAction(extracted.action, refs), {
    type: 'sheets.values.update',
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:B2',
    values: [['Day', 'Topic'], ['Monday', 'Authority']],
  });
});

test('malformed private actions are removed completely instead of leaking to chat', () => {
  const raw = `Visible report\n${actions.ACTION_OPEN}{"type":"sheets.values.update","spreadsheetId":"${sheetId}"`;
  const extracted = actions.extractGoogleWorkspaceAction(raw);
  assert.equal(extracted.error, 'malformed_action');
  assert.equal(extracted.text, 'Visible report');
  assert.equal(extracted.text.includes(sheetId), false);

  const mixed = actions.extractGoogleWorkspaceAction(
    `Visible\n${actions.ACTION_OPEN}{"type":"sheets.values.update","spreadsheetId":"${sheetId}","range":"Sheet1!A1","values":[["ok"]]}${actions.ACTION_CLOSE}\n${actions.ACTION_OPEN}{"type":"second"`
  );
  assert.equal(mixed.error, 'malformed_action');
  assert.equal(mixed.text, 'Visible');
});

test('validation rejects another spreadsheet, unsafe ranges, and oversized data', () => {
  assert.equal(actions.validateGoogleWorkspaceAction({
    type: 'sheets.values.update', spreadsheetId: otherSheetId, range: 'Sheet1!A1', values: [['no']],
  }, refs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    type: 'sheets.values.update', spreadsheetId: sheetId, range: 'Sheet1', values: [['no']],
  }, refs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    type: 'sheets.values.update', spreadsheetId: sheetId, range: 'Sheet1!A1',
    values: Array.from({ length: actions.MAX_ROWS + 1 }, () => ['no']),
  }, refs), null);
});

test('validation safely preserves a blank spacer row in a bounded calendar layout', () => {
  const values = [
    ['Day', 'Pillar', 'Format', 'Topic', 'Hook', 'CTA', 'Status'],
    ['Monday', 'Authority', 'Post', 'Example', 'Lead', 'Read', 'Draft'],
    [],
    ['Outcome', 'Build trust'],
  ];
  assert.deepEqual(actions.validateGoogleWorkspaceAction({
    type: 'sheets.values.update',
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:G4',
    values,
  }, refs), {
    type: 'sheets.values.update',
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:G4',
    values: [
      ['Day', 'Pillar', 'Format', 'Topic', 'Hook', 'CTA', 'Status'],
      ['Monday', 'Authority', 'Post', 'Example', 'Lead', 'Read', 'Draft'],
      [''],
      ['Outcome', 'Build trust'],
    ],
  });
});

test('sheet writes require an explicit current-turn request and a linked sheet', () => {
  assert.equal(actions.explicitSheetWriteRequested('Please update this sheet with the new rows.', refs), true);
  assert.equal(actions.explicitSheetWriteRequested('Please read this sheet and summarize it.', refs), false);
  assert.equal(actions.explicitSheetWriteRequested("Don't update this sheet yet.", refs), false);
  assert.equal(actions.explicitSheetWriteRequested('Please update it with the new rows.', []), false);
});

test('applies a validated action through server-owned OAuth without returning credentials', async () => {
  const key = Buffer.alloc(32, 4);
  const refreshSecret = 'refresh-secret-never-in-results';
  const accessSecret = 'access-secret-never-in-results';
  const config = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://os.example.com/api/connections/google/callback',
    frontendUrl: 'https://os.example.com',
    tokenEncryptionKey: key,
    stateSigningSecret: 'state-secret',
  };
  const connection = {
    grantedScopes: google.GOOGLE_WORKSPACE_SCOPES,
    encryptedRefreshToken: google.encryptRefreshToken(refreshSecret, key),
  };
  const calls = [];
  const result = await actions.applyGoogleWorkspaceAction({
    action: {
      type: 'sheets.values.update',
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:B2',
      values: [['Day', 'Topic'], ['Monday', 'Authority']],
    },
    refs,
    config,
    connection,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: accessSecret }), { status: 200 });
      }
      assert.match(String(url), new RegExp(`/spreadsheets/${sheetId}/values/Sheet1!A1%3AB2`));
      assert.equal(options.headers.authorization, `Bearer ${accessSecret}`);
      assert.deepEqual(JSON.parse(options.body), {
        range: 'Sheet1!A1:B2',
        majorDimension: 'ROWS',
        values: [['Day', 'Topic'], ['Monday', 'Authority']],
      });
      return new Response(JSON.stringify({ updatedCells: 4 }), { status: 200 });
    },
  });
  assert.deepEqual(result, { spreadsheetId: sheetId, range: 'Sheet1!A1:B2', updatedCells: 4 });
  assert.equal(JSON.stringify(result).includes(refreshSecret), false);
  assert.equal(JSON.stringify(result).includes(accessSecret), false);
  assert.equal(calls.length, 2);
});

test('applies a validated action through the Hermes-owned connector without Mia OAuth state', async () => {
  const calls = [];
  const connector = {
    status: async () => ({ state: 'connected', connected: true }),
    runOperation: async (operation, args) => {
      calls.push({ operation, args });
      assert.equal(operation, 'sheets.values.update');
      assert.deepEqual(args.slice(0, 1), ['--params']);
      const params = JSON.parse(args[1]);
      const body = JSON.parse(args[3]);
      assert.deepEqual(params, {
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:B2',
        valueInputOption: 'RAW',
      });
      assert.deepEqual(body, {
        range: 'Sheet1!A1:B2',
        majorDimension: 'ROWS',
        values: [['Day', 'Topic'], ['Monday', 'Authority']],
      });
      return { updatedCells: 4 };
    },
  };
  const result = await actions.applyGoogleWorkspaceAction({
    action: {
      type: 'sheets.values.update',
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:B2',
      values: [['Day', 'Topic'], ['Monday', 'Authority']],
    },
    refs,
    connector,
    // These legacy arguments must be ignored when Hermes is the authority.
    config: null,
    connection: null,
  });
  assert.deepEqual(result, { spreadsheetId: sheetId, range: 'Sheet1!A1:B2', updatedCells: 4 });
  assert.equal(calls.length, 1);
});

test('server binds actions to the authenticated owner and applies them before native conversation posting', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /googleWorkspaceContext\.googleResourceContextInput\(transcript, message\)/);
  assert.match(source, /googleWorkspaceAgentContextForOwner\(senderLabel, googleContextInput\)/);
  assert.match(source, /googleResourceRefs: safeGoogleRefs/);
  assert.match(source, /ownerEmail: senderLabel/);
  assert.match(source, /const ownerConnector = googleAccountOwnerBinding\.connectorFor\(ownerEmail\)/);
  assert.match(source, /googleWorkspaceActions\.explicitSheetWriteRequested\(message, googleResourceRefs\)/);
  assert.match(source, /googleWorkspaceWriteAuthorized = googleWorkspaceWriteRequested && googleWorkspaceConnected/);
  assert.match(source, /googleWorkspaceActions\.extractGoogleWorkspaceAction\(rawResult\)/);
  assert.match(source, /googleWorkspaceActions\.applyGoogleWorkspaceAction\(/);
  assert.match(source, /deletionGuardedGoogleConnector\(ownerConnector, dispatch, trigger, signal\)/);
  assert.match(source, /connector: guardedConnector/);
  assert.match(source, /throwIfNativeGoogleActionStopped\(dispatch, trigger, signal\)/);
  assert.match(
    source,
    /function createNativeDispatchEvent\(dispatch, trigger, input\) \{\s*throwIfNativeDispatchUserInactive\(dispatch, trigger\);\s*return nativeConversationService\.createEvent\(input\);\s*\}/
  );
  const actionIndex = source.indexOf('const actionReply = await applyNativeGoogleWorkspaceAction(');
  const finalEventIndex = source.indexOf('const result = await createNativeDispatchReplyEvent(dispatch, trigger, {', actionIndex);
  assert.ok(actionIndex >= 0, 'native action application is present');
  assert.ok(finalEventIndex > actionIndex, 'native action is applied before final event persistence');
});
