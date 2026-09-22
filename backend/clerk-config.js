'use strict';

// Mia's own Clerk instances ship as built-in defaults so any checkout can join
// the hosted ecosystem by signing in. These are Clerk *public* values —
// publishable key, issuer, JWKS public key — the client half of an API call
// that does nothing without a real sign-in. Production is the default;
// MIAOS_CLERK_INSTANCE=test selects the development instance (dev_mode.sh
// does this). A fork overrides both with one complete CLERK_* tuple.
const TEST_OAUTH_CALLBACK_ORIGIN = 'https://clerk.shared.lcl.dev';
const CLERK_INSTANCES = Object.freeze({
  production: Object.freeze({
    publishableKey: 'pk_live_Y2xlcmsubWlhbXVsdGlwbGF5ZXIuY29tJA==',
    issuer: 'https://clerk.miamultiplayer.com',
    jwtKey: [
      '-----BEGIN PUBLIC KEY-----',
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv6cEb3FXZDmeK2vWPUh3',
      'Yv0+UX9hD1xHtrJB4zxOPV0ZviEOcBXRN77u7yaFrAPkP/1Af9DkGAEXXkSoq3jW',
      'Fg2s/82krYx2L1s37tomzZYzhFfxfZpESZbBw+37NVo2pBEEI7OM3yQF0G6Zh9f7',
      'PPxEwChGZrPBe+JLf42iqY+e8u9tly0VqGJK7NM8aZZf9zrTP161umy6PWF7QmsR',
      '2wr7zp0EMMM/T0x7JVklt9/hhbEmTt4jPHRgNqj/49DaEycjlzPhN8zFSgi4HZq5',
      'owZZNIGnAjMq+M7cR0k/I0pN1OFHTtiGmUenhTzdaufOq9c3VBExcNs71oI/cW46',
      'lQIDAQAB',
      '-----END PUBLIC KEY-----',
    ].join('\n'),
  }),
  test: Object.freeze({
    publishableKey: 'pk_test_ZmFpdGhmdWwtZHJ1bS0zMzMuY2xlcmsuYWNjb3VudHMuZGV2JA',
    issuer: 'https://faithful-drum-333.clerk.accounts.dev',
    jwtKey: [
      '-----BEGIN PUBLIC KEY-----',
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8H9FQVnnST3XYwwqcun5',
      'Bv0iqvXYCQDbxiDgOcGJz3N67WmnRNiv9+rY0Iv5nmCEM5+Mr0nvGimjT++WbN0L',
      'XlHc1o0MIK1gtR9+umHXIBM9WYvQL3gtkulVfURk0S/UqWruuRbHTk3N/nujN5oG',
      'eMW/8MdKjxJgRoDiWyQzOHRQL/8H+43uL7/xikDPaf2GeZ4GgHeAEhaSFh8ekTt/',
      'PViJMSdflAzRM5kn9txqNnCnfl8r7QfzlyiIchCTueiI8uUL7k0g0lgmq6uE48yr',
      'uR4op4c0GR3ZM1lwPJl/YMLdF82neuuKP+o8pBQEjkzoaVNHdKxGxZm1/5z3ewlB',
      'UQIDAQAB',
      '-----END PUBLIC KEY-----',
    ].join('\n'),
    oauthCallbackOrigin: TEST_OAUTH_CALLBACK_ORIGIN,
  }),
});

function builtInClerkInstance(env = process.env) {
  const name = String(env.MIAOS_CLERK_INSTANCE || '').trim().toLowerCase() || 'production';
  if (!Object.prototype.hasOwnProperty.call(CLERK_INSTANCES, name)) {
    throw new Error('MIAOS_CLERK_INSTANCE must be "production" or "test"');
  }
  return CLERK_INSTANCES[name];
}

function exactHttpsOrigin(value, name) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  let url;
  try { url = new URL(raw); } catch (_error) {
    throw new Error(`${name} must be an absolute HTTPS origin`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || url.origin !== raw) {
    throw new Error(`${name} must be an absolute HTTPS origin without a path, query, or credentials`);
  }
  return url.origin;
}

