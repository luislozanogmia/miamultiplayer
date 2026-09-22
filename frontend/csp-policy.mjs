/*
 * Mia renderer CSP contract.
 *
 * Keep this policy in a small, dependency-free module so an HTTP/Electron
 * integration can consume the exact same string as the page meta tag. The
 * policy deliberately names every non-self source; there are no CDN, scheme,
 * or wildcard fallbacks.
 */

import policy from './csp-policy.cjs';

export const CSP_DIRECTIVES = policy.BASE_CSP_DIRECTIVES;
export const buildPageCsp = policy.buildPageCsp;
export const replacePageCsp = policy.replacePageCsp;
export const MIAOS_PAGE_CSP = buildPageCsp();

// These are the local files required by the index page and its already
// integrated worker/blob features. The test suite checks this inventory on
// disk and throws with the missing paths instead of allowing a partial build.
export const REQUIRED_LOCAL_ASSETS = Object.freeze([
  'styles.css',
  'assets/developer-mode-theme.js',
  'assets/mia-mark.js',
  'chat-security.js',
  'chat-scroll.js',
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
