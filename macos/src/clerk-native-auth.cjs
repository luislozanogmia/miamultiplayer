'use strict';
const { validClerkNonce } = require('./clerk-nonce.cjs');

const DEFAULT_API_VERSION = '2026-05-12';
const DEFAULT_TIMEOUT_MS = 10_000;
const REDIRECT_SCHEME = 'miamultiplayer:';
const REDIRECT_HOST = 'auth';
const REDIRECT_PATH = '/clerk';
const ID_PATTERNS = Object.freeze({
  client: /^client_[A-Za-z0-9_-]+$/,
  signIn: /^sia_[A-Za-z0-9_-]+$/,
  signUp: /^sua_[A-Za-z0-9_-]+$/,
  session: /^sess_[A-Za-z0-9_-]+$/,
});

class NativeClerkAuthError extends Error {
  constructor(code, { httpStatus, retryable = false } = {}) {
    super(code);
    this.name = 'NativeClerkAuthError';
    this.code = code;
    if (Number.isInteger(httpStatus)) this.httpStatus = httpStatus;
    this.retryable = Boolean(retryable);
  }
}

function safeError(code, options) {
  return new NativeClerkAuthError(code, options);
}

function exactIssuer(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) {
    throw safeError('INVALID_CONFIGURATION');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || url.origin !== String(value).replace(/\/$/, '')) {
    throw safeError('INVALID_CONFIGURATION');
  }
  return url.origin;
}

function validateStorage(storage) {
  if (!storage || ['load', 'save', 'clear'].some((name) => typeof storage[name] !== 'function')) {
    throw safeError('INVALID_CONFIGURATION');
  }
  return storage;
}

function decodeJwtPayload(token) {
  const pieces = String(token || '').split('.');
  if (pieces.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function boundClientJwt(token, expectedClientId) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.id !== 'string' || !ID_PATTERNS.client.test(payload.id)
    || typeof payload.rotating_token !== 'string' || !payload.rotating_token
    || (expectedClientId && payload.id !== expectedClientId)) return null;
  return { token: String(token), clientId: payload.id };
}

function responseHeader(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
  return String(response.headers.get(name) || '').trim();
}

function clientJwtFromResponse(response) {
  const value = responseHeader(response, 'authorization');
  return value.replace(/^Bearer\s+/i, '').trim();
}

function assertId(value, kind) {
  const id = String(value || '');
  if (!ID_PATTERNS[kind] || !ID_PATTERNS[kind].test(id)) throw safeError('INVALID_SERVER_RESPONSE');
  return id;
}

function googleRedirect(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) {
    throw safeError('INVALID_REDIRECT_URL');
  }
  const stateValues = url.searchParams.getAll('state');
  if (url.protocol !== REDIRECT_SCHEME || url.hostname !== REDIRECT_HOST || url.pathname !== REDIRECT_PATH
    || url.username || url.password || url.hash || url.searchParams.size !== 1
    || stateValues.length !== 1 || !/^[a-f0-9]{64}$/.test(stateValues[0])) {
    throw safeError('INVALID_REDIRECT_URL');
  }
  return url.toString();
}

function externalGoogleUrl(value, issuer) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) {
    throw safeError('INVALID_SERVER_RESPONSE');
  }
  const allowedOrigin = url.origin === issuer || url.origin === 'https://accounts.google.com';
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || !allowedOrigin) {
    throw safeError('INVALID_SERVER_RESPONSE');
  }
  return url.toString();
}

function form(values) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null) result.set(key, String(value));
  }
  return result;
}

function unwrapClient(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.client && payload.client.object === 'client') return payload.client;
  if (payload.response && payload.response.object === 'client') return payload.response;
  return null;
}

function unwrapResponse(payload, expectedObject) {
  const response = payload && payload.response;
  if (!response || response.object !== expectedObject) throw safeError('INVALID_SERVER_RESPONSE');
  return response;
}

