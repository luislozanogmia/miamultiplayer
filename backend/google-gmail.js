'use strict';

const crypto = require('crypto');

// Gmail remains read-only even though the other Workspace cards exercise
// their own write paths. Mia must never send, modify, or delete email.
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const GOOGLE_WORKSPACE_SCOPES = Object.freeze([
  GMAIL_READONLY_SCOPE,
  DRIVE_SCOPE,
  SHEETS_SCOPE,
  DOCS_SCOPE,
]);
const GOOGLE_SERVICE_SCOPES = Object.freeze({
  gmail: GMAIL_READONLY_SCOPE,
  drive: DRIVE_SCOPE,
  sheets: SHEETS_SCOPE,
  docs: DOCS_SCOPE,
});
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';
const DOCS_API_BASE = 'https://docs.googleapis.com/v1';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_STATE_FUTURE_SKEW_MS = 30 * 1000;
const GOOGLE_REQUEST_TIMEOUT_MS = 15 * 1000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function parseEncryptionKey(raw) {
  const value = String(raw || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) return decoded;
  } catch (_) {
    // A malformed key is reported as not configured by isConfigured().
  }
  return null;
}

function configFromEnv(env = process.env) {
  return {
    clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: String(env.GOOGLE_REDIRECT_URI || 'http://localhost:4870/api/connections/google/callback').trim(),
    frontendUrl: String(env.GOOGLE_FRONTEND_URL || 'http://127.0.0.1:4930').trim(),
    tokenEncryptionKey: parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY),
    stateSigningSecret: String(env.GOOGLE_OAUTH_STATE_SECRET || '').trim(),
  };
}

function isConfigured(config) {
  return Boolean(
    config &&
      config.clientId &&
      config.clientSecret &&
      config.redirectUri &&
      config.frontendUrl &&
      config.tokenEncryptionKey &&
      config.stateSigningSecret
  );
}

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/);
  return [...new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean))];
}

function hasRequiredScopes(scopes) {
  const granted = new Set(normalizeScopes(scopes));
  return GOOGLE_WORKSPACE_SCOPES.every((scope) => granted.has(scope));
}

function serviceAccess(scopes) {
  const granted = new Set(normalizeScopes(scopes));
  return Object.fromEntries(
    Object.entries(GOOGLE_SERVICE_SCOPES).map(([service, scope]) => [service, granted.has(scope)])
  );
}

function serviceSupportsWrite(service) {
  return service !== 'gmail' && Object.prototype.hasOwnProperty.call(GOOGLE_SERVICE_SCOPES, service);
}

function stateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createOAuthState(secret, nowMs = Date.now(), nonce = crypto.randomBytes(24).toString('hex')) {
  const payload = base64url(JSON.stringify({ n: nonce, iat: nowMs }));
  return {
    nonce,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + OAUTH_STATE_MAX_AGE_MS).toISOString(),
    value: `${payload}.${stateSignature(payload, secret)}`,
  };
}

function verifyOAuthState(value, secret, nowMs = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = stateSignature(parts[0], secret);
  const received = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  const issuedAt = Number(payload && payload.iat);
  const nonce = String((payload && payload.n) || '');
  if (!Number.isSafeInteger(issuedAt) || !/^[a-f0-9]{48}$/.test(nonce)) return null;
  if (issuedAt > nowMs + OAUTH_STATE_FUTURE_SKEW_MS || nowMs - issuedAt > OAUTH_STATE_MAX_AGE_MS) return null;
  return { nonce, issuedAt };
}

function buildAuthorizationUrl(config, state) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

