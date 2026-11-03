'use strict';

// The page open in Mia's browser travels with a chat message as context, is
// saved with it, and is shown to the model. Page addresses can carry secrets
// (user:pass@, OAuth codes and tokens, signed-URL signatures, fragments that
// hold access tokens), so only a cleaned address is ever kept or sent.

const { safeBrowserPageUrl } = require('../frontend/safe-page-url.js');

// The browserContext a message may carry, cleaned; null when unusable.
function safeBrowserContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const url = safeBrowserPageUrl(context.url);
  if (!url) return null;
  const title = String(context.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { url, title };
}

module.exports = { safeBrowserContext, safeBrowserPageUrl };
