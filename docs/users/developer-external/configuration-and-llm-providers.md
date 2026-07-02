---
title: Configuration & LLM providers
description: Wire up language models with the LiteLLM router, configure transcription and embeddings, choose EU regions, and set the key feature toggles.
audience: developer-external
---

# Configuration & LLM providers

When you [self-host dembrane](./self-hosting.md) you bring your own language models. dembrane
doesn't hard-code a provider: it routes every model call through a *LiteLLM router* that you
configure entirely with environment variables. This page covers that scheme, the transcription
and embedding configuration, choosing EU regions, and the feature toggles you'll most often
reach for.

> [!NOTE]
> The canonical, code-derived reference for these variables is `echo/docs/litellm_config.md`
> in the repository. This page explains the shape and the decisions; keep that file open
> alongside it for the exhaustive list and the startup-log examples.

## Model groups

Rather than naming a model per feature, dembrane groups model calls by capability. You
configure each *group*, and the code asks the router for the right group at the right time.

| Group | Used for | Audio |
|---|---|---|
| `MULTI_MODAL_PRO` | Chat, reports, replies, artifact generation (Gemini 2.5 Pro by default) | Yes |
| `MULTI_MODAL_FAST` | Realtime verification (Gemini 2.5 Flash) | Yes |
| `TEXT_FAST` | Summaries, chat streaming, auto-select (text only) | No |

`MULTI_MODAL_*` groups must be backed by models that accept *audio* input (Gemini does), as
they're used in the [processing pipeline](../developer-internal/processing-pipeline.md).
`TEXT_FAST` is text-only.

## The `LLM__<GROUP>[_n]__*` scheme

Each group has a *primary* deployment and any number of *fallback* deployments. The
variable name encodes the group, the (optional) deployment index, and the parameter:

```
LLM__<GROUP>__<PARAM>        # primary deployment
LLM__<GROUP>_<n>__<PARAM>    # fallback deployment n (1, 2, 3, …)
```

A minimal single-deployment group:

```bash
LLM__TEXT_FAST__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST__API_BASE=https://westeurope.openai.azure.com
LLM__TEXT_FAST__API_KEY=sk-azure-west-...
LLM__TEXT_FAST__API_VERSION=2024-02-15-preview
```

The exact set of `<PARAM>` keys depends on the provider - `MODEL`, `API_KEY`, `API_BASE`,
`API_VERSION` for OpenAI/Azure; `VERTEX_LOCATION`, `VERTEX_PROJECT`, `VERTEX_CREDENTIALS` for
Google Vertex AI, and so on. They map onto the parameters LiteLLM expects for that provider.

### Weighting and failover

Add numbered deployments to the same group and the router load-balances and fails over across
them automatically:

```bash
# Primary
LLM__TEXT_FAST__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST__API_BASE=https://westeurope.openai.azure.com
LLM__TEXT_FAST__API_KEY=sk-azure-west-...
LLM__TEXT_FAST__API_VERSION=2024-02-15-preview

# Fallback 1
LLM__TEXT_FAST_1__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST_1__API_BASE=https://swedencentral.openai.azure.com
LLM__TEXT_FAST_1__API_KEY=sk-azure-sweden-...
LLM__TEXT_FAST_1__API_VERSION=2024-02-15-preview

# Fallback 2
LLM__TEXT_FAST_2__MODEL=vertex_ai/gemini-2.0-flash
LLM__TEXT_FAST_2__VERTEX_LOCATION=europe-west1
LLM__TEXT_FAST_2__VERTEX_PROJECT=dembrane-prod
LLM__TEXT_FAST_2__VERTEX_CREDENTIALS=${GCP_SA_JSON}
```

- *Weight is inferred from the suffix.* The primary gets weight `10`, `_1` gets `9`, `_2`
  gets `8`, and so on. Higher-weighted deployments receive proportionally more traffic.
- *Retries:* three attempts with exponential backoff.
- *Cooldowns:* a deployment that fails three times is cooled down for 60 seconds, during
  which traffic shifts to the healthy deployments.
- *Distributed state:* the router shares its health/cooldown state via the same Redis/Valkey
  you configured for the workers, so all backend and worker processes agree.

At startup the backend logs a deployment summary - how many deployments each group has, their
models, regions, roles (primary/fallback), and weights. Read those lines first when a group
isn't behaving as expected; they tell you exactly what the router parsed from your environment.

## Transcription

