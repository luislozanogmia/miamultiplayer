'use strict';
// The app's one check for text that looks like it holds a credential. It finds a
// secret by its label ("token: ...", a bearer header, a key in a URL) or by the
// shape of a well-known key.
const BARE_KEY=/\bsk-[A-Za-z0-9_-]{20,}|\b[sr]k_live_[A-Za-z0-9]{10,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
function redactHermesDiagnosticText(value, maxLength = 12000) {
  let text = String(value || '');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|token|password|secret|client_secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/[^\s/]+\/[^\s]*[?&](?:token|key|secret|password)=[^\s&]+)/gi, '[REDACTED_URL]');
  text = text.replace(BARE_KEY, '[REDACTED]');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[…truncated…]` : text;
}
const looksLikeSecret = value => redactHermesDiagnosticText(value, Infinity) !== String(value || '');
module.exports = { redactHermesDiagnosticText, looksLikeSecret };