function encryptRefreshToken(refreshToken, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid token encryption key');
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('missing refresh token');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptRefreshToken(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid token encryption key');
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid encrypted token');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function connectorError(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

async function timedGoogleFetch(fetchImpl, url, options, timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS) {
  if (typeof fetchImpl !== 'function') throw connectorError('fetch_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || GOOGLE_REQUEST_TIMEOUT_MS));
  try {
    return await fetchImpl(url, { ...(options || {}), signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw connectorError('google_request_timeout', 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

async function googleApiRequest(accessToken, url, options = {}, errorCode = 'google_api_failed', fetchImpl = global.fetch) {
  const request = {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  };
  if (options.body !== undefined) {
    request.headers['content-type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await timedGoogleFetch(fetchImpl, url, request);
  const data = await parseJson(response);
  if (!response.ok) throw connectorError(errorCode, response.status);
  return data;
}

async function exchangeAuthorizationCode(code, config, fetchImpl = global.fetch, timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS) {
  const body = new URLSearchParams({
    code: String(code || ''),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await timedGoogleFetch(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, timeoutMs);
  const data = await parseJson(response);
  if (!response.ok || !data.access_token) {
    throw connectorError(data.error === 'invalid_grant' ? 'invalid_grant' : 'token_exchange_failed', response.status);
  }
  return data;
}

async function refreshAccessToken(refreshToken, config, fetchImpl = global.fetch, timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await timedGoogleFetch(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, timeoutMs);
  const data = await parseJson(response);
  if (!response.ok || !data.access_token) {
    throw connectorError(data.error === 'invalid_grant' ? 'invalid_grant' : 'token_refresh_failed', response.status);
  }
  return data.access_token;
}

async function gmailApiRequest(accessToken, pathname, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${GMAIL_API_BASE}${pathname}`, {}, 'gmail_api_failed', fetchImpl);
}

async function fetchGmailProfile(accessToken, fetchImpl = global.fetch) {
  return gmailApiRequest(accessToken, '/profile', fetchImpl);
}

async function listGmailMessages(accessToken, fetchImpl = global.fetch) {
  return gmailApiRequest(accessToken, '/messages?maxResults=1', fetchImpl);
}

async function listDriveFiles(accessToken, fetchImpl = global.fetch) {
  const query = new URLSearchParams({
    pageSize: '1',
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime)',
  });
  return googleApiRequest(accessToken, `${DRIVE_API_BASE}/files?${query}`, {}, 'drive_api_failed', fetchImpl);
}

async function getDriveFile(accessToken, fileId, fetchImpl = global.fetch) {
  const fields = 'id,name,mimeType,modifiedTime,webViewLink,size,trashed';
  return googleApiRequest(
    accessToken,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
    {},
    'drive_api_failed',
    fetchImpl
  );
}

async function listDriveFolder(accessToken, folderId, fetchImpl = global.fetch) {
  const query = new URLSearchParams({
    pageSize: '50',
    orderBy: 'modifiedTime desc',
    q: `'${String(folderId || '').replace(/'/g, "\\'")}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  return googleApiRequest(accessToken, `${DRIVE_API_BASE}/files?${query}`, {}, 'drive_api_failed', fetchImpl);
}

async function downloadDriveText(accessToken, fileId, fetchImpl = global.fetch, maxBytes = 256 * 1024) {
  const response = await timedGoogleFetch(
    fetchImpl,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        accept: 'text/plain,*/*',
        authorization: `Bearer ${accessToken}`,
        range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
      },
    }
  );
  if (!response.ok) throw connectorError('drive_api_failed', response.status);
  const declaredSize = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw connectorError('drive_file_too_large', 413);

  // Do not rely on Content-Length: chunked responses can omit it. Consume the
  // web stream incrementally and cancel as soon as the byte ceiling is crossed
  // so an unexpectedly large Drive object cannot be buffered into Mia.
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw connectorError('drive_file_too_large', 413);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw connectorError('drive_file_too_large', 413);
  return body.toString('utf8');
}

async function createDriveFolder(accessToken, name, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${DRIVE_API_BASE}/files?fields=id,name,mimeType`, {
    method: 'POST',
    body: { name, mimeType: 'application/vnd.google-apps.folder' },
  }, 'drive_api_failed', fetchImpl);
}

async function trashDriveFile(accessToken, fileId, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
    method: 'PATCH',
    body: { trashed: true },
  }, 'drive_api_failed', fetchImpl);
}

async function createSpreadsheet(accessToken, title, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${SHEETS_API_BASE}/spreadsheets`, {
    method: 'POST',
    body: {
      properties: { title },
      sheets: [{ properties: { title: 'MiaTest' } }],
    },
  }, 'sheets_api_failed', fetchImpl);
}

async function writeSpreadsheetValue(accessToken, spreadsheetId, range, value, fetchImpl = global.fetch) {
  return writeSpreadsheetValues(accessToken, spreadsheetId, range, [[value]], fetchImpl);
}

async function writeSpreadsheetValues(accessToken, spreadsheetId, range, values, fetchImpl = global.fetch) {
  const query = new URLSearchParams({ valueInputOption: 'RAW' });
  return googleApiRequest(
    accessToken,
    `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${query}`,
    { method: 'PUT', body: { range, majorDimension: 'ROWS', values } },
    'sheets_api_failed',
    fetchImpl
  );
}

async function readSpreadsheetValue(accessToken, spreadsheetId, range, fetchImpl = global.fetch) {
  return googleApiRequest(
    accessToken,
    `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    {},
    'sheets_api_failed',
    fetchImpl
  );
}

async function getSpreadsheet(accessToken, spreadsheetId, fetchImpl = global.fetch) {
  const fields = 'spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))';
  return googleApiRequest(
    accessToken,
    `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    {},
    'sheets_api_failed',
    fetchImpl
  );
}

async function createDocument(accessToken, title, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${DOCS_API_BASE}/documents`, {
    method: 'POST',
    body: { title },
  }, 'docs_api_failed', fetchImpl);
}

async function insertDocumentText(accessToken, documentId, text, fetchImpl = global.fetch) {
  return googleApiRequest(accessToken, `${DOCS_API_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
  }, 'docs_api_failed', fetchImpl);
}

async function getDocument(accessToken, documentId, fetchImpl = global.fetch) {
  return googleApiRequest(
    accessToken,
    `${DOCS_API_BASE}/documents/${encodeURIComponent(documentId)}`,
    {},
    'docs_api_failed',
    fetchImpl
  );
}

async function testGoogleService(service, accessToken, fetchImpl = global.fetch, marker = `mia-${Date.now()}`) {
  if (!Object.prototype.hasOwnProperty.call(GOOGLE_SERVICE_SCOPES, service)) {
    throw connectorError('unknown_google_service', 400);
  }

  let artifactId = '';
  let cleanupOk = true;
  let result;
  try {
    if (service === 'gmail') {
      const profile = await fetchGmailProfile(accessToken, fetchImpl);
      const messages = await listGmailMessages(accessToken, fetchImpl);
      result = {
        emailAddress: String(profile && profile.emailAddress || '').toLowerCase(),
        readVerified: Boolean(messages && typeof messages === 'object'),
        writeVerified: false,
        readOnly: true,
        cleanupOk: true,
      };
    } else if (service === 'drive') {
      const files = await listDriveFiles(accessToken, fetchImpl);
      const folder = await createDriveFolder(accessToken, `Mia connector test ${marker}`, fetchImpl);
      artifactId = String(folder && folder.id || '');
      if (!artifactId) throw connectorError('drive_write_failed');
      result = {
        readVerified: Array.isArray(files && files.files),
        writeVerified: Boolean(folder && folder.mimeType === 'application/vnd.google-apps.folder'),
      };
    } else if (service === 'sheets') {
      const spreadsheet = await createSpreadsheet(accessToken, `Mia connector test ${marker}`, fetchImpl);
      artifactId = String(spreadsheet && spreadsheet.spreadsheetId || '');
      if (!artifactId) throw connectorError('sheets_write_failed');
      await writeSpreadsheetValue(accessToken, artifactId, 'MiaTest!A1', marker, fetchImpl);
      const values = await readSpreadsheetValue(accessToken, artifactId, 'MiaTest!A1', fetchImpl);
      result = {
        readVerified: Array.isArray(values && values.values),
        writeVerified: Boolean(values && values.values && values.values[0] && values.values[0][0] === marker),
      };
    } else {
      const document = await createDocument(accessToken, `Mia connector test ${marker}`, fetchImpl);
      artifactId = String(document && document.documentId || '');
      if (!artifactId) throw connectorError('docs_write_failed');
      await insertDocumentText(accessToken, artifactId, marker, fetchImpl);
      const readBack = await getDocument(accessToken, artifactId, fetchImpl);
      result = {
        readVerified: Boolean(readBack && readBack.documentId === artifactId),
        writeVerified: JSON.stringify(readBack || {}).includes(marker),
      };
    }
  } finally {
    if (artifactId) {
      try {
        if (service === 'gmail') await deleteGmailDraft(accessToken, artifactId, fetchImpl);
        else await trashDriveFile(accessToken, artifactId, fetchImpl);
      } catch (_) {
        cleanupOk = false;
      }
    }
  }

  return { ...result, cleanupOk };
}

async function revokeGoogleToken(token, fetchImpl = global.fetch) {
  if (!token || typeof fetchImpl !== 'function') return false;
  try {
    const response = await timedGoogleFetch(fetchImpl, GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  DRIVE_SCOPE,
  SHEETS_SCOPE,
  DOCS_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_SERVICE_SCOPES,
  OAUTH_STATE_MAX_AGE_MS,
  GOOGLE_REQUEST_TIMEOUT_MS,
  configFromEnv,
  isConfigured,
  normalizeScopes,
  hasRequiredScopes,
  serviceAccess,
  serviceSupportsWrite,
  createOAuthState,
  verifyOAuthState,
  buildAuthorizationUrl,
  encryptRefreshToken,
  decryptRefreshToken,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchGmailProfile,
  listGmailMessages,
  listDriveFiles,
  getDriveFile,
  listDriveFolder,
  downloadDriveText,
  createDriveFolder,
  trashDriveFile,
  createSpreadsheet,
  writeSpreadsheetValue,
  writeSpreadsheetValues,
  readSpreadsheetValue,
  getSpreadsheet,
  createDocument,
  insertDocumentText,
  getDocument,
  testGoogleService,
  revokeGoogleToken,
};
