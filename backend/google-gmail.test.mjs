import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const google = require('./google-gmail.js');
const db = require('./db.js');

const SECRET = 'state-secret-for-tests-only';
const KEY = Buffer.alloc(32, 7);
const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:4870/api/connections/google/callback',
  frontendUrl: 'http://127.0.0.1:4930',
  tokenEncryptionKey: KEY,
  stateSigningSecret: SECRET,
};

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('OAuth state is signed, expiring, and tamper resistant', () => {
  const now = 1_700_000_000_000;
  const state = google.createOAuthState(SECRET, now, 'a'.repeat(48));
  assert.deepEqual(google.verifyOAuthState(state.value, SECRET, now), { nonce: state.nonce, issuedAt: now });
  assert.equal(google.verifyOAuthState(state.value, 'wrong-secret', now), null);
  assert.equal(google.verifyOAuthState(`${state.value}x`, SECRET, now), null);
  assert.equal(google.verifyOAuthState(state.value, SECRET, now + google.OAUTH_STATE_MAX_AGE_MS + 1), null);
});

test('refresh tokens are encrypted and authenticated at rest', () => {
  const envelope = google.encryptRefreshToken('refresh-token-for-test', KEY);
  assert.equal(envelope.includes('refresh-token-for-test'), false);
  assert.equal(google.decryptRefreshToken(envelope, KEY), 'refresh-token-for-test');
  assert.throws(() => google.decryptRefreshToken(`${envelope}x`, KEY));
});

test('authorization URL requests the four Workspace scopes with offline consent and keeps Gmail read-only', () => {
  const state = google.createOAuthState(SECRET, Date.now(), 'b'.repeat(48));
  const url = new URL(google.buildAuthorizationUrl(CONFIG, state.value));
  assert.deepEqual(url.searchParams.get('scope').split(' '), google.GOOGLE_WORKSPACE_SCOPES);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal(google.hasRequiredScopes(google.GOOGLE_WORKSPACE_SCOPES), true);
  assert.equal(google.hasRequiredScopes([google.GMAIL_READONLY_SCOPE]), false);
  assert.equal(google.serviceSupportsWrite('gmail'), false);
  assert.equal(google.serviceSupportsWrite('drive'), true);
  assert.deepEqual(google.serviceAccess(google.GOOGLE_WORKSPACE_SCOPES), {
    gmail: true,
    drive: true,
    sheets: true,
    docs: true,
  });
});

