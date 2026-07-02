---
title: Building on dembrane (external developers)
description: Self-host dembrane, integrate with its API, or contribute to the open-source project - start here.
audience: developer-external
---

# Building on dembrane

dembrane is open source. If you want to run it on your own infrastructure, point your own
language-model keys at it, integrate it with your systems, or contribute code, these pages
are for you.

dembrane captures, transcribes, and makes sense of spoken conversations at scale. The same
platform that powers the managed service at dembrane.com is the code you can clone, read, and
run yourself. Our core belief - *PEOPLE KNOW HOW* - applies to the codebase too: the
knowledge is in the room, and we'd rather surface it than gate it.


## What's open source

The dembrane repository (the "echo" codebase: dashboard, participant portal, FastAPI backend,
agent service, and Directus configuration) is published under the
*Business Source License 1.1 (BSL 1.1)*. In short:

- *Non-production use is unrestricted* - read it, run it locally, fork it, learn from it.
- *Production use is free* if your organisation's total finances are *at or below
  €1,000,000 over any rolling twelve-month period*.
- Each release's *Change Date* is its release date plus three years, after which that
  release converts to *GPLv3*.

If you're above the threshold and want to run dembrane in production, there's a commercial
licence. The full terms, the threshold, and who to contact are on the
[licensing](./licensing.md) page - read it before you deploy.

> [!NOTE]
> "ECHO" is the historical internal name of the platform feature and still appears in some
> file paths and older docs. The brand is dembrane. We use "dembrane", "the dashboard",
> and "the portal" throughout these guides.

## The three ways to run dembrane

1. *Managed SaaS* - dembrane.com hosts everything: the host dashboard at
   `dashboard.dembrane.com` and the participant portal at `portal.dembrane.com`. You bring
   nothing but a browser. This is the right choice for most teams; see
   [tiers & billing](../../features/tiers-and-billing.md).
2. *Open source, self-hosted* - you run the services yourself, on your own infrastructure,
   with your own database, object storage, and language-model providers. Start with
   [self-hosting](./self-hosting.md).
3. *Self-hosted with your own data location and providers* - the same as above, tuned for
   data residency (for example, EU-only regions and providers). See the EU residency notes in
   [self-hosting](./self-hosting.md) and [configuration & LLM providers](./configuration-and-llm-providers.md).

The managed service and the open-source code are the same product. Tier gating (for example,
which features need a Changemaker workspace) is a billing concept on the managed service; when
you self-host you operate the whole platform.

## The pages here

*Run it yourself*

- *[Self-hosting](./self-hosting.md)* - the services dembrane needs, the dev container,
  ports, environment files, and EU-residency options.
- *[Configuration & LLM providers](./configuration-and-llm-providers.md)* - wiring up
  language models with the LiteLLM router, transcription and embedding providers, EU regions,
  and feature toggles.
- *[Authentication](./authentication.md)* - how dembrane authenticates requests: Directus
  JWTs, static integration tokens, and the staff `admin_access` claim.

*Integrate with it*

- *[The participant API](./participant-api.md)* - the unauthenticated endpoints the portal
  uses to record conversations; the typical upload sequence.
- *[Webhooks](./webhooks.md)* - react to `conversation.*` and `report.generated` events in
  your own systems, with signature verification.
- *[Export & integrations](./export-and-integrations.md)* - pulling transcripts, reports,
  and CSV/Excel out of dembrane programmatically.
- *[MCP & bring-your-own-LLM](./mcp-and-byo-llm.md)* - the forthcoming way to connect your
  own assistant (ChatGPT, Claude) to your dembrane data.

*Contribute & licence*

- *[Licensing](./licensing.md)* - BSL 1.1 in full, the Change Date, and the commercial
  licence.
- *[Contributing](./contributing.md)* - how to send a pull request, the CLA, the code of
  conduct, and how to disclose a security issue.

## How it fits together (the short version)

Self-hosting means running a handful of services that talk to each other:

- a *FastAPI backend* on port `8000` (the `/api/*` and `/api/v2/*` routes);
- an *agent service* on port `8001` (agentic chat);
- *Directus* on port `8055` (the data, auth, and file layer);
- background *workers* and a *scheduler* (transcription, summaries, reports);
- the web frontend, serving the *dashboard* on `5173` and the *participant portal* on
  `5174`;
- and the infrastructure they depend on: *PostgreSQL with pgvector*, *Redis/Valkey*, and
  *S3-compatible object storage* (MinIO, DigitalOcean Spaces, AWS S3, …).

If you want the deep, code-level reference for any of these, the
[internal developer guides](../developer-internal/index.md) - for example
[architecture](../developer-internal/architecture.md) and the
[processing pipeline](../developer-internal/processing-pipeline.md) - go further than these
external guides do.

## Related

- [Self-hosting](./self-hosting.md)
- [Internal developer overview](../developer-internal/index.md)
- [Tiers & billing](../../features/tiers-and-billing.md)
- [Feature catalogue](../../features/index.md)