function publicStatus(client, now) {
  const sessions = Array.isArray(client && client.sessions) ? client.sessions : [];
  const preferred = String(client && client.last_active_session_id || '');
  const active = sessions.find((session) => session && session.id === preferred && session.status === 'active')
    || sessions.find((session) => session && session.status === 'active');
  if (active) {
    assertId(active.id, 'session');
    if (Number.isFinite(active.expire_at) && active.expire_at <= now()) return { status: 'signed_out' };
    return { status: 'active', sessionId: active.id };
  }

  const signIn = client && client.sign_in;
  if (signIn && signIn.id) {
    assertId(signIn.id, 'signIn');
    if (signIn.status === 'needs_second_factor' || signIn.status === 'needs_client_trust') {
      return { status: 'needs_second_factor', attemptId: signIn.id };
    }
    if (['needs_identifier', 'needs_first_factor', 'needs_new_password', 'needs_protect_check'].includes(signIn.status)) {
      return { status: 'needs_verification', attemptId: signIn.id };
    }
  }

  const signUp = client && client.sign_up;
  if (signUp && signUp.id && signUp.status !== 'abandoned') {
    assertId(signUp.id, 'signUp');
    const result = { status: 'needs_sign_up', attemptId: signUp.id };
    if (Array.isArray(signUp.missing_fields)) result.missingFields = signUp.missing_fields.filter(v => typeof v === 'string');
    return result;
  }
  return { status: 'signed_out' };
}