test('Google token and Workspace read/write test requests stay server-side and clean temporary artifacts', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://oauth2.googleapis.com/token' && String(options.body).includes('grant_type=authorization_code')) {
      return fakeResponse({ access_token: 'access-token', refresh_token: 'refresh-token', scope: google.GOOGLE_WORKSPACE_SCOPES.join(' ') });
    }
    if (String(url) === 'https://oauth2.googleapis.com/token') return fakeResponse({ access_token: 'refreshed-access-token' });
    if (String(url).endsWith('/profile')) return fakeResponse({ emailAddress: 'alice@example.com' });
    if (String(url).includes('/messages?maxResults=1')) return fakeResponse({ messages: [{ id: 'opaque-id-only' }] });
    if (String(url).includes('/drive/v3/files?pageSize=')) return fakeResponse({ files: [] });
    if (String(url).endsWith('/drive/v3/files?fields=id,name,mimeType') && options.method === 'POST') {
      return fakeResponse({ id: 'drive-test-id', name: 'test', mimeType: 'application/vnd.google-apps.folder' });
    }
    if (String(url).includes('/drive/v3/files/') && options.method === 'PATCH') return fakeResponse({ id: 'trashed-id', trashed: true });
    if (String(url).endsWith('/v4/spreadsheets') && options.method === 'POST') return fakeResponse({ spreadsheetId: 'sheet-test-id' });
    if (String(url).includes('/v4/spreadsheets/sheet-test-id/values/') && options.method === 'PUT') return fakeResponse({ updatedCells: 1 });
    if (String(url).includes('/v4/spreadsheets/sheet-test-id/values/') && options.method === 'GET') return fakeResponse({ values: [['unit-marker']] });
    if (String(url).endsWith('/v1/documents') && options.method === 'POST') return fakeResponse({ documentId: 'doc-test-id' });
    if (String(url).endsWith('/v1/documents/doc-test-id:batchUpdate') && options.method === 'POST') return fakeResponse({ documentId: 'doc-test-id' });
    if (String(url).endsWith('/v1/documents/doc-test-id') && options.method === 'GET') {
      return fakeResponse({ documentId: 'doc-test-id', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'unit-marker' } }] } }] } });
    }
    if (String(url) === 'https://oauth2.googleapis.com/revoke') return fakeResponse({}, 200);
    throw new Error(`unexpected test URL: ${options.method || 'GET'} ${url}`);
  };

  const exchanged = await google.exchangeAuthorizationCode('authorization-code', CONFIG, fetchImpl);
  assert.equal(exchanged.refresh_token, 'refresh-token');
  const accessToken = await google.refreshAccessToken(exchanged.refresh_token, CONFIG, fetchImpl);
  const profile = await google.fetchGmailProfile(accessToken, fetchImpl);
  const messages = await google.listGmailMessages(accessToken, fetchImpl);
  assert.equal(profile.emailAddress, 'alice@example.com');
  assert.equal(messages.messages.length, 1);
  for (const service of Object.keys(google.GOOGLE_SERVICE_SCOPES)) {
    const result = await google.testGoogleService(service, accessToken, fetchImpl, 'unit-marker');
    assert.equal(result.readVerified, true, `${service} read check`);
    assert.equal(result.writeVerified, service !== 'gmail', `${service} write check`);
    assert.equal(result.cleanupOk, true, `${service} cleanup check`);
  }
  assert.equal(await google.revokeGoogleToken(exchanged.refresh_token, fetchImpl), true);
  assert.match(String(calls.find((call) => call.url.endsWith('/messages?maxResults=1')).url), /maxResults=1$/);
  assert.equal(calls.some((call) => String(call.options.body || '').includes('access-token')), false);
  assert.equal(calls.every((call) => !call.options.headers || call.options.headers.authorization === undefined || call.options.headers.authorization === 'Bearer refreshed-access-token'), true);
  assert.equal(calls.some((call) => call.url.includes('/gmail/v1/users/me/drafts')), false);
  assert.equal(calls.filter((call) => call.options.method === 'PATCH' && call.url.includes('/drive/v3/files/')).length, 3);
});

test('Workspace connection rows and OAuth states are scoped by owner email', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mia-os-gmail-'));
  const connection = db.openDb(join(root, 'test.sqlite'), '');
  try {
    const now = new Date().toISOString();
    const state = google.createOAuthState(SECRET, Date.now(), 'c'.repeat(48));
    db.createGoogleOAuthState(connection, {
      nonce: state.nonce,
      ownerEmail: 'Alice@Example.com',
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
    });
    assert.equal(db.consumeGoogleOAuthState(connection, state.nonce, now).ownerEmail, 'alice@example.com');
    assert.equal(db.consumeGoogleOAuthState(connection, state.nonce, now), null);

    db.saveGoogleGmailConnection(connection, {
      ownerEmail: 'Alice@Example.com',
      googleEmail: 'alice@example.com',
      grantedScopes: google.GOOGLE_WORKSPACE_SCOPES,
      encryptedRefreshToken: 'v1.encrypted.test',
      connectedAt: now,
      updatedAt: now,
    });
    assert.equal(db.getGoogleGmailConnection(connection, 'other@example.com'), null);
    assert.equal(db.getGoogleGmailConnection(connection, 'alice@example.com').googleEmail, 'alice@example.com');
    assert.equal(db.getGoogleWorkspaceConnection(connection, 'alice@example.com').grantedScopes.length, 4);
    assert.equal(db.deleteGoogleGmailConnection(connection, 'other@example.com'), false);
    assert.equal(db.deleteGoogleGmailConnection(connection, 'alice@example.com'), true);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Google token refresh fails closed instead of hanging on a stalled provider request', async () => {
  await assert.rejects(
    google.refreshAccessToken('refresh-token', CONFIG, async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        );
      }), 10),
    (error) => error && error.code === 'google_request_timeout' && error.status === 504
  );
});
