"use strict";

// Clerk callback tokens are opaque URL-unreserved strings. Both the desktop
// redirect and FAPI exchange must accept exactly the same bounded grammar.
function validClerkNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{16,4096}$/.test(value);
}

module.exports = { validClerkNonce };
