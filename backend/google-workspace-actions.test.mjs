import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const google = require('./google-gmail');
const actions = require('./google-workspace-actions');

const sheetId = 'sheet_id_1234567890';
const otherSheetId = 'other_sheet_1234567890';
const docId = 'document_id_1234567890';
const otherDocId = 'other_document_1234567890';
const refs = [{ kind: 'sheets', id: sheetId }];
const docRefs = [{ kind: 'docs', id: docId }];

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

test('Docs writes require an explicit current-turn request and a linked document', () => {
  assert.equal(actions.explicitDocsWriteRequested('Please edit this document with the new paragraph.', docRefs), true);
  assert.equal(actions.explicitDocsWriteRequested('Please read this document and summarize it.', docRefs), false);
  assert.equal(actions.explicitDocsWriteRequested('Please delete this document.', docRefs), false);
  assert.equal(actions.explicitDocsWriteRequested('Please edit it.', docRefs), true);
  assert.equal(actions.explicitDocsWriteRequested('Please edit it.', [{ kind: 'docs', id: docId }, { kind: 'sheets', id: sheetId }]), false);
  assert.equal(actions.explicitDocsWriteRequested('Please edit this document.', []), false);
  assert.deepEqual(actions.googleWorkspaceWriteKinds('Please edit this document.', [
    { kind: 'docs', id: docId },
    { kind: 'sheets', id: sheetId },
  ]), ['docs']);
  assert.deepEqual(actions.googleWorkspaceWriteKinds('Please read this document.', docRefs), []);
});

test('Docs action instructions expose only the linked document and bounded non-destructive schema', () => {
  const instruction = actions.googleWorkspaceActionInstruction(docRefs, ['docs']);
  assert.match(instruction, /CONNECTED GOOGLE DOCS WRITE ACTION/);
  assert.match(instruction, new RegExp(`Allowed document IDs: ${docId}`));
  assert.match(instruction, /replaceAllText/);
  assert.match(instruction, /insertText/);
  assert.match(instruction, /Do not use deleteContentRange/);
  assert.doesNotMatch(instruction, /CONNECTED GOOGLE SHEETS WRITE ACTION/);
  assert.doesNotMatch(instruction, new RegExp(otherDocId));
});

test('Docs validation accepts bounded replacement and append requests only for the linked document', () => {
  const action = {
    type: actions.DOCS_ACTION_TYPE,
    documentId: docId,
    requests: [
      { replaceAllText: { containsText: { text: 'old title', matchCase: true }, replaceText: 'new title' } },
      { insertText: { endOfSegmentLocation: { segmentId: '' }, text: '\nClosing note.' } },
    ],
  };
  assert.deepEqual(actions.validateGoogleWorkspaceAction(action, docRefs), {
    type: actions.DOCS_ACTION_TYPE,
    documentId: docId,
    requests: [
      { replaceAllText: { containsText: { text: 'old title', matchCase: true }, replaceText: 'new title' } },
      { insertText: { endOfSegmentLocation: {}, text: '\nClosing note.' } },
    ],
  });
  assert.equal(actions.validateGoogleWorkspaceAction({ ...action, documentId: otherDocId }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({ ...action, documentId: sheetId }, [{ kind: 'sheets', id: sheetId }]), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: [{ replaceAllText: { containsText: { text: 'old', matchCase: true }, replaceText: '' } }],
  }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }],
  }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: [{ insertText: { location: { index: 1 }, text: 'not append-only' } }],
  }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: Array.from({ length: actions.MAX_DOC_BATCH_REQUESTS + 1 }, () => ({
      insertText: { endOfSegmentLocation: {}, text: 'x' },
    })),
  }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: [{
      insertText: { endOfSegmentLocation: {}, text: 'x'.repeat(actions.MAX_DOC_TEXT_CHARS + 1) },
    }],
  }, docRefs), null);
  assert.equal(actions.validateGoogleWorkspaceAction({
    ...action,
    requests: Array.from({ length: actions.MAX_DOC_BATCH_REQUESTS }, () => ({
      insertText: { endOfSegmentLocation: {}, text: 'x'.repeat(Math.floor(actions.MAX_DOC_TOTAL_CHARS / actions.MAX_DOC_BATCH_REQUESTS) + 1) },
    })),
  }, docRefs), null);
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

