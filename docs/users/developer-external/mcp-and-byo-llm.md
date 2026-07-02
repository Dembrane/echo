---
title: MCP & bring-your-own-LLM
description: The forthcoming way to connect your own assistant - ChatGPT, Claude - to your dembrane data, and where it sits today.
audience: developer-external
---

# MCP & bring-your-own-LLM

Bring-your-own-LLM lets you connect an assistant you already use - ChatGPT, Claude - to your
dembrane data, so it can reason over your conversations directly instead of dembrane choosing
the model for you.

This page is the developer reference. For the product-level overview of the same feature, see
[MCP & bring-your-own-LLM](../../features/mcp-and-bring-your-own-llm.md).

> [!IMPORTANT]
> This is a *coming-soon* feature, tied to the *Innovator* tier. The pieces below describe
> the intended offering; it has not shipped yet. We mark it clearly so you can plan, not so you
> can build against it today.

## What it will be

[MCP](https://modelcontextprotocol.io) - the Model Context Protocol - is an open standard for
giving an assistant access to external tools and data through a well-defined server interface.
The dembrane offering will expose your dembrane workspace as an *MCP server* that your own
assistant can connect to.

The intent, as set out in the tier model (ADR 0005):

- On *Innovator*, the chat screen becomes a *bring-your-own-LLM integration* rather than
  using dembrane's built-in analysis model.
- You'll connect an assistant you already pay for - *ChatGPT*, *Claude*, or another
  MCP-capable client - to your dembrane data via the MCP server.
- Your assistant can then query your conversations and transcripts as tools, with dembrane
  acting as the grounded, permission-aware data source. Your words stay in dembrane; the model
  reasons over them through the protocol.

This is distinct from *built-in analysis* (the EU-hosted Gemini-powered
[chat & Ask](../../features/chat-and-ask.md) and [library & analysis](../../features/library-and-analysis.md)),
which arrives at *Changemaker*. Innovator gives you the connector; Changemaker gives you
dembrane's own analysis. See [tiers & billing](../../features/tiers-and-billing.md) for how the
tiers stack.

## Current status

To be unambiguous about what exists today:

- The MCP / bring-your-own-LLM connector for end users is *not shipped*. Innovator is gated
  on it shipping.
- The agentic [chat & Ask](../../features/chat-and-ask.md) that *does* exist is dembrane's own
  agent service ([the internal chat & agent guide](../developer-internal/chat-and-agent.md))
  using its configured models - it is not an exposed MCP server you connect ChatGPT or Claude
  to.

> [!NOTE]
> If you've cloned the repository and found an `.mcp.json` file, that's *internal
> developer tooling* - MCP configuration for engineers working on the codebase. It is *not*
> an exposed dembrane MCP server, and it is unrelated to the customer-facing bring-your-own-LLM
> offering described here. Don't treat it as a public integration point.

## What you can do today

While the connector is in development, the supported ways to build your own analysis on top of
dembrane data are the existing developer surfaces:

- *Pull the data* with the [export endpoints](./export-and-integrations.md) - transcript
  zips and per-conversation text - and feed it into your own assistant or pipeline.
- *React to events* with [webhooks](./webhooks.md) so your own tooling sees new transcripts
  and reports as they're produced.
- *Self-host and configure your own models.* When you [self-host](./self-hosting.md), you
  already bring your own LLM keys and regions via the
  [LiteLLM configuration](./configuration-and-llm-providers.md) - that's
  bring-your-own-*provider* for dembrane's built-in features, which is a different thing from
  the MCP connector but worth knowing if your goal is "my models, my data location".

## Related

- [MCP & bring-your-own-LLM (feature)](../../features/mcp-and-bring-your-own-llm.md)
- [Chat & Ask](../../features/chat-and-ask.md) - the analysis that exists today.
- [Tiers & billing](../../features/tiers-and-billing.md) - Innovator vs Changemaker.
- [Export & integrations](./export-and-integrations.md) - building on dembrane data now.
- [Configuration & LLM providers](./configuration-and-llm-providers.md) - your models, your regions.
