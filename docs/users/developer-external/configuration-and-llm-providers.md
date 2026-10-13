---
title: Configuration & LLM providers
description: How dembrane reads its settings, which ones a self-hoster must set, and the one language model provider it supports, Google Vertex AI.
audience: developer-external
---

# Configuration & LLM providers

This page is for people who run dembrane themselves. Two things to know first:

- Every setting is an environment variable, declared once in `dembrane/platform/packages/config/src/schema.ts`. That file is the full list, with a description of each key.
- Language models run on Google Vertex AI only. You cannot bring another provider through configuration.

## How a value is resolved

A value comes from three places. A later one wins.

1. The default in the schema.
2. The environment file for the `APP_ENV` in use.
3. The process environment.

- `APP_ENV` must be `local`, `test`, `preview`, `staging` or `prod`. Each name loads a checked-in file in `packages/config/environments/` that holds dembrane's own values: URLs, a cookie domain, a Google Cloud project. There is no neutral "self-hosted" environment, so you override those values with environment variables.
- A secret comes from the process environment only. A secret in an environment file stops the boot.
- Config is validated at boot. Every problem is shown in one error and the process does not start.
- The effective config is logged at start. A secret shows only as set or unset.

To see what an environment resolves to, with secrets hidden:

```sh
cd dembrane/platform
bun run config show <env>
```

`bun run config diff <env> <env>` shows what differs between two environments, and `bun run config secrets <env>` lists the secrets an environment must receive.

## Settings you must set

