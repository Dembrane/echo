---
title: Building on dembrane (external developers)
description: Integrate with dembrane through webhooks, MCP and export, run the code yourself, or contribute to the source-available repository. Start here.
audience: developer-external
---

# Building on dembrane

There are three things an outside developer can do with dembrane. Pick the one you came for.

| You want to | Start with |
|---|---|
| Get conversations, transcripts and reports into your own system | [Webhooks](./webhooks.md), [MCP](./mcp-and-byo-llm.md) or [export](./export-and-integrations.md) |
| Run the code on your own machines | [Self-hosting](./self-hosting.md) and [configuration](./configuration-and-llm-providers.md) |
| Fix or add something in the repository | [Contributing](./contributing.md) and [licensing](./licensing.md) |

## What you can rely on

dembrane has no published API reference. The API serves no OpenAPI document and no explorer page. These are the surfaces an integrator can build on, firmest first.

1. Webhooks. dembrane POSTs a JSON body to your URL when a conversation starts, is transcribed or is summarised, and when a report is generated. v3 kept the body and the signature byte for byte the same as before. See [webhooks](./webhooks.md).
2. MCP and its REST face. An assistant connects over OAuth and reads what one person can see. The token format, lifetimes and scopes are treated as a contract. See [MCP](./mcp-and-byo-llm.md).
3. The participant endpoints. The portal records through them and their paths and bodies are kept, but dembrane does not promise them as a public contract. See [the participant API](./participant-api.md).
4. Routes for a signed-in person, such as the transcript export. They work with a session. They are not built for unattended scripts. See [export](./export-and-integrations.md).

Everything else under `/api/*` and `/api/v2/*` exists for the dashboard and the portal. It is internal and can change in any release. Routes under `/api/v2/admin/*` are for dembrane staff.

## What does not exist

- No API keys, personal access tokens or static tokens. The credentials are a signed-in session, an OAuth token from MCP, and the participant token. See [authentication](./authentication.md).
- No API version negotiation. `/api/*` and `/api/v2/*` are two generations kept side by side.
- No browser calls from your own site. The API allows cross-origin calls with credentials from the dashboard and the portal only.

## What the platform is

dembrane v3 is five Bun apps on PostgreSQL. The source is in `dembrane/platform`, and the dashboard and participant portal are one React codebase in `dembrane/frontend`.

| App | What it does |
|---|---|
| `api` | The HTTP server for the dashboard, the portal and outside agents. |
| `worker` | Runs queued jobs and schedules: the audio pipeline, analysis, reports, emails. |
| `media` | An ffmpeg service that converts, splits and merges audio. |
| `web` | Serves the built dashboard and portal, and forwards `/api` to the API. |
| `migrate` | A one-shot job that runs before every rollout. |

PostgreSQL is the only stateful service the platform itself needs. Audio and files go to S3-compatible storage, language models run on Google Vertex AI, and email goes through SendGrid. The [architecture guide](../developer-internal/architecture.md) goes deeper.

## The licence in one line

The repository is source available under the Business Source License 1.1. That is not an open source licence. Read [licensing](./licensing.md) before you run dembrane in production.

## The pages here

- [Authentication](./authentication.md): the three credentials and who uses which.
- [Webhooks](./webhooks.md): events, payloads, the signature, retries.
- [MCP & bring-your-own-LLM](./mcp-and-byo-llm.md): the address, the OAuth flow, the tools.
- [Export & integrations](./export-and-integrations.md): the routes that move data out.
- [The participant API](./participant-api.md): the endpoints behind the recorder.
- [Self-hosting](./self-hosting.md): what the platform needs, the local setup, and what is not supported.
- [Configuration & LLM providers](./configuration-and-llm-providers.md): the settings, and the one model provider.
- [Licensing](./licensing.md): the terms as the `LICENSE` file states them.
- [Contributing](./contributing.md): pull requests, the contributor agreement, translations.

## Related

- [Architecture](../developer-internal/architecture.md)
- [Internal developer overview](../developer-internal/index.md)
- [Webhooks & integrations (feature)](../../features/webhooks-and-integrations.md)
- [Feature catalogue](../../features/index.md)
