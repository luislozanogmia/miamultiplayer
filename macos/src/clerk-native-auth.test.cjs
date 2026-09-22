'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeClerkClient, NativeClerkAuthError } = require('./clerk-native-auth.cjs');

const ISSUER = 'https://clerk.example.com';
const REDIRECT = `miamultiplayer://auth/clerk?state=${'a'.repeat(64)}`;

function jwt(payload) {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded(payload)}.signature`;
}

function clientJwt(subject = 'client_fixture') {
  return jwt({ id: subject, rotating_token: 'rotating_fixture' });
}

function response(body, { status = 200, token } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function signedOutClient(overrides = {}) {
  return {
    object: 'client', id: 'client_fixture', sessions: [], sign_in: null, sign_up: null,
    last_active_session_id: null, ...overrides,
  };
}

function wrapped(resource, client, token) {
  return response({ response: resource, client }, { token });
}

function storage(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    async load() { calls.push(['load']); return value; },
    async save(next) { calls.push(['save', next]); value = next; },
    async clear() { calls.push(['clear']); value = null; },
    value: () => value,
  };
}

function mockFapi(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const body = Object.fromEntries(new URLSearchParams(init.body || ''));
    calls.push({ url: parsed, init, body });
    const key = `${init.method} ${parsed.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected route ${key}`);
    return typeof handler === 'function' ? handler({ url: parsed, init, body, calls }) : handler;
  };
  return { fetchImpl, calls };
}

function make(options = {}) {
  const secureStorage = options.storage || storage(options.clientJwt || null);
  const mock = mockFapi(options.routes || {});
  return {
    secureStorage,
    mock,
    auth: createNativeClerkClient({ issuer: ISSUER, storage: secureStorage, fetchImpl: mock.fetchImpl, timeoutMs: 500, now: () => 1000 }),
  };
}

test('Google uses native FAPI transport, rotates the bound client JWT, and returns only the external URL', async () => {
  const rotated = jwt({ id: 'client_fixture', rotating_token: 'rotating_updated' });
  const signIn = {
    object: 'sign_in_attempt', id: 'sia_google', status: 'needs_first_factor',
    first_factor_verification: { status: 'unverified', external_verification_redirect_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture' },
  };
  const current = signedOutClient({ sign_in: signIn });
  const { auth, mock, secureStorage } = make({
    clientJwt: clientJwt(),
    routes: { 'POST /v1/client/sign_ins': wrapped(signIn, current, rotated) },
  });

  assert.deepEqual(await auth.startGoogle({ redirectUrl: REDIRECT }), { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture' });
  const call = mock.calls[0];
  assert.equal(call.url.searchParams.get('_is_native'), '1');
  assert.equal(call.url.searchParams.get('__clerk_api_version'), '2026-05-12');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.headers.get('authorization'), `Bearer ${clientJwt()}`);
  assert.deepEqual(call.body, { strategy: 'oauth_google', redirect_url: REDIRECT });
  assert.equal(secureStorage.value(), rotated);
});

test('a first run creates a native client before reporting status', async () => {
  const created = signedOutClient();
  const rotated = clientJwt();
  const { auth, mock, secureStorage } = make({
    routes: { 'POST /v1/client': response({ response: created, client: created }, { token: rotated }) },
  });
  assert.deepEqual(await auth.status(), { status: 'signed_out' });
  assert.equal(mock.calls[0].init.method, 'POST');
  assert.equal(mock.calls[0].url.searchParams.get('_is_native'), '1');
  assert.equal(secureStorage.value(), rotated);
});

test('Google callback reloads the original attempt, transfers sign-up, and exposes an active session token', async () => {
  const pending = {
    object: 'sign_in_attempt', id: 'sia_google', status: 'needs_first_factor',
    first_factor_verification: { status: 'unverified', external_verification_redirect_url: `${ISSUER}/oauth/start` },
  };
  const transferred = { ...pending, first_factor_verification: { status: 'transferable' } };
  const activeSession = { object: 'session', id: 'sess_active', status: 'active', expire_at: 5000 };
  const activeClient = signedOutClient({ sessions: [activeSession], last_active_session_id: 'sess_active', sign_in: transferred });
  const signUp = { object: 'sign_up_attempt', id: 'sua_google', status: 'complete', missing_fields: [] };
  let getCount = 0;
  const { auth, mock } = make({
    clientJwt: clientJwt(),
    routes: {
      'POST /v1/client/sign_ins': wrapped(pending, signedOutClient({ sign_in: pending })),
      'GET /v1/client/sign_ins/sia_google': wrapped(transferred, signedOutClient({ sign_in: transferred })),
      'POST /v1/client/sign_ups': wrapped(signUp, activeClient),
      'GET /v1/client': () => response({ response: activeClient, client: activeClient }),
      'POST /v1/client/sessions/sess_active/tokens': () => response({ jwt: jwt({ iss: ISSUER, sub: 'user_1' }) }),
    },
  });
  await auth.startGoogle({ redirectUrl: REDIRECT });
  assert.deepEqual(await auth.completeGoogle({ nonce: 'nonce_fixture_123456' }), { status: 'active', sessionId: 'sess_active' });
  assert.equal(mock.calls[1].url.searchParams.get('rotating_token_nonce'), 'nonce_fixture_123456');
  assert.deepEqual(mock.calls[2].body, { transfer: 'true' });
  const token = await auth.getSessionToken();
  assert.equal(token.split('.').length, 3);
  assert.equal(getCount, 0);
});

test('callback nonce replay is rejected before FAPI', async () => {
  const signIn = { object: 'sign_in_attempt', id: 'sia_google', status: 'needs_first_factor', first_factor_verification: { status: 'unverified', external_verification_redirect_url: `${ISSUER}/oauth/start` } };
  const { auth, mock } = make({
    clientJwt: clientJwt(),
    routes: {
      'POST /v1/client/sign_ins': wrapped(signIn, signedOutClient({ sign_in: signIn })),
      'GET /v1/client/sign_ins/sia_google': wrapped(signIn, signedOutClient({ sign_in: signIn })),
    },
  });
  await auth.startGoogle({ redirectUrl: REDIRECT });
  await auth.completeGoogle({ nonce: 'nonce_fixture_123456' });
  await assert.rejects(auth.completeGoogle({ nonce: 'nonce_fixture_123456' }), error => error.code === 'CALLBACK_REPLAYED');
  assert.equal(mock.calls.length, 2);
});

test('email verification preserves pending and MFA states and never reports them active', async () => {
  const created = {
    object: 'sign_in_attempt', id: 'sia_email', status: 'needs_first_factor', first_factor_verification: null,
    supported_first_factors: [{ strategy: 'email_code', email_address_id: 'idn_email_opaque' }],
  };
  const pending = { ...created, first_factor_verification: { status: 'unverified', strategy: 'email_code' } };
  const mfa = { ...pending, status: 'needs_second_factor', first_factor_verification: { status: 'verified' } };
  const { auth, mock } = make({
    clientJwt: clientJwt(),
    routes: {
      'POST /v1/client/sign_ins': wrapped(created, signedOutClient({ sign_in: created })),
      'POST /v1/client/sign_ins/sia_email/prepare_first_factor': wrapped(pending, signedOutClient({ sign_in: pending })),
      'POST /v1/client/sign_ins/sia_email/attempt_first_factor': wrapped(mfa, signedOutClient({ sign_in: mfa })),
    },
  });
  assert.deepEqual(await auth.startEmail('Person@Example.com'), { status: 'needs_verification', attemptId: 'sia_email' });
  assert.deepEqual(mock.calls[0].body, { identifier: 'person@example.com' });
  assert.deepEqual(mock.calls[1].body, { strategy: 'email_code', email_address_id: 'idn_email_opaque' });
  assert.deepEqual(await auth.verifyEmail('123456'), { status: 'needs_second_factor', attemptId: 'sia_email' });
});

test('email sign-in fails closed when the instance does not offer an email-code factor', async () => {
  const created = {
    object: 'sign_in_attempt', id: 'sia_email', status: 'needs_first_factor', first_factor_verification: null,
    supported_first_factors: [{ strategy: 'password' }],
  };
  const { auth, mock } = make({
    clientJwt: clientJwt(),
    routes: { 'POST /v1/client/sign_ins': wrapped(created, signedOutClient({ sign_in: created })) },
  });
  await assert.rejects(auth.startEmail('person@example.com'), error => error.code === 'EMAIL_CODE_UNAVAILABLE');
  assert.equal(mock.calls.length, 1);
});

test('expired sessions do not mint a session token', async () => {
  const expired = signedOutClient({
    sessions: [{ object: 'session', id: 'sess_expired', status: 'active', expire_at: 999 }],
    last_active_session_id: 'sess_expired',
  });
  const { auth, mock } = make({ clientJwt: clientJwt(), routes: { 'GET /v1/client': response({ response: expired, client: expired }) } });
  assert.equal(await auth.getSessionToken(), null);
  assert.equal(mock.calls.length, 1);
});

test('logout calls FAPI, clears secure storage, and returns signed_out', async () => {
  const { auth, secureStorage } = make({
    clientJwt: clientJwt(),
    routes: { 'DELETE /v1/client/sessions': response({ response: signedOutClient(), client: null }) },
  });
  assert.deepEqual(await auth.signOut(), { status: 'signed_out' });
  assert.equal(secureStorage.value(), null);
});

test('logout clears the local credential even when remote revocation fails', async () => {
  const secureStorage = storage(clientJwt());
  const { auth } = make({
    storage: secureStorage,
    routes: { 'DELETE /v1/client/sessions': response({ errors: [] }, { status: 503 }) },
  });
  await assert.rejects(auth.signOut(), error => error.code === 'AUTH_REQUEST_FAILED' && error.retryable);
  assert.equal(secureStorage.value(), null);
});

test('rejects a rotated token for a different client without persisting it', async () => {
  const bad = jwt({ id: 'client_bad', rotating_token: 'attacker_rotation' });
  const secureStorage = storage(clientJwt());
  const client = signedOutClient();
  const { auth } = make({ storage: secureStorage, routes: { 'GET /v1/client': response({ response: client, client }, { token: bad }) } });
  await assert.rejects(auth.status(), error => error.code === 'INVALID_SERVER_RESPONSE');
  assert.equal(secureStorage.value(), clientJwt());
});

test('maps FAPI failures to safe errors without exposing response details', async () => {
  const { auth } = make({
    clientJwt: clientJwt(),
    routes: { 'GET /v1/client': response({ errors: [{ message: 'sensitive upstream detail' }] }, { status: 429 }) },
  });
  await assert.rejects(auth.status(), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
});

test('storage/keyring failures are safe and never fall back to plaintext', async () => {
  const broken = { async load() { throw new Error('keychain locked'); }, async save() {}, async clear() {} };
  const mock = mockFapi({});
  const auth = createNativeClerkClient({ issuer: ISSUER, storage: broken, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.status(), error => error instanceof NativeClerkAuthError && error.code === 'SECURE_STORAGE_UNAVAILABLE');
  assert.equal(mock.calls.length, 0);
});

test('a transient keyring load failure can be retried', async () => {
  let loads = 0;
  const retryingStorage = {
    async load() { if (++loads === 1) throw new Error('temporarily locked'); return null; },
    async save() {},
    async clear() {},
  };
  const created = signedOutClient();
  const mock = mockFapi({
    'POST /v1/client': response({ response: created, client: created }, { token: clientJwt() }),
  });
  const auth = createNativeClerkClient({ issuer: ISSUER, storage: retryingStorage, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.status(), error => error.code === 'SECURE_STORAGE_UNAVAILABLE');
  assert.deepEqual(await auth.status(), { status: 'signed_out' });
  assert.equal(loads, 2);
});

test('rejects redirect tampering and unsafe callback values locally', async () => {
  const { auth, mock } = make();
  await assert.rejects(auth.startGoogle({ redirectUrl: `miamultiplayer://auth/clerk?state=${'A'.repeat(64)}` }), error => error.code === 'INVALID_REDIRECT_URL');
  await assert.rejects(auth.startGoogle({ redirectUrl: `${REDIRECT}&extra=1` }), error => error.code === 'INVALID_REDIRECT_URL');
  await assert.rejects(auth.completeGoogle({ nonce: 'short' }), error => error.code === 'INVALID_CALLBACK');
  assert.equal(mock.calls.length, 0);
});

test('concurrent operations fail closed and cancel aborts the in-flight request', async () => {
  let resolveFetch;
  const deferred = new Promise(resolve => { resolveFetch = resolve; });
  const secureStorage = storage(clientJwt());
  const auth = createNativeClerkClient({ issuer: ISSUER, storage: secureStorage, fetchImpl: () => deferred, timeoutMs: 1000 });
  const pending = auth.status();
  await assert.rejects(auth.status(), error => error.code === 'AUTH_BUSY');
  assert.deepEqual(auth.cancel(), { status: 'signed_out' });
  resolveFetch(response({ response: signedOutClient(), client: signedOutClient() }));
  await assert.rejects(pending, error => error.code === 'CANCELLED');
});