function resolveClerkConfig(env = process.env, defaults = builtInClerkInstance(env)) {
  const names = ['CLERK_PUBLISHABLE_KEY', 'CLERK_JWT_KEY', 'CLERK_ISSUER'];
  const values = Object.fromEntries(names.map((name) => [name, String(env[name] || '').trim()]));
  const configured = names.filter((name) => values[name]);
  if (configured.length > 0 && configured.length < names.length) {
    const missing = names.filter((name) => !values[name]);
    throw new Error(`Clerk configuration is incomplete; set all of ${names.join(', ')} (missing ${missing.join(', ')})`);
  }

  const overridden = configured.length === names.length;
  const publishableKey = overridden ? values.CLERK_PUBLISHABLE_KEY : defaults.publishableKey;
  const keyMatch = /^pk_(test|live)_/.exec(publishableKey);
  if (!keyMatch) throw new Error('CLERK_PUBLISHABLE_KEY must be a Clerk development or production publishable key');
  const keyEnvironment = keyMatch[1];
  const issuer = exactHttpsOrigin(overridden ? values.CLERK_ISSUER : defaults.issuer, 'CLERK_ISSUER');
  let encodedHost;
  try {
    const payload = publishableKey.replace(/^pk_(?:test|live)_/, '');
    encodedHost = Buffer.from(payload, 'base64url').toString('utf8').replace(/\$$/, '');
  } catch (_error) { /* handled by the hostname check below */ }
  if (!encodedHost || new URL(issuer).hostname !== encodedHost) {
    throw new Error('CLERK_PUBLISHABLE_KEY and CLERK_ISSUER must identify the same Clerk Frontend API host');
  }
  const explicitCallback = String(env.CLERK_OAUTH_CALLBACK_ORIGIN || '').trim();
  const oauthCallbackOrigin = exactHttpsOrigin(
    explicitCallback || (keyEnvironment === 'test'
      ? (defaults.oauthCallbackOrigin || TEST_OAUTH_CALLBACK_ORIGIN)
      : issuer),
    'CLERK_OAUTH_CALLBACK_ORIGIN',
  );
  const requested = String(env.MIAOS_CLERK_AUTH || '').trim();
  const noAuth = /^(1|true)$/i.test(String(env.MIAOS_NO_AUTH || ''));

  return Object.freeze({
    enabled: /^(1|true|)$/i.test(requested) && !noAuth,
    publishableKey,
    issuer,
    issuerOrigin: issuer,
    jwtKey: overridden ? values.CLERK_JWT_KEY : String(defaults.jwtKey || '').trim(),
    oauthCallbackOrigin,
    environment: keyEnvironment === 'live' ? 'production' : 'development',
    overridden,
  });
}

function clerkClaimsProfile(claims, expectedIssuer) {
  if (!claims || claims.iss !== expectedIssuer || typeof claims.sub !== 'string' || !claims.sub) {
    return { error: 'clerk_token_invalid' };
  }
  const primaryEmail = String(claims.primaryEmail || '').trim().toLowerCase();
  if (!primaryEmail || !primaryEmail.includes('@')) {
    return { error: 'clerk_primary_email_missing' };
  }
  const displayName = String(claims.fullName || '').trim();
  return {
    subject: claims.sub,
    primaryEmail,
    displayName,
  };
}

function unverifiedJwtPayload(token) {
  const pieces = String(token || '').split('.');
  if (pieces.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_error) {
    return null;
  }
}

// Browser Clerk tokens carry `azp` (the page origin that minted them) and must
// match the requesting origin. Native Clerk clients (Mia's desktop sign-in)
// mint tokens without `azp`; those are accepted only from a request whose
// Origin is one of this Mia's own trusted origins. The unverified read below
// only selects the mode — verifyToken still checks the signed payload.
function clerkVerifyOptions(token, { jwtKey, requestOrigin, trustedOrigins }) {
  const payload = unverifiedJwtPayload(token);
  if (!payload) return { error: 'clerk_token_invalid' };
  const origin = String(requestOrigin || '').trim().toLowerCase();
  const trusted = Array.from(trustedOrigins || []);
  if (Object.prototype.hasOwnProperty.call(payload, 'azp')) {
    return { options: { jwtKey, authorizedParties: origin ? [origin] : trusted } };
  }
  if (!origin || !trusted.includes(origin)) return { error: 'clerk_token_invalid' };
  return { options: { jwtKey }, native: true };
}

module.exports = {
  CLERK_INSTANCES,
  builtInClerkInstance,
  exactHttpsOrigin,
  resolveClerkConfig,
  clerkClaimsProfile,
  clerkVerifyOptions,
};