test('applies a validated Docs edit through the Hermes-owned connector with structured batchUpdate args', async () => {
  const calls = [];
  const connector = {
    status: async () => ({ state: 'connected', connected: true }),
    runOperation: async (operation, args) => {
      calls.push({ operation, args });
      assert.equal(operation, actions.DOCS_ACTION_TYPE);
      assert.deepEqual(args.slice(0, 1), ['--params']);
      assert.deepEqual(JSON.parse(args[1]), { documentId: docId });
      assert.deepEqual(JSON.parse(args[3]), {
        requests: [{
          replaceAllText: {
            containsText: { text: 'draft', matchCase: false },
            replaceText: 'final',
          },
        }],
      });
      return { replies: [{}] };
    },
  };
  const result = await actions.applyGoogleWorkspaceAction({
    action: {
      type: actions.DOCS_ACTION_TYPE,
      documentId: docId,
      requests: [{
        replaceAllText: {
          containsText: { text: 'draft', matchCase: false },
          replaceText: 'final',
        },
      }],
    },
    refs: docRefs,
    connector,
    config: null,
    connection: null,
  });
  assert.deepEqual(result, { documentId: docId, appliedRequests: 1 });
  assert.equal(calls.length, 1);
});

test('rejects an unlinked Docs ID before any connector status or provider operation', async () => {
  const calls = [];
  const connector = {
    status: async () => { calls.push('status'); return { state: 'connected', connected: true }; },
    runOperation: async () => { calls.push('runOperation'); return {}; },
  };
  await assert.rejects(
    actions.applyGoogleWorkspaceAction({
      action: {
        type: actions.DOCS_ACTION_TYPE,
        documentId: otherDocId,
        requests: [{ insertText: { endOfSegmentLocation: {}, text: 'nope' } }],
      },
      refs: docRefs,
      connector,
    }),
    { code: 'invalid_google_workspace_action' }
  );
  assert.deepEqual(calls, []);
});

test('does not call gws when the connected-account check fails for a valid Docs edit', async () => {
  let providerCalls = 0;
  const connector = {
    status: async () => ({ state: 'not_connected', connected: false }),
    runOperation: async () => { providerCalls += 1; return {}; },
  };
  await assert.rejects(
    actions.applyGoogleWorkspaceAction({
      action: {
        type: actions.DOCS_ACTION_TYPE,
        documentId: docId,
        requests: [{ insertText: { endOfSegmentLocation: {}, text: 'nope' } }],
      },
      refs: docRefs,
      connector,
    }),
    { code: 'google_workspace_reconnect_required' }
  );
  assert.equal(providerCalls, 0);
});

test('server binds actions to the authenticated owner and applies them before native conversation posting', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /googleWorkspaceContext\.googleResourceContextInput\(transcript, message\)/);
  assert.match(source, /googleWorkspaceAgentContextForOwner\(senderLabel, googleContextInput\)/);
  assert.match(source, /googleResourceRefs: safeGoogleRefs/);
  assert.match(source, /ownerEmail: senderLabel/);
  assert.match(source, /const ownerConnector = googleAccountOwnerBinding\.connectorFor\(ownerEmail\)/);
  assert.match(source, /googleWorkspaceActions\.explicitSheetWriteRequested\(message, googleResourceRefs\)/);
  assert.match(source, /googleWorkspaceActions\.explicitDocsWriteRequested\(message, googleResourceRefs\)/);
  assert.match(source, /const googleWorkspaceWriteKinds = googleWorkspaceActions\.googleWorkspaceWriteKinds\(message, googleResourceRefs\)/);
  assert.match(source, /googleWorkspaceWriteAuthorized = googleWorkspaceWriteRequested[\s\S]*googleWorkspaceWriteKinds\.length > 0[\s\S]*googleWorkspaceConnected/);
  assert.match(source, /googleWorkspaceActions\.extractGoogleWorkspaceAction\(rawResult\)/);
  assert.match(source, /googleWorkspaceActions\.applyGoogleWorkspaceAction\(/);
  assert.match(source, /googleWorkspaceWriteKinds,/);
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
