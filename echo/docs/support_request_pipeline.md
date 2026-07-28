# Support request pipeline (assistant → sam → #gen-engineering)

How a host's support request travels from the agentic chat to a triaged
thread in Slack, and what each side guarantees. Built 2026-07-24
(ISSUE-034, founder direction in the release-k-01-02 chat-trim thread).
The user-facing description lives in the docs site
(`echo-user-docs/pages/*/echo/first-aid.mdx`, "Asking the assistant for
help").

Not to be confused with the staff workspace-access feature
(`staff_support_access.md`, ECHO-863) — that also reads `support_request`
rows, but for consented staff access, not this outbox.

## The pipeline

```
host ──chat──▶ assistant ──reachOutToDembraneSupport──▶ support_request row
                                                        (status=new, outbox)
        task_forward_support_requests (worker, */2 cron)
              filter: status=new AND forwarded_at IS NULL
                              │ POST (X-Echo-Support-Token)
                              ▼
        sam's public edge fn ──IAM──▶ sam's private /echo/support-webhook
                              │ validate token, dedupe by id
                              ▼
        deterministic post in #gen-engineering  ←── happens in the HTTP
                              │                     handler, before any
                              ▼                     model session
        sam triage session in the thread (read-only DB access,
        answer / Linear ticket / proposed data fix)
```

## Delivery semantics (why hosts can be told "logged for the team")

- **At-least-once**: the forwarder stamps `forwarded_at` only after a 2xx.
  Crash, restart, or non-2xx → the row re-forwards next run. Sam dedupes
  by `support_request.id`, so redelivery never double-posts.
- **Deterministic delivery**: the #gen-engineering post happens in sam's
  HTTP handler itself — model judgment is never between a request and the
  team seeing it.
- **Response codes** (forwarder behaviour): `2xx` delivered or duplicate →
  stamp; `4xx` payload/config bug → log loudly, leave unstamped, continue
  with the next row; `5xx`/network → receiver down, stop the batch, next
  cron run retries.
- **No transcript content** ever leaves echo in a support request — the
  payload carries the host's message, page context, and opaque ids only.

## Payload contract

Mirrored in `Dembrane/sam` `src/recipes/product-support/recipe.md` — keep
both ends in sync. Every field optional except `id`, `environment`,
`message`:

```json
{
  "id": "…", "environment": "production | echo-next", "message": "…",
  "origin_link": "…", "page_context": "…", "created_at": "…",
  "chat_id": "…", "project_id": "…", "workspace_id": "…", "org_id": "…",
  "app_user_id": "…", "directus_user_id": "…"
}
```

`environment` and `origin_link` derive from `ADMIN_BASE_URL`'s host in
code — no per-env env var. `org_id` is a workspace→org hop at forward
time (support_request has no org column).

## Code map (this repo)

| Piece | Where |
|---|---|
| Tool + outbox write | `server/dembrane/api/agentic.py::create_support_request` |
| Forwarder actor | `server/dembrane/tasks.py::task_forward_support_requests` |
| Schedule (*/2) | `server/dembrane/scheduler.py` |
| Config | `server/dembrane/settings.py::SupportSettings` |
| Column migration | `directus/migrations/add_support_request_forwarded_at.py` |
| Tests | `server/tests/test_support_request_forwarder.py` |

Receiving side: `Dembrane/sam` — `src/runtime/echo_support.py` (pure
primitives), `daemon._handle_echo_support_webhook` (route),
`functions/echo-support-webhook-proxy/` (public edge),
`src/recipes/product-support/` (triage procedure).

## Configuration & enablement (per environment)

The forwarder no-ops unless BOTH are set (local default = off):

- `SUPPORT_WEBHOOK_URL` — sam's edge function
  (`https://europe-west1-dembrane-sameer-cli.cloudfunctions.net/echo-support-webhook-proxy`,
  same URL for every environment; the payload's `environment` field
  distinguishes senders). Plain config: `common.env` in the env's helm
  values in echo-gitops + the `commonEnvVars` render block.
- `ECHO_SUPPORT_WEBHOOK_TOKEN` — shared static token, sent in the
  `X-Echo-Support-Token` header (NOT `Authorization`; sam's ingress uses
  that for its GCP IAM layer). Sealed secret (`echo-backend-secrets`,
  `optional: true` — pods start fine without it). The same value lives in
  sam's GCP Secret Manager; rotate both together
  (`gcloud secrets versions access latest --secret=ECHO_SUPPORT_WEBHOOK_TOKEN`
  in sam's project, then reseal here).

**Enablement order for a new environment** (echo-next done 2026-07-24;
production pending):

1. Run `directus/migrations/add_support_request_forwarded_at.py` against
   the env's Directus (idempotent; `--token` works with the env's
   `DIRECTUS_ADMIN_TOKEN`). Setting the env vars first would crash the
   forwarder every run on the missing column.
2. Seal the token into the env's `echo-backend-secrets` (already done for
   BOTH dev and prod).
3. Set `SUPPORT_WEBHOOK_URL` in the env's helm values (done for
   echo-next; **this is the one remaining step for production**, after
   its migration).
4. Deploy a server image that contains the forwarder.

## Out of scope (deliberate)

- Two-way sync: sam does not update `support_request.status` from Slack.
- Auto-resolution without a human in #gen-engineering.
- The `agent_insight` stream is NOT carried by this webhook — sam digests
  it read-only from the DB directly (09:00 daily).
