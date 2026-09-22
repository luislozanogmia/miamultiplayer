import assert from 'node:assert/strict';
import test from 'node:test';
import config from './clerk-config.js';

function publishableKey(environment, hostname) {
  return `pk_${environment}_${Buffer.from(`${hostname}$`).toString('base64url')}`;
}

test('Clerk development defaults retain Mia issuer and shared OAuth callback', () => {
  const resolved = config.resolveClerkConfig({});
  assert.equal(resolved.environment, 'development');
  assert.equal(resolved.issuer, config.DEFAULT_CLERK_CONFIG.issuer);
  assert.equal(resolved.oauthCallbackOrigin, 'https://clerk.shared.lcl.dev');
});

test('complete production tuple uses one exact FAPI origin for issuer and OAuth callback', () => {
  const resolved = config.resolveClerkConfig({
    CLERK_PUBLISHABLE_KEY: publishableKey('live', 'clerk.example.com'),
    CLERK_JWT_KEY: 'public-key-fixture',
    CLERK_ISSUER: 'https://clerk.example.com',
  });
  assert.equal(resolved.environment, 'production');
  assert.equal(resolved.issuerOrigin, 'https://clerk.example.com');
  assert.equal(resolved.oauthCallbackOrigin, 'https://clerk.example.com');
});

test('custom development tuple retains Clerk shared OAuth callback unless explicitly overridden', () => {
  const env = {
    CLERK_PUBLISHABLE_KEY: publishableKey('test', 'custom.clerk.accounts.dev'),
    CLERK_JWT_KEY: 'public-key-fixture',
    CLERK_ISSUER: 'https://custom.clerk.accounts.dev',
  };
  assert.equal(config.resolveClerkConfig(env).oauthCallbackOrigin, 'https://clerk.shared.lcl.dev');
  assert.equal(config.resolveClerkConfig({
    ...env,
    CLERK_OAUTH_CALLBACK_ORIGIN: 'https://callback.example.test',
  }).oauthCallbackOrigin, 'https://callback.example.test');
});

test('partial or mixed Clerk tuples fail closed', () => {
  assert.throws(
    () => config.resolveClerkConfig({ CLERK_PUBLISHABLE_KEY: publishableKey('live', 'clerk.example.com') }),
    /configuration is incomplete.*CLERK_JWT_KEY, CLERK_ISSUER/,
  );
  assert.throws(
    () => config.resolveClerkConfig({
      CLERK_PUBLISHABLE_KEY: publishableKey('live', 'clerk.other.test'),
      CLERK_JWT_KEY: 'public-key-fixture',
      CLERK_ISSUER: 'https://clerk.example.com',
    }),
    /same Clerk Frontend API host/,
  );
  assert.throws(
    () => config.resolveClerkConfig({
      CLERK_PUBLISHABLE_KEY: publishableKey('live', 'clerk.example.com'),
      CLERK_JWT_KEY: 'public-key-fixture',
      CLERK_ISSUER: 'https://clerk.example.com/path',
    }),
    /without a path/,
  );
});

test('verified Clerk claims require exact issuer, subject, and primaryEmail', () => {
  const issuer = 'https://clerk.example.com';
  assert.deepEqual(config.clerkClaimsProfile({
    iss: issuer,
    sub: 'user_123',
    primaryEmail: ' Person@Example.com ',
    fullName: ' Person Example ',
  }, issuer), {
    subject: 'user_123',
    primaryEmail: 'person@example.com',
    displayName: 'Person Example',
  });
  assert.equal(config.clerkClaimsProfile({ iss: 'https://attacker.test', sub: 'user_123', primaryEmail: 'a@b.test' }, issuer).error, 'clerk_token_invalid');
  assert.equal(config.clerkClaimsProfile({ iss: issuer, sub: '', primaryEmail: 'a@b.test' }, issuer).error, 'clerk_token_invalid');
  assert.equal(config.clerkClaimsProfile({ iss: issuer, sub: 'user_123' }, issuer).error, 'clerk_primary_email_missing');
  assert.equal(config.clerkClaimsProfile({
    iss: issuer,
    sub: 'user_123',
    primaryEmail: 'a@b.test',
  }, issuer).displayName, '');
});

function unsignedJwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
}

test('browser Clerk tokens with azp must match the requesting origin', () => {
  const trustedOrigins = new Set(['http://localhost:4871']);
  const token = unsignedJwt({ azp: 'http://localhost:4871', sub: 'user_123' });
  assert.deepEqual(config.clerkVerifyOptions(token, { jwtKey: 'key', requestOrigin: 'http://localhost:4871', trustedOrigins }), {
    options: { jwtKey: 'key', authorizedParties: ['http://localhost:4871'] },
  });
  assert.deepEqual(config.clerkVerifyOptions(token, { jwtKey: 'key', requestOrigin: '', trustedOrigins }).options.authorizedParties, ['http://localhost:4871']);
});

test('native Clerk tokens without azp are accepted only from a trusted Mia origin', () => {
  const trustedOrigins = new Set(['http://localhost:4871']);
  const token = unsignedJwt({ sub: 'user_123' });
  assert.deepEqual(config.clerkVerifyOptions(token, { jwtKey: 'key', requestOrigin: 'http://localhost:4871', trustedOrigins }), {
    options: { jwtKey: 'key' },
    native: true,
  });
  assert.equal(config.clerkVerifyOptions(token, { jwtKey: 'key', requestOrigin: 'https://attacker.test', trustedOrigins }).error, 'clerk_token_invalid');
  assert.equal(config.clerkVerifyOptions(token, { jwtKey: 'key', requestOrigin: '', trustedOrigins }).error, 'clerk_token_invalid');
  assert.equal(config.clerkVerifyOptions('not-a-jwt', { jwtKey: 'key', requestOrigin: 'http://localhost:4871', trustedOrigins }).error, 'clerk_token_invalid');
});
