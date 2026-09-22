# Clerk production configuration

Mia ships two built-in Clerk instances in `backend/clerk-config.js`: **production** (the default) and **test** (Mia's development instance). Set `MIAOS_CLERK_INSTANCE=test` in the environment or the install's `.env.local` to use the test instance; `scripts/dev_mode.sh` does this for dev runs. Their values are public identifiers (publishable key, issuer, JWKS public key). Full production readiness still requires the lifecycle checks below; a rendered sign-in screen is not sufficient.

Each install records which instance its Clerk link belongs to. Clerk instances are separate user stores, so after switching instances the first successful sign-in relinks the install (audit action `clerk.installation.relink`) instead of failing with "already linked". Links created before the issuer was recorded are treated as test-instance links.

A fork uses its own instance by storing a complete override tuple in the install's ignored `.env.local` file (it takes precedence over `MIAOS_CLERK_INSTANCE`):

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

Clerk explicitly supports browser-like Electron origins through the instance `allowedOrigins` setting. This is distinct from using production keys in an ordinary, unconfigured localhost website. Update the setting through the documented instance API, preserving existing entries; never ship the administrative API credential in Mia. The origin must match the actual renderer scheme, host, and port. An unbounded free-port fallback is not a production origin contract.

Production desktop startup uses exactly `MIAOS_PORT + 1` (default `http://localhost:4871`) and fails with an actionable error if occupied instead of choosing an unapproved origin. Development retains free-port selection. Changing `MIAOS_PORT` requires updating Clerk's allowed origins to match. Production does not implicitly adopt a service on the preferred port; an explicit `MIAOS_URL` remains an operator-selected external backend. The occupied-port behavior has automated coverage; manual production collision/relaunch verification remains pending.

On 2026-09-22, the disposable local desktop profile was verified at `http://localhost:4871`: adding that exact allowed origin removed Clerk's `origin_invalid` failure and the real Electron shell rendered the production sign-in form. A read-only `/v1/client` request from that origin returned 200; an unrelated HTTPS origin returned 400 `origin_invalid`. `/v1/environment` is cached and is not a reliable negative-origin test. This establishes origin bootstrap only, not successful authentication, session persistence, or router provisioning.

Google OAuth is a separate release gate: the current Electron popup uses an embedded browser and a Chrome-identity shim. Google's OAuth policy prohibits developer-controlled embedded user-agents. Successful popup rendering does not establish a production-supported Google flow. A supported external-browser return flow must be implemented and verified before claiming Google sign-in production ready; do not replace it with origin spoofing or disabled browser security.

Clerk's stable native SDK flow uses a native client JWT, a whitelisted redirect, and `rotating_token_nonce` to reload the initiating client. Calling `reload` with that nonce alone is not a verified shortcut for Mia's cookie-backed browser client: official adapters also change request transport and token persistence. Electron documents that custom-scheme callbacks on macOS/Linux require a packaged app, so a command-line development run cannot establish end-to-end callback acceptance.

On 2026-09-22, the live managed-router function's issuer allowlist was restricted to the production Clerk issuer, preserving its remaining environment settings. AWS reported the update successful, and the deployed endpoint still returned 401 for an unauthenticated provisioning request. A genuine production session's successful provisioning remains unverified. The production dashboard's session template was also inspected and contained the `fullName` and `primaryEmail` custom claims.

Keep the existing website waitlist intact. Do not change the entire shared instance's access mode merely to test an invited alpha user. Remaining live checks include token claims, invited-user sign-in, rejection of uninvited access, local exchange, router acceptance of the production issuer, restart persistence, logout, and independent security review.

Official references:

- [Clerk Backend Instance `allowedOrigins`](https://clerk.com/docs/reference/backend/types/backend-instance)
- [Clerk instance update API](https://clerk.com/docs/reference/backend/instance/update)
- [Google OAuth secure-browser policy](https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers)
- [Clerk native OAuth implementation](https://github.com/clerk/javascript/blob/main/packages/expo/src/hooks/useSSO.ts)
- [Electron deep-link packaging requirements](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app#packaging)
- [Using production keys in local development](https://clerk.com/docs/guides/development/troubleshooting/using-production-keys-in-development)
- [Development and production session architecture](https://clerk.com/docs/guides/development/managing-environments)
- [Manual JWT verification and authorized parties](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
