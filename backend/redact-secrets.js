'use strict';
// The app's one check for text that looks like it holds a credential. It finds a
// secret by its label ("token: ...", a bearer header, a key in a URL), not a bare key.
function redactHermesDiagnosticText(value, maxLength = 12000) {
  let text = String(value || '');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|token|password|secret|client_secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/[^\s/]+\/[^\s]*[?&](?:token|key|secret|password)=[^\s&]+)/gi, '[REDACTED_URL]');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[…truncated…]` : text;
}
const looksLikeSecret = value => redactHermesDiagnosticText(value, Infinity) !== String(value || '');
module.exports = { redactHermesDiagnosticText, looksLikeSecret };
