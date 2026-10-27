'use strict';

// The page open in Mia's browser travels with a chat message as context, is
// saved with it, and is shown to the model. Page addresses can carry secrets
// (user:pass@, OAuth codes and tokens, signed-URL signatures, fragments that
// hold access tokens), so only a cleaned address is ever kept or sent.

const MAX_URL_LENGTH = 2000;
const SENSITIVE_PARAM_NAME = /(^|[_.-])(code|key|state|sid|sig|pass|pwd|otp|nonce|ticket|auth|assertion)$|session|token|secret|passw|signature|credential|apikey|api_key|api-key|jwt|samlresponse|samlrequest|^x-(amz|goog)-/i;
const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\./;
// A long unbroken run of token characters is a credential, not a search term.
const OPAQUE_VALUE = /^[A-Za-z0-9_\-+/=.~%]{40,}$/;
const CREDENTIAL_PATH = /^(?:reset(?:[-_]?password)?|password[-_]?reset|recover|recovery|verify(?:[-_]?(?:email|account))?|verification|invite|invitation|magic(?:[-_]?(?:link|login))?|unsubscribe|activate|activation|confirm|confirmation|login|sign[-_]?in|auth|oauth|sso|token)$/i;
const AUTH_ROUTE_WORD = /^(?:accept|callback|complete|finish|email|password|reset|verify|login|logout|signin|signout|sign-in|sign-out|auth|oauth|authorize|authorization|sso|local|new|create)$/i;

function sensitiveParam(name, value) {
  return SENSITIVE_PARAM_NAME.test(String(name || ''))
    || JWT_LIKE.test(String(value || ''))
    || OPAQUE_VALUE.test(String(value || ''));
}

// These identifiers locate resources; they are not Google sign-in tokens or
// GitHub credentials. Match exact hosts and route positions, not substrings.
function publicResourceIdentifier(host, parts, index) {
  if (host === 'docs.google.com' && /^(document|spreadsheets|presentation|drawings|forms)$/.test(parts[0])) {
    const d = parts[1] === 'u' && /^\d+$/.test(parts[2]) ? 3 : 1;
    const id = d + (parts[d + 1] === 'e' ? 2 : 1);
    return parts[d] === 'd' && index === id && /^[A-Za-z0-9_-]+$/.test(parts[index]);
  }
  if (host === 'drive.google.com') {
    if (parts[0] === 'file' && parts[1] === 'd' && index === 2) return /^[A-Za-z0-9_-]+$/.test(parts[index]);
    const folder = parts[1] === 'u' && /^\d+$/.test(parts[2]) ? 3 : 1;
    if (parts[0] === 'drive' && parts[folder] === 'folders' && index === folder + 1) return /^[A-Za-z0-9_-]+$/.test(parts[index]);
  }
  return host === 'github.com' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(parts[index]) && (
    (index === 3 && /^(commit|tree|blob)$/.test(parts[2])) ||
    (index === 5 && parts[2] === 'pull' && /^\d+$/.test(parts[3]) && parts[4] === 'commits')
  );
}

function credentialBearingPath(parsed) {
  let decoded = parsed.pathname;
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (_) {
      // Do not forward a malformed encoding that cannot be inspected safely.
      return true;
    }
  }
  // Some redirectors double-encode the question mark into the path. Treat
  // credential query fields exposed by path decoding as credentials too.
  for (const match of decoded.matchAll(/[?&]([^=&/]{1,64})=([^&#/]*)/g)) {
    if (sensitiveParam(match[1], match[2])) return true;
  }
  const parts = decoded.split('/').filter(Boolean);
  return parts.some((value, index) =>
    JWT_LIKE.test(value) ||
    (OPAQUE_VALUE.test(value) && !publicResourceIdentifier(parsed.hostname, parts, index)) ||
    (CREDENTIAL_PATH.test(value) && parts.slice(index + 1).some(part => !AUTH_ROUTE_WORD.test(part)))
  );
}

// Redirect/continue parameters may carry encoded URLs that another site will
// decode again. Omit the entire parameter when it embeds an address or a
// credential-like query field; partially cleaning a nested URL is unsafe.
function embeddedAddressOrCredentialQuery(value) {
  let decoded = String(value || '').trim();
  for (let pass = 0; pass < 4; pass += 1) {
    if (/https?:\/\/|^\/\//i.test(decoded)) return true;
    if (/^\//.test(decoded)) return true;
    const query = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded;
    if (query.includes('=')) {
      for (const [name, nestedValue] of new URLSearchParams(query)) {
        if (sensitiveParam(name, nestedValue)) return true;
      }
    }
    if (!decoded.includes('%')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return false;
      decoded = next;
    } catch (_) { return true; }
  }
  // A deeply encoded value cannot be established as safe.
  return decoded.includes('%');
}

// An http(s) address with credentials, fragment and secret-looking query
// parameters removed, or '' when there is no usable address. Credential-like
// paths become origin-only (plus safe query), not a partially guessed route.
function safeBrowserPageUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  for (const [name, value] of [...parsed.searchParams]) {
    if (sensitiveParam(name, value) || embeddedAddressOrCredentialQuery(value)) {
      parsed.searchParams.delete(name);
    }
  }
  if (parsed.href.length > MAX_URL_LENGTH) return '';
  if (credentialBearingPath(parsed)) parsed.pathname = '/';
  return parsed.href;
}

// The browserContext a message may carry, cleaned; null when unusable.
function safeBrowserContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const url = safeBrowserPageUrl(context.url);
  if (!url) return null;
  const title = String(context.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { url, title };
}

module.exports = { safeBrowserContext, safeBrowserPageUrl };
