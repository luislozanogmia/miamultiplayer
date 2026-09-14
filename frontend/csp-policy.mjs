/*
 * Mia renderer CSP contract.
 *
 * Keep this policy in a small, dependency-free module so an HTTP/Electron
 * integration can consume the exact same string as the page meta tag. The
 * policy deliberately names every non-self source; there are no CDN, scheme,
 * or wildcard fallbacks.
 */

export const CSP_DIRECTIVES = Object.freeze([
  Object.freeze(['default-src', Object.freeze(["'self'"])]),
  Object.freeze(['base-uri', Object.freeze(["'none'"])]),
  Object.freeze(['object-src', Object.freeze(["'none'"])]),
  Object.freeze(['frame-ancestors', Object.freeze(["'none'"])]),
  Object.freeze(['form-action', Object.freeze(["'self'"])]),
  Object.freeze(['script-src', Object.freeze(["'self'"])]),
  Object.freeze(['script-src-elem', Object.freeze(["'self'"])]),
  Object.freeze(['script-src-attr', Object.freeze(["'none'"])]),
  // The page has existing DOM style attributes and MiaMark generates a small
  // keyframes <style> element. Keep those two exceptions explicit while
  // denying every remote stylesheet.
  Object.freeze(['style-src', Object.freeze(["'self'"])]),
  Object.freeze(['style-src-elem', Object.freeze(["'self'", "'unsafe-inline'"])]),
  Object.freeze(['style-src-attr', Object.freeze(["'unsafe-inline'"])]),
  // data: is used by the checked-in SVG artwork; blob: is used for local
  // attachment previews and decoded image derivatives.
  Object.freeze(['img-src', Object.freeze([
    "'self'",
    'data:',
    'blob:',
  ])]),
  Object.freeze(['font-src', Object.freeze(["'self'"])]),
  Object.freeze(['media-src', Object.freeze(["'self'", 'blob:'])]),
  // API calls and the native conversation socket are same-origin. Remote
  // provider requests happen behind the local backend/Hermes boundary.
  Object.freeze(['connect-src', Object.freeze(["'self'"])]),
  // Local workers and blob worker wrappers stay same-origin.
  Object.freeze(['worker-src', Object.freeze(["'self'", 'blob:'])]),
  Object.freeze(['child-src', Object.freeze(["'self'", 'blob:'])]),
  // Renderer frames are limited to the application origin.
  Object.freeze(['frame-src', Object.freeze(["'self'"])]),
  Object.freeze(['manifest-src', Object.freeze(["'self'"])]),
]);

function serializeDirective([name, sources]) {
  return [name, ...sources].join(' ');
}

export const MIAOS_PAGE_CSP = CSP_DIRECTIVES.map(serializeDirective).join('; ');

// These are the local files required by the index page and its already
// integrated worker/blob features. The test suite checks this inventory on
// disk and throws with the missing paths instead of allowing a partial build.
export const REQUIRED_LOCAL_ASSETS = Object.freeze([
  'styles.css',
  'assets/developer-mode-theme.js',
  'assets/mia-mark.js',
  'chat-security.js',
  'hermes-connectors.js',
  'native-browser.js',
  'app.js',
  'assets/fonts/InstrumentSans-Variable.woff2',
  'assets/fonts/JetBrainsMono-Variable.woff2',
]);

export function assertRequiredLocalAssets(exists) {
  if (typeof exists !== 'function') throw new TypeError('asset existence check is required');
  const missing = REQUIRED_LOCAL_ASSETS.filter((assetPath) => !exists(assetPath));
  if (missing.length) {
    throw new Error(`Missing Mia CSP assets:\n${missing.map((assetPath) => `- ${assetPath}`).join('\n')}`);
  }
  return true;
}
