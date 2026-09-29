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

function sensitiveParam(name, value) {
  return SENSITIVE_PARAM_NAME.test(String(name || ''))
    || JWT_LIKE.test(String(value || ''))
    || OPAQUE_VALUE.test(String(value || ''));
}

// An http(s) address with credentials, fragment and secret-looking query
// parameters removed, or '' when there is no usable address.
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
    if (sensitiveParam(name, value)) parsed.searchParams.delete(name);
  }
  const url = parsed.href;
  return url.length > MAX_URL_LENGTH ? '' : url;
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
