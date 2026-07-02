---
title: MCP & bring-your-own-LLM
description: Connect your own language model or assistant to dembrane - how analysis differs across tiers, the Innovator BYO-LLM and MCP integration, and where things stand today.
audience: all
---

# MCP & bring-your-own-LLM

On the *Innovator* tier you can connect your own language model to dembrane instead of using
dembrane's built-in analysis. Instead of dembrane doing the analysis, the
[Chat & Ask](./chat-and-ask.md) screen becomes an integration point: you connect *your*
assistant - ChatGPT, Claude - over *MCP* (the Model Context Protocol) and ask your own model
questions about your conversations. It's for people who already have a model they trust and
want dembrane to be the *source of conversation data* rather than the analyst.

> [!IMPORTANT]
> Innovator's BYO-LLM and MCP are *coming soon* - Innovator as a self-serve tier is gated on
> the MCP integration shipping. Today, most workspaces land on *Changemaker* for analysis,
> which has it built in. See [tiers & billing](./tiers-and-billing.md) for current
> availability.

## Analysis by tier

| Tier | Analysis |
|---|---|
| *Free* | No analysis - secure transcription only |
| *Innovator* | *Bring your own LLM + MCP* - connect ChatGPT/Claude; dembrane provides the data, your model does the thinking *(coming soon)* |
| *Changemaker* | *Built-in analysis* on EU-hosted *Gemini* - [chat](./chat-and-ask.md), the [library](./library-and-analysis.md), and [reports](./reports.md) all work out of the box |
| *Guardian* | Built-in analysis on a fully *EU-sovereign* stack *(coming soon)* |

The shape matters more than it first looks:

- On *Free*, you get transcription you can read and
  [export](./export-and-data-portability.md), but no analysis.
- On *Innovator*, the analysis happens in *your* model - dembrane gives it access to your
  conversations; the reasoning is yours.
- On *Changemaker*, dembrane runs the analysis itself on EU-hosted Gemini - no setup, no
  external model to connect.
- On *Guardian*, the same built-in analysis runs on sovereign European infrastructure for
  the most sensitive work.

## What MCP gives you

The Model Context Protocol is an open standard for connecting assistants to data and tools.
With dembrane's MCP integration, an assistant like ChatGPT or Claude can reach into your
project and work with your conversations - listing them, searching them, reading transcripts
- so you can ask your own model questions grounded in what people actually said.

Because dembrane stays the system of record and your model does the analysis, you keep the
model relationship, and its data handling, on your terms - true to dembrane's view that
*people know how*, and the model is a tool in service of that.

> [!NOTE]
> The `.mcp.json` you may spot in the open-source repository is for dembrane's own internal
> tooling. It is *not* the customer-facing dembrane MCP server described here - that's the
> integration coming with Innovator.

## Where things stand

- *Changemaker built-in analysis* - available now, self-serve, on EU-hosted Gemini.
- *Innovator BYO-LLM + MCP* - *coming soon*, gated on the MCP integration shipping.
- *Guardian EU-sovereign analysis* - *coming soon*, gated on the sovereign stack.

If you need analysis today, Changemaker is the route. If bring-your-own-model matters to you,
tell your dembrane contact so we know to flag you when Innovator opens.

## Related

- [Chat & Ask](./chat-and-ask.md) - the analysis surface that becomes a BYO-LLM/MCP
  integration on Innovator, and works built-in on Changemaker.
- [Tiers & billing](./tiers-and-billing.md) - what each tier unlocks and current
  availability.
- [MCP & bring-your-own-LLM (developer)](../users/developer-external/mcp-and-byo-llm.md) - the
  developer and self-hoster view.
- [Data ownership & compliance](./data-ownership-and-compliance.md) - the Guardian sovereign
  stack and dembrane's EU posture.
