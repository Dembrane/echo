# 0005 Configuration is declared once

**Decision.** `packages/config`: one zod schema declares every key (type, default,
secrecy, browser visibility); one typed file per environment holds non-secret values;
secrets come only from Secret Manager. The CLI shows, diffs and checks it; CI fails on
invalid values or declared keys nothing reads. The frontend reads public config from
`/config.json`, so one build is promoted across environments.

**Why.** Today configuration lives in five places (hardcoded hostnames, sealed secrets,
Vercel, GitHub, two naming styles of env flags), and flags nothing reads survive for months.

**Against.** A small tool of our own to maintain. Hosted secret managers (Doppler,
Infisical Cloud) add a vendor holding secrets; self-hosted Infisical adds a service.