function createNativeClerkClient(options = {}) {
  const issuer = exactIssuer(options.issuer);
  const storage = validateStorage(options.storage);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw safeError('INVALID_CONFIGURATION');
  const apiVersion = String(options.apiVersion || DEFAULT_API_VERSION);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) throw safeError('INVALID_CONFIGURATION');
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) throw safeError('INVALID_CONFIGURATION');
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let clientJwt = null;
  let clientJwtClientId = null;
  let client = null;
  let loadedStorage = false;
  let activeOperation = null;
  let operationEpoch = 0;
  let googleSignInId = null;
  let emailSignInId = null;
  const usedNonces = new Set();

  async function storageCall(method, value) {
    try {
      return value === undefined ? await storage[method]() : await storage[method](value);
    } catch (_) {
      throw safeError('SECURE_STORAGE_UNAVAILABLE');
    }
  }

  async function loadStoredJwt() {
    if (loadedStorage) return;
    const stored = await storageCall('load');
    loadedStorage = true;
    if (!stored) return;
    const bound = boundClientJwt(stored);
    if (!bound) {
      await storageCall('clear');
      return;
    }
    clientJwt = bound.token;
    clientJwtClientId = bound.clientId;
  }

  async function rotateClientJwt(response, expectedClientId) {
    const candidate = clientJwtFromResponse(response);
    if (!candidate) return;
    const bound = boundClientJwt(candidate, expectedClientId || clientJwtClientId);
    if (!bound) throw safeError('INVALID_SERVER_RESPONSE');
    if (bound.token !== clientJwt) {
      await storageCall('save', bound.token);
      clientJwt = bound.token;
    }
    clientJwtClientId = bound.clientId;
  }

  async function request(path, { method = 'GET', body, query, signal, epoch } = {}) {
    await loadStoredJwt();
    const url = new URL(path, issuer);
    url.searchParams.set('__clerk_api_version', apiVersion);
    url.searchParams.set('_is_native', '1');
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    if (url.origin !== issuer || !url.pathname.startsWith('/v1/')) throw safeError('INVALID_CONFIGURATION');

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const headers = new Headers({ accept: 'application/json' });
    if (clientJwt) headers.set('authorization', `Bearer ${clientJwt}`);
    let encodedBody;
    if (body) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      encodedBody = form(body).toString();
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(safeError('NETWORK_TIMEOUT', { retryable: true }));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        Promise.resolve(fetchImpl(url, {
          method,
          headers,
          body: encodedBody,
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        })),
        timeout,
      ]);
      if (epoch !== undefined && epoch !== operationEpoch) throw safeError('CANCELLED');
      let payload = null;
      try { payload = await response.json(); } catch (_) { /* handled below */ }
      const updatedClient = unwrapClient(payload);
      if (updatedClient) assertId(updatedClient.id, 'client');
      await rotateClientJwt(response, updatedClient && updatedClient.id);
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw safeError(response.status === 429 ? 'RATE_LIMITED' : 'AUTH_REQUEST_FAILED', {
          httpStatus: response.status,
          retryable,
        });
      }
      if (!payload || typeof payload !== 'object') throw safeError('INVALID_SERVER_RESPONSE');
      if (updatedClient) {
        if (clientJwtClientId && clientJwtClientId !== updatedClient.id) throw safeError('INVALID_SERVER_RESPONSE');
        client = updatedClient;
      }
      return payload;
    } catch (error) {
      if (error instanceof NativeClerkAuthError) throw error;
      if (controller.signal.aborted || (signal && signal.aborted)) throw safeError('CANCELLED');
      throw safeError('NETWORK_ERROR', { retryable: true });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  async function refreshClient(context = {}) {
    await loadStoredJwt();
    const payload = clientJwt
      ? await request('/v1/client', context)
      : await request('/v1/client', { ...context, method: 'POST' });
    if (!client) throw safeError('INVALID_SERVER_RESPONSE');
    return client;
  }

  async function ensureClient(context) {
    await loadStoredJwt();
    if (!clientJwt) await refreshClient(context);
  }

  async function exclusive(callback) {
    if (activeOperation) throw safeError('AUTH_BUSY', { retryable: true });
    const controller = new AbortController();
    const epoch = ++operationEpoch;
    activeOperation = { controller, epoch };
    try {
      return await callback({ signal: controller.signal, epoch });
    } finally {
      if (activeOperation && activeOperation.epoch === epoch) activeOperation = null;
    }
  }

  async function status() {
    return exclusive(async context => publicStatus(await refreshClient(context), now));
  }

  async function startGoogle({ redirectUrl } = {}) {
    const safeRedirect = googleRedirect(redirectUrl);
    return exclusive(async context => {
      await ensureClient(context);
      const payload = await request('/v1/client/sign_ins', {
        ...context,
        method: 'POST',
        body: { strategy: 'oauth_google', redirect_url: safeRedirect },
      });
      const signIn = unwrapResponse(payload, 'sign_in_attempt');
      googleSignInId = assertId(signIn.id, 'signIn');
      emailSignInId = null;
      const verification = signIn.first_factor_verification;
      return { url: externalGoogleUrl(verification && verification.external_verification_redirect_url, issuer) };
    });
  }

  async function completeGoogle({ nonce } = {}) {
    const rotatingNonce = String(nonce || '');
    if (!validClerkNonce(rotatingNonce)) throw safeError('INVALID_CALLBACK');
    return exclusive(async context => {
      if (usedNonces.has(rotatingNonce)) throw safeError('CALLBACK_REPLAYED');
      usedNonces.add(rotatingNonce);
      if (!googleSignInId) {
        await refreshClient(context);
        googleSignInId = client && client.sign_in && client.sign_in.id
          ? assertId(client.sign_in.id, 'signIn') : null;
      }
      if (!googleSignInId) throw safeError('NO_AUTH_ATTEMPT');
      const payload = await request(`/v1/client/sign_ins/${encodeURIComponent(googleSignInId)}`, {
        ...context,
        query: { rotating_token_nonce: rotatingNonce },
      });
      const signIn = unwrapResponse(payload, 'sign_in_attempt');
      const verification = signIn.first_factor_verification;
      if (verification && verification.status === 'transferable') {
        const signUpPayload = await request('/v1/client/sign_ups', {
          ...context,
          method: 'POST',
          body: { transfer: true },
        });
        unwrapResponse(signUpPayload, 'sign_up_attempt');
      }
      const result = publicStatus(client, now);
      if (result.status === 'active') googleSignInId = null;
      return result;
    });
  }

  async function startEmail(email) {
    const identifier = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) || identifier.length > 254) {
      throw safeError('INVALID_EMAIL');
    }
    return exclusive(async context => {
      await ensureClient(context);
      const createPayload = await request('/v1/client/sign_ins', {
        ...context,
        method: 'POST',
        body: { identifier },
      });
      const createdSignIn = unwrapResponse(createPayload, 'sign_in_attempt');
      emailSignInId = assertId(createdSignIn.id, 'signIn');
      const factor = Array.isArray(createdSignIn.supported_first_factors)
        ? createdSignIn.supported_first_factors.find(candidate => candidate && candidate.strategy === 'email_code')
        : null;
      if (!factor || typeof factor.email_address_id !== 'string' || !factor.email_address_id) {
        throw safeError('EMAIL_CODE_UNAVAILABLE');
      }
      const preparePayload = await request(`/v1/client/sign_ins/${encodeURIComponent(emailSignInId)}/prepare_first_factor`, {
        ...context,
        method: 'POST',
        body: { strategy: 'email_code', email_address_id: factor.email_address_id },
      });
      const signIn = unwrapResponse(preparePayload, 'sign_in_attempt');
      emailSignInId = assertId(signIn.id, 'signIn');
      googleSignInId = null;
      return publicStatus(client, now);
    });
  }

  async function verifyEmail(code) {
    const verificationCode = String(code || '').trim();
    if (!/^\d{4,10}$/.test(verificationCode)) throw safeError('INVALID_CODE');
    return exclusive(async context => {
      if (!emailSignInId) {
        await refreshClient(context);
        emailSignInId = client && client.sign_in && client.sign_in.id
          ? assertId(client.sign_in.id, 'signIn') : null;
      }
      if (!emailSignInId) throw safeError('NO_AUTH_ATTEMPT');
      const payload = await request(`/v1/client/sign_ins/${encodeURIComponent(emailSignInId)}/attempt_first_factor`, {
        ...context,
        method: 'POST',
        body: { strategy: 'email_code', code: verificationCode },
      });
      unwrapResponse(payload, 'sign_in_attempt');
      const result = publicStatus(client, now);
      if (result.status === 'active') emailSignInId = null;
      return result;
    });
  }

  async function getSessionToken() {
    return exclusive(async context => {
      const current = publicStatus(await refreshClient(context), now);
      if (current.status !== 'active') return null;
      const sessionId = assertId(current.sessionId, 'session');
      const payload = await request(`/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`, {
        ...context,
        method: 'POST',
      });
      const jwt = payload && (payload.jwt || (payload.response && payload.response.jwt));
      return typeof jwt === 'string' && jwt.split('.').length === 3 ? jwt : (() => { throw safeError('INVALID_SERVER_RESPONSE'); })();
    });
  }

  async function signOut() {
    return exclusive(async context => {
      let failure = null;
      try {
        await loadStoredJwt();
        if (clientJwt) await request('/v1/client/sessions', { ...context, method: 'DELETE' });
      } catch (error) {
        failure = error;
      }
      try {
        await storageCall('clear');
      } catch (error) {
        failure = failure || error;
      } finally {
        clientJwt = null;
        clientJwtClientId = null;
        client = null;
        loadedStorage = true;
        googleSignInId = null;
        emailSignInId = null;
        usedNonces.clear();
      }
      if (failure) throw failure;
      return { status: 'signed_out' };
    });
  }

  function cancel() {
    operationEpoch += 1;
    if (activeOperation) activeOperation.controller.abort();
    activeOperation = null;
    googleSignInId = null;
    emailSignInId = null;
    return { status: 'signed_out' };
  }

  return Object.freeze({ status, startGoogle, completeGoogle, startEmail, verifyEmail, getSessionToken, signOut, cancel });
}

module.exports = {
  DEFAULT_API_VERSION,
  NativeClerkAuthError,
  createNativeClerkClient,
};
