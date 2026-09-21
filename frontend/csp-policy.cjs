'use strict';

const BASE_CSP_DIRECTIVES = Object.freeze([
  ['default-src', ["'self'"]],
  ['base-uri', ["'none'"]],
  ['object-src', ["'none'"]],
  ['frame-ancestors', ["'none'"]],
  ['form-action', ["'self'"]],
  ['script-src', ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']],
  ['script-src-elem', ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']],
  ['script-src-attr', ["'none'"]],
  ['style-src', ["'self'"]],
  ['style-src-elem', ["'self'", "'unsafe-inline'"]],
  ['style-src-attr', ["'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:', 'blob:', 'https://img.clerk.com']],
  ['font-src', ["'self'"]],
  ['media-src', ["'self'", 'blob:']],
  ['connect-src', [
    "'self'",
    'https://*.clerk.accounts.dev',
    'https://clerk-telemetry.com',
    'https://*.clerk-telemetry.com',
    'https://img.clerk.com',
    'https://*.protect.clerk.com:*',
  ]],
  ['worker-src', ["'self'", 'blob:']],
  ['child-src', ["'self'", 'blob:']],
  ['frame-src', ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']],
  ['manifest-src', ["'self'"]],
].map(([name, sources]) => Object.freeze([name, Object.freeze(sources)])));

function serialize(directives) {
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}

function buildPageCsp(clerkIssuerOrigin = '') {
  const origin = String(clerkIssuerOrigin || '').trim();
  const directives = BASE_CSP_DIRECTIVES.map(([name, sources]) => {
    if (name !== 'connect-src' || !origin || /\.clerk\.accounts\.dev$/.test(new URL(origin).hostname)) {
      return [name, sources];
    }
    return [name, [...sources, origin]];
  });
  return serialize(directives);
}

function replacePageCsp(html, policy) {
  const pattern = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/>)/i;
  if (!pattern.test(html)) throw new Error('Mia index.html is missing its CSP meta tag');
  return html.replace(pattern, `$1${policy}$2`);
}

module.exports = { BASE_CSP_DIRECTIVES, buildPageCsp, replacePageCsp };
