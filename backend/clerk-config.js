'use strict';

const DEFAULT_CLERK_HOST = 'faithful-drum-333.clerk.accounts.dev';
const DEFAULT_CLERK_CONFIG = Object.freeze({
  publishableKey: `pk_test_${Buffer.from(`${DEFAULT_CLERK_HOST}$`).toString('base64url')}`,
  issuer: `https://${DEFAULT_CLERK_HOST}`,
  oauthCallbackOrigin: 'https://clerk.shared.lcl.dev',
});

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

function resolveClerkConfig(env = process.env, defaults = DEFAULT_CLERK_CONFIG) {
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
      ? (defaults.oauthCallbackOrigin || DEFAULT_CLERK_CONFIG.oauthCallbackOrigin)
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

module.exports = {
  DEFAULT_CLERK_CONFIG,
  exactHttpsOrigin,
  resolveClerkConfig,
  clerkClaimsProfile,
};
