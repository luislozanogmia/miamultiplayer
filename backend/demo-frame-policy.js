// The Multiplayer Demo page plays its demos in iframes, so these pages alone
// may be framed, and only by Mia itself. Their CSP keeps them local: they can
// run their own inline script but cannot open any connection.
const DEMO_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

// Plain path segments only: no "..", no percent-encoding, so a crafted path
// cannot reach another page with these looser frame headers.
const DEMO_PATH = /^\/multiplayer-demo\/demos\/(?:[a-z0-9_-]+\/)*(?:[a-z0-9_-]+(?:\.[a-z0-9]+)?)?$/i;

// The demo library itself opens beside Mia's workspace rail. Only Mia may frame
// it, and the page keeps its own strict policy, which allows its demo frames.
const DEMO_LIBRARY_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";
function isDemoLibraryPath(requestPath) {
  return requestPath === '/multiplayer-demo/' || requestPath === '/multiplayer-demo/index.html';
}

function isDemoFramePath(requestPath) {
  return DEMO_PATH.test(String(requestPath || ''));
}

module.exports = { DEMO_FRAME_CSP, DEMO_LIBRARY_CSP, isDemoFramePath, isDemoLibraryPath };
