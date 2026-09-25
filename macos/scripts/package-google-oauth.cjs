"use strict";
const fs = require("node:fs");
const path = require("node:path");
const CLIENT_ID_RE = /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

// A native OAuth client ID is public registration metadata, not a secret. The
// official value is injected by the controlled release environment so public
// source builds do not silently impersonate Mia. Forks can provide their own
// Desktop client ID; builds without one keep Google disconnected.
function stageGoogleOAuthClient(backendDirectory, env = process.env) {
  if (env.MIA_GOOGLE_OAUTH_CLIENT_FILE) {
    throw new Error("Desktop OAuth client files are not accepted; inject the registration through the environment");
  }
  const clientId = String(env.MIA_GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const required = String(env.MIA_REQUIRE_GOOGLE_OAUTH || "") === "1";
  const clientSecret = String(env.MIA_GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const output = path.join(backendDirectory, "google-oauth-client.json");
  if (!clientId) {
    if (clientSecret) throw new Error("Google desktop OAuth client secret requires a client ID");
    if (required) throw new Error("Official build requires MIA_GOOGLE_OAUTH_CLIENT_ID");
    fs.rmSync(output, { force: true });
    return null;
  }
  if (!CLIENT_ID_RE.test(clientId)) throw new Error("Invalid Google desktop OAuth client ID");
  if (clientSecret.length > 4096) throw new Error("Invalid Google desktop OAuth client secret");
  if (required && !clientSecret) throw new Error("Official build requires MIA_GOOGLE_OAUTH_CLIENT_SECRET");
  const expected = String(env.MIA_EXPECTED_GOOGLE_OAUTH_CLIENT_ID || "").trim();
  if (expected && clientId !== expected) throw new Error("Google desktop OAuth client ID does not match the protected release value");
  fs.mkdirSync(backendDirectory, { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ installed: { client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}) } }), { flag: "wx", mode: 0o600 });
  return output;
}
module.exports = { stageGoogleOAuthClient, CLIENT_ID_RE };
