# Clerk production configuration

This repository contains production configuration plumbing, not a configured or live-verified Clerk production instance. Do not commit real values. Store the three public identifiers in the install's ignored `.env.local` file:

```dotenv
CLERK_PUBLISHABLE_KEY=<production-publishable-key-from-Clerk>
CLERK_ISSUER=https://<exact-Clerk-Frontend-API-origin>
CLERK_JWT_KEY="-----BEGIN PUBLIC KEY-----\n<from-Clerk>\n-----END PUBLIC KEY-----"
```

All three overrides are one atomic tuple. Startup rejects partial tuples, non-HTTPS/path-bearing issuers, and publishable keys whose encoded Frontend API host does not match `CLERK_ISSUER`. The configured exact issuer is added to both the HTTP CSP header and the served `index.html` CSP meta policy. Production Google OAuth navigation accepts only `<CLERK_ISSUER>/v1/oauth_callback`; use `CLERK_OAUTH_CALLBACK_ORIGIN` only if Clerk shows a different exact callback origin. Development instances retain `https://clerk.shared.lcl.dev`.

## Dashboard and infrastructure checklist

1. Create or select the production Clerk instance. This is a separate user store. Mia currently has one test account and intentionally provides no user migration feature.
2. Configure and verify the production domain and Clerk Frontend API DNS records. Copy the exact publishable key, Frontend API origin, and JWT public key from that same instance.
3. Configure the session-token template to include `primaryEmail` and `fullName`. Mia rejects tokens without a usable `primaryEmail`; `fullName` supplies the local display name when present.
4. Enable the intended sign-in methods and configure the Google OAuth credentials/callbacks shown by Clerk. Do not infer the callback host from this document.
5. Configure the Clerk instance `allowedOrigins` for every browser-like client origin used by the deployment.
6. Update the external managed router to verify the production issuer/JWKS and authorized-party contract before sending it a production session token. This repository does not mutate that AWS service.
7. In a disposable profile, verify logged-out rendering, email sign-in, Google sign-in, token exchange, wrong issuer, missing email, logout, relaunch, and managed-router provisioning. Record the exact origin, issuer, and callback observed. Only then describe the integration as live verified.

## Electron production boundary

Clerk's documentation says Electron's request origin must be present in the instance `allowedOrigins`. It also says production publishable keys are normally restricted to the configured HTTPS production domain and that localhost production-key testing is unsupported. Mia currently serves its Electron renderer from `http://localhost:<free-port>`; it starts after the preferred port and advances when occupied. Therefore a single assumed localhost origin is not a valid production contract, and this groundwork does not claim that a standard production-domain Clerk instance can authenticate from the desktop shell.

Before release, validate the real production instance with Clerk support or choose an explicitly approved desktop architecture, such as a stable verified HTTPS origin or a supported native flow. Do not weaken CSP/navigation matching, wildcard callback hosts, pin an unverified port, enable the Native API, or introduce a proxy as an implicit workaround.

Official references:

- [Clerk Backend Instance `allowedOrigins`](https://clerk.com/docs/reference/backend/types/backend-instance)
- [Using production keys in local development](https://clerk.com/docs/guides/development/troubleshooting/using-production-keys-in-development)
- [Development and production session architecture](https://clerk.com/docs/guides/development/managing-environments)
- [Manual JWT verification and authorized parties](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
