---
title: Self-hosting dembrane
description: The services dembrane needs, the dev container, ports, environment files, and EU-residency options for running it yourself.
audience: developer-external
---

# Self-hosting dembrane

Running dembrane yourself means standing up a small set of services and pointing them at your
own database, object storage, and language-model providers. This page is the orientation: the
moving parts, how to bring them up locally, the ports they listen on, and where the
configuration lives.

> [!NOTE]
> Read the [licensing](./licensing.md) terms before you run dembrane in production. The code
> is BSL 1.1: non-production use is unrestricted; production use is free below the €1M finance
> threshold and otherwise needs a commercial licence.

## When you'd self-host

- You need your data and audio to stay on infrastructure you control, in a region you choose.
- You want to bring your own language-model providers (your own keys, your own regions) rather
  than use the managed defaults.
- You're contributing to the project and need it running locally - see
  [contributing](./contributing.md).

If none of those apply, the [managed service](../../features/tiers-and-billing.md) at
dembrane.com saves you the operational work.

## The services you'll run

dembrane is a handful of cooperating services. You run all of them.

| Service | Port | What it does |
|---|---|---|
| *FastAPI backend* | `8000` | The API: v1 routes under `/api/*`, v2 under `/api/v2/*`, plus the BFF layer `api/v2/bff/*`. |
| *Agent service* | `8001` | Agentic chat (tool-using "Ask"); leases coordinated in Redis. |
| *Directus* | `8055` | The data layer, authentication, and file storage. |
| *Workers* (`network`, `cpu`) | - | Background jobs via Dramatiq: transcription, merge, summaries, reports. |
| *Scheduler* | - | APScheduler dispatching periodic jobs (billing, digests, reconciliation) to the workers. |
| *Dashboard* (web) | `5173` | The host dashboard frontend. |
| *Participant portal* (web) | `5174` | The no-account recording experience. |

The dashboard and the portal are the *same frontend codebase*; it picks the right router by
hostname, which is why they're two ports in development.

For a code-level tour of how these fit together, see the internal
[architecture](../developer-internal/architecture.md) and
[background jobs & scheduler](../developer-internal/background-jobs-and-scheduler.md) guides.

## Backing infrastructure

These are the dependencies the services need. You can run them in the dev container, on your
own boxes, or as managed cloud services.

- *PostgreSQL with the `pgvector` extension* - the primary database. pgvector is required;
  embeddings for chat and analysis are stored as vectors.
- *Redis or Valkey* - the message broker for the workers, distributed locks for idempotency,
  the agent service's leases, and the pub/sub channel that drives live (SSE) progress updates.
  Valkey is a drop-in Redis replacement and is what the managed deployment uses.
- *S3-compatible object storage* - for audio chunks and generated files. Bring your own
  bucket (AWS S3, DigitalOcean Spaces, OVHcloud, …) or run *MinIO* locally.
- *Language-model providers* - at minimum a set of keys for the model groups dembrane uses.
  See [configuration & LLM providers](./configuration-and-llm-providers.md).
- *A transcription provider* - AssemblyAI, or a transcription model routed through LiteLLM.

## Running it locally: the dev container + mprocs

The repository ships a *dev container* (under `.devcontainer/`) that provisions the tooling
and local infrastructure for you: `pnpm` and `uv` for the JavaScript and Python toolchains,
plus local *PostgreSQL*, *Valkey*, and *Directus*. Opening the repo in a
dev-container-aware editor builds it once and drops you into a ready environment.

Inside the container, the services are orchestrated with `mprocs`, driven by
`mprocs.yaml`. A single `mprocs` invocation brings up:

- `server` - the FastAPI backend (`8000`);
- `workers` - the `network` queue (gevent, for async I/O like transcription and summaries);
- `workers-cpu` - the `cpu` queue;
- `scheduler` - the periodic-job dispatcher;
- `admin-dashboard` - the host dashboard on `5173`;
- `participant-portal` - the portal on `5174`.

`mprocs` gives you one pane per process, so you can read each service's logs and restart any
one of them independently. The internal
[local development](../developer-internal/local-development.md) guide covers the day-to-day
workflow in more detail.

> [!TIP]
> Bring your own S3, or run MinIO locally. If you point `STORAGE_S3_*` at a MinIO instance
> in the same network, the participant upload flow (presigned URLs → confirm) works exactly as
> it does in production. See [the participant API](./participant-api.md) for that sequence.

## Configuration: environment files

Configuration is by environment variable, split across the services:

- `server/.env` - the backend, workers, and scheduler. Copy from `server/.env.sample`
  and fill in: the database URL, the Redis/Valkey URL, the S3 credentials and endpoint, the
  language-model keys (the `LLM__*` scheme - see
  [configuration & LLM providers](./configuration-and-llm-providers.md)), the transcription
  provider keys, and the Directus connection.
- `directus/.env` - Directus's own configuration: its database, secret/keys, admin
  credentials, and storage driver.

Keep secrets out of version control. The `.env.sample` files are the canonical list of what
each service expects; treat them as the source of truth when a variable here and the code
disagree.

> [!IMPORTANT]
> Directus owns authentication and file storage. The backend talks to Directus for both, so
> the two services must agree on their shared secrets and connection details. How the backend
> trusts Directus-issued tokens is covered in [authentication](./authentication.md).

## A first-run checklist

1. Provision PostgreSQL *with pgvector*, Redis/Valkey, and an S3 bucket (or MinIO).
2. Copy `server/.env.sample` → `server/.env` and `directus/.env` and fill them in.
3. Configure at least one deployment per language-model group and a transcription provider - 
   see [configuration & LLM providers](./configuration-and-llm-providers.md).
4. Bring up Directus (`8055`) and apply its schema/migrations.
5. Start the backend (`8000`), the workers, and the scheduler.
6. Start the dashboard (`5173`) and the portal (`5174`).
7. Set `SERVE_API_DOCS=1` while you're integrating, so the OpenAPI explorer is available at
   `/docs` and `/redoc`. See [the participant API](./participant-api.md).

## EU residency

dembrane is built and operated with European data residency in mind, and the self-hosted stack
can be configured the same way. The levers:

- *Language models in EU regions.* Route every model group through EU-hosted deployments - 
  for example Google Vertex AI in `europe-west1` / `europe-west4`, or Azure OpenAI in West
  Europe / Sweden Central. The per-group, per-region scheme is in
  [configuration & LLM providers](./configuration-and-llm-providers.md).
- *EU object storage.* Point the S3 configuration at an EU bucket/endpoint (for example an
  OVHcloud or EU-region Spaces bucket).
- *EU transactional email.* If you wire up outbound email, use an EU sub-user/region (for
  example a SendGrid EU sub-user).
- *EU database and Redis.* Run PostgreSQL and Valkey in your chosen region.

> [!NOTE]
> On the managed service, the fully *EU-sovereign* stack (CLOUD-Act-safe hosting and
> sovereign models) is the *Guardian* tier and is *coming soon*. When you self-host you
> assemble residency from your own choice of regions and providers; the configuration scheme
> is designed to make that straightforward. See
> [tiers & billing](../../features/tiers-and-billing.md) and
> [data ownership & compliance](../../features/data-ownership-and-compliance.md).

## Related

- [Configuration & LLM providers](./configuration-and-llm-providers.md)
- [Authentication](./authentication.md)
- [The participant API](./participant-api.md)
- [Internal: architecture](../developer-internal/architecture.md)
- [Internal: local development](../developer-internal/local-development.md)
- [Licensing](./licensing.md)
