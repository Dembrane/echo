# 0006 Identity with Better Auth

**Decision.** Better Auth runs inside the API on our Postgres: email and password (existing
argon2 hashes verified as they are, so nobody resets), email one-time codes, Google
sign-in, two-factor, organisations, and SSO over OIDC and SAML with SCIM for enterprise
customers. Memberships and roles stay in echo's own tables and the `access` package.

**Why.** An established, MIT-licensed library that covers today's sign-in and Robert's
BIO2 asks (OIDC/SAML SSO, SCIM, MFA) without a separate identity service.

**Against.** Young (v1.x, fast releases) compared with Keycloak. It owns its own session
and account tables; the guidelines want identity separated from tenancy, so Better Auth is
treated as the identity provider only and never decides access.