| Variable | Purpose |
|---|---|
| `APP_ENV` | Which environment file applies. |
| `DATABASE_URL` | The runtime Postgres login. It needs no rights to change the schema. |
| `MIGRATION_DATABASE_URL` | The owner login, for the migrate job only. |
| `AUTH_SECRET` | Signs sessions and tokens. At least 32 characters. |
| `INVITE_HASH_SECRET` | Signs invite links. At least 16 characters. |
| `API_PUBLIC_URL`, `DASHBOARD_URL`, `PORTAL_URL` | The three public origins. |
| `AUTH_COOKIE_DOMAIN` | The parent domain the three origins share, when they share one. |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_KEY`, `STORAGE_S3_SECRET` | The audio bucket. |
| `FILES_S3_ENDPOINT`, `FILES_S3_BUCKET`, `FILES_S3_REGION`, `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` | The files bucket: avatars, logos, documents. |
| `LLM_VERTEX_PROJECT` | The Google Cloud project billed for model calls. |
| `SENDGRID_API_KEY`, `SENDGRID_REGION`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | Email. |
| `MEDIA_URL`, `MEDIA_AUTH` | The media service, unless ffmpeg runs inside the API and the worker. |
| `WEB_ROLE`, `WEB_API_ORIGIN`, `WEB_DIST_DIR` | The web app. |
| `PORT` | The listening port. The default is 8080. |

Also useful:

- `APP_DB_ROLE` makes the migrate job grant data rights to that database role.
- `DATABASE_POOL_MAX` (default 10) and `DATABASE_QUEUE_POOL_MAX` (default 4) size the connection pools of each instance.
- `HTTP_TRUSTED_PROXIES` and `HTTP_PROXY_SECRET` tell the API which proxies to trust when it reads the caller's address.
- `ASSETS_ROOT` (default `/app/assets`) is where a compiled binary finds the files it reads at run time.
- `LOG_LEVEL` (default `info`). Logs are JSON on stdout.
- `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` turn on Google sign-in.
- `MOLLIE_API_KEY` turns on paid checkout. Unset, checkout is off.

## Language models

dembrane supports one provider: Google Vertex AI. Transcription, summaries, Ask, reports and analysis all call it.

### What you set

| Variable | Default | What it is |
|---|---|---|
| `LLM_VERTEX_PROJECT` | dembrane's own project | Your Google Cloud project. Set this. |
| `LLM_VERTEX_LOCATION` | `eu` | The Vertex location. `eu` is the EU data residency endpoint. |
| `LLM_TEXT_FAST` | `gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash` | The `text_fast` group. |
| `LLM_MULTI_MODAL_FAST` | the same list | The `multi_modal_fast` group. |
| `LLM_MULTI_MODAL_PRO` | the same list | The `multi_modal_pro` group. |
| `EMBEDDING_MODEL` | `text-embedding-004` | The embedding model. |
| `EMBEDDING_LOCATION` | `europe-west4` | Embedding models are regional on Vertex. |
| `EMBEDDING_DIMENSIONS` | `768` | The vector size the embedding model returns. |

### Credentials

There is no API key setting for models. The code passes a project and a location, and Google's application default credentials do the rest: a key file, gcloud's file, or a metadata server.

### Groups

A feature asks for a group, never for a model name. Each group is a comma-separated list of Vertex model ids, tried in order.

| Use | Group |
|---|---|
| Transcription | `multi_modal_pro`, then `multi_modal_fast` on a retryable error |
| Conversation summary and title, participant replies, verification | `multi_modal_pro` |
| Reports | `multi_modal_pro`, and `multi_modal_fast` for summaries |
| Chat replies | `multi_modal_pro` |
| Chat suggestions, analysis, popcorn, canvases | `multi_modal_fast` |
| The chat assistant | `AGENTIC_MODEL_GROUP`, default `multi_modal_pro` |
| Translation of interface texts | `text_fast` |

### Fallback

Inside a group, each model gets 2 attempts before the next one is tried. Only rate limits, overload, server errors and network failures move on to the next model. A bad request does not. A model that fails 3 times within 60 seconds goes to the back of the order for that window. `text_fast` falls back to the `multi_modal_pro` list after its own.

### What you cannot change

- The provider. There is no setting for OpenAI, Azure, a local model or any other provider, and no code path for one.
- You can choose which Vertex models each group uses, and which Google Cloud project and location they run in. That is all.

To use your own assistant with dembrane data, connect it over [MCP](./mcp-and-byo-llm.md). The assistant then brings its own model and reads dembrane through tools.

## Email

Email goes through SendGrid. There is no SMTP option.

- `SENDGRID_REGION` is `eu` (the default, which needs an EU key) or `global`.
- `EMAIL_FROM` and `EMAIL_FROM_NAME` default to dembrane's own sender. Set your own.
- Without `SENDGRID_API_KEY` no email is sent. That is how local development runs.

## Where data is processed

The defaults keep processing in the EU: `LLM_VERTEX_LOCATION=eu`, `EMBEDDING_LOCATION=europe-west4` and `SENDGRID_REGION=eu`. Traces are exported only when you set `OTEL_EXPORTER_OTLP_ENDPOINT`. Where your database and your buckets are is your choice.

## Feature switches

| Variable | Default | What it does |
|---|---|---|
| `ENABLE_WEBHOOKS` | on | The global switch for project webhooks. |
| `ENABLE_MONITOR` | on | The live participant monitor. |
| `ENABLE_PRESENT` | on | The switch for Present. Off hides host edits of analysis results. |
| `ENABLE_CANVAS` | on | Canvases. A project still opts in. |
| `BILLING_CUSTOMER_JOBS` | `off` | Whether scheduled billing jobs may email customers or change their plan. |

## Settings that no longer exist

If you carry an environment file from an older install, these do nothing in v3: `LLM__<GROUP>__*`, `TRANSCRIPTION_PROVIDER`, `GCP_SA_JSON`, `GEMINI_API_KEY`, `SERVE_API_DOCS`, `DISABLE_REDACTION`, `ENABLE_CHAT_AUTO_SELECT`, `ENABLE_AUDIO_LIGHTRAG_INPUT`, `LIGHTRAG_*`, `DIRECTUS_TOKEN` and every Redis setting.

## Related

- [Self-hosting](./self-hosting.md)
- [Authentication](./authentication.md)
- [MCP & bring-your-own-LLM](./mcp-and-byo-llm.md)
- [Webhooks](./webhooks.md)
- [Transcription](../../features/transcription.md)
