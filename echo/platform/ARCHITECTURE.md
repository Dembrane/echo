# echo platform

The Bun/TypeScript replacement for echo's Python server, Directus and agent service. One
codebase, a few processes, Postgres as the only stateful dependency. It follows
[baristaze/swe_guidelines](https://github.com/baristaze/swe_guidelines) where they fit a
Bun + Cloud Run system; each deviation is a decision record in `docs/decisions/`.

## Processes

| App | Runs | Scales on |
|---|---|---|
| `apps/api` | HTTP: dashboard, portal, iOS app, MCP, webhooks in | requests (Cloud Run service) |
| `apps/worker` | pg-boss consumers, schedules, agent runs, sweeps | always on, CPU allocated (Cloud Run worker pool) |
| `apps/web` | the React frontend, served as static files | requests |
| migrations | `packages/db/src/migrate.ts` before every rollout | Cloud Run job |

Web services never do background work. Anything slower than a request is a job.

## Packages

Two kinds, one direction of dependency: apps compose namespaces, namespaces use
capabilities, capabilities use nothing above them.

**Capabilities** (no business rules): `config`, `observability`, `db`, `core` (errors,
ids, operation context), `auth` (Better Auth), `access` (roles and policies, one resolver),
`queue` (pg-boss), `mail`, `storage` (object storage), `llm` (model groups with fallback),
`transcription`, `audio` (ffmpeg), `billing` (Mollie), `analytics` (PostHog), `webhooks`,
`flags`, `realtime` (LISTEN/NOTIFY to SSE).

**Namespaces** (one per product area): `orgs`, `workspaces`, `projects`, `conversations`,
`portal`, `chats`, `agentic`, `reports`, `library`, `verify`, `analysis`, `map`, `canvas`,
`popcorn`, `present`, `webhooks-out`, `agent-access` (MCP), `staff`.

Every namespace has the same shape:

```
packages/<ns>/src/
  routes.ts     Hono sub-app, zod request and response schemas, no business logic
  service.ts    the operations; first argument is always the operation context
  storage.ts    Drizzle queries; every method takes the tenant scope first
  jobs.ts       pg-boss handlers, idempotent on a key the producer sets
  index.ts      what other packages may import
```

## Rules that hold everywhere

- **Access is decided once.** `access` resolves who the caller is and what they may do on
  which resource before a service runs. Routes declare the permission they need; nothing
  checks access by hand. Default deny: a route without a declaration does not register.
- **Today's roles and policies stay compatible.** The Directus roles (Administrator,
  Enterprise User, Read-Only, Basic User), org, workspace and project memberships map one
  to one onto `access`. Holes found on the way get a named fix and a test.
- **One error shape.** Services throw `PlatformError` subclasses; one handler turns them
  into the response envelope. Routes never build error responses.
- **Jobs commit with their cause.** Enqueueing happens in the same transaction as the
  write that causes it, so "row written, job lost" cannot happen.
- **Config is declared.** Code reads `config.<section>.<key>`; see `packages/config`.
- **Every request and job is traceable.** JSON logs carry the request id, the trace link
  and, for jobs, the request that caused them.
- **Every package states its health.** Each capability and namespace exports its signals
  (queue depth, failure rate, latency) and the alert that fires when one is off, so sam can
  operate the system and propose fixes from the same signals people read.

## Proving it is 1:1

`parity/` runs the same scenario against the Python API and the Bun API, each starting
from an identical Postgres template database, and compares the HTTP response and the rows
the request changed. A namespace is migrated when its scenarios match. The scenarios then
stay as the new API's regression suite.

## Schema

`packages/db` holds the baseline (echo main, corrected introspection) and the migration
chain. `scripts/schema-roundtrip.sh` proves the chain rebuilds the schema exactly.
Migrations are expand then contract: each one works with the release before it.