Transcription is the first step of the [pipeline](../developer-internal/processing-pipeline.md).
You choose the provider:

- *AssemblyAI* - uploaded audio is transcribed by AssemblyAI (via webhook or polling).
  Configure its API key in `server/.env`.
- *A transcription model via LiteLLM* - route a speech-to-text model through the LiteLLM
  configuration instead.

After raw transcription, a Gemini correction pass applies your project's key terms (hotwords)
and PII redaction, producing a diarised transcript. That correction pass uses the
`MULTI_MODAL_*` groups, which is why those must support audio. See
[transcription](../../features/transcription.md) for the host-facing view.

## Embeddings

Chat and library analysis search over *embeddings* stored in pgvector. Configure an
embedding model (for example an Azure or Vertex embedding deployment) in `server/.env` - the
`LIGHTRAG_LITELLM_EMBEDDING_*` variables documented in `echo/docs/litellm_config.md`. Without
a working embedding model, retrieval-augmented [chat & Ask](../../features/chat-and-ask.md) has
nothing to retrieve over.

## EU regions

Because every deployment names its own region, residency is a configuration choice. A worked
EU-only example, mixing Azure and Vertex across European regions:

```bash
# TEXT_FAST: Azure West Europe (primary) + Sweden Central + Gemini EU
LLM__TEXT_FAST__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST__API_BASE=https://westeurope.openai.azure.com
LLM__TEXT_FAST__API_KEY=sk-azure-west-...
LLM__TEXT_FAST__API_VERSION=2024-02-15-preview
LLM__TEXT_FAST_1__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST_1__API_BASE=https://swedencentral.openai.azure.com
LLM__TEXT_FAST_1__API_KEY=sk-azure-sweden-...
LLM__TEXT_FAST_1__API_VERSION=2024-02-15-preview

# MULTI_MODAL_PRO: Gemini in EU regions (audio required)
LLM__MULTI_MODAL_PRO__MODEL=vertex_ai/gemini-2.5-pro
LLM__MULTI_MODAL_PRO__VERTEX_LOCATION=europe-west1
LLM__MULTI_MODAL_PRO__VERTEX_PROJECT=dembrane-prod
LLM__MULTI_MODAL_PRO__VERTEX_CREDENTIALS=${GCP_SA_JSON}
LLM__MULTI_MODAL_PRO_1__MODEL=vertex_ai/gemini-2.5-pro
LLM__MULTI_MODAL_PRO_1__VERTEX_LOCATION=europe-west4
LLM__MULTI_MODAL_PRO_1__VERTEX_PROJECT=dembrane-prod
LLM__MULTI_MODAL_PRO_1__VERTEX_CREDENTIALS=${GCP_SA_JSON}
```

Pair EU model regions with EU [object storage and email](./self-hosting.md#eu-residency) for
an end-to-end European footprint.

## Key feature toggles

A few environment toggles change behaviour you'll care about while integrating or operating:

- `SERVE_API_DOCS` - set to `1` to expose the OpenAPI explorer at `/docs` and the ReDoc
  view at `/redoc`. Invaluable while building against [the participant API](./participant-api.md)
  or [export endpoints](./export-and-integrations.md). Leave it off in production if you don't
  want the schema public.
- `DISABLE_REDACTION` - disables the PII-redaction step in the transcript correction pass.
  Only do this if you have a deliberate reason; redaction is on by design.
- `ENABLE_CHAT_AUTO_SELECT` - turns on the auto-select feature that picks relevant
  conversations for a chat (off by default).
- `ENABLE_AUDIO_LIGHTRAG_INPUT` - enables the audio-LightRAG input path (off by default).

The audio-LightRAG knobs (`AUDIO_LIGHTRAG_*`), the LightRAG model variables
(`LIGHTRAG_LITELLM_*`), and the full toggle list are enumerated in
`echo/docs/litellm_config.md`. When a toggle here and the code disagree, trust the code and
that file.

> [!WARNING]
> `DISABLE_REDACTION` removes a privacy safeguard from transcripts. If you handle personal
> data, leave redaction on and review your obligations - see
> [data ownership & compliance](../../features/data-ownership-and-compliance.md).

## Related

- [Self-hosting](./self-hosting.md)
- [The participant API](./participant-api.md)
- [Transcription](../../features/transcription.md)
- [Chat & Ask](../../features/chat-and-ask.md)
- [Internal: the processing pipeline](../developer-internal/processing-pipeline.md)
