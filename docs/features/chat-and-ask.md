---
title: Chat & Ask
description: Ask questions across your conversations and get answers with cited sources, using built-in or your own language model.
audience: host
---

# Chat & Ask

*Ask* is the interactive way into your data. Instead of reading every transcript, you put
questions to a set of [conversations](./conversations-and-transcripts.md) and get answers
grounded in what people actually said, with the sources cited so you can check them.

Treat it as a deep-dive, not a one-shot search:

1. *Start broad* - "What are the main themes?"
2. *Zoom in* - "What concerns came up about the bike lanes?"
3. *Ask for evidence* - "Show me the quotes."

It's best for comparing viewpoints, finding quotes, and testing a hunch.

## Modes

Click *Ask question* in a project, then choose a *mode* - it sets how dembrane reads your
conversations:

- *Overview* (beta) - reads across all conversations in the project for themes and patterns.
  Best for open-ended exploration; it paraphrases rather than quoting.
- *Specific Details* - you pick the conversations (or select all), optionally filtering by
  [tag](./conversations-and-transcripts.md#tags), and answers come back with exact quotes and
  citations. Best when you want precision: one session, one cohort, exact wording. If you're
  already viewing one conversation when you start, it's selected for you.
- *Agentic* (*[dembrane next only](./dembrane-next.md)*) - multi-step analysis with live tool
  execution: it can search across conversations, fetch transcripts, and chain steps to answer
  harder questions. A preview feature, not in production yet.

Specific Details is the usual move once a project gets large and you want precision over breadth.

## Cited sources

Every answer lists the conversations it drew on. Click through to read a source in full on its
[conversation page](./conversations-and-transcripts.md). If a claim matters, open the source and
confirm it in the participant's own words.

> [!TIP]
> When pulling quotes for a [report](./reports.md), copy them from the cited source, not from
> the chat answer - that way you're quoting the transcript, not a paraphrase.

## Templates & the prompt library

You don't have to write every prompt from scratch:

- *Built-in templates* live right in the chat - ready-made prompts for common tasks like
  summarising themes or surfacing disagreements.
- *Save your own* so a question your team asks every project is one click away.
- The *prompt library* has more, including patterns for large-scale, comparable analysis.

Templates keep analysis consistent across projects and colleagues.

> [!TIP]
> Start small - a chat almost always gives more than you asked for. Sometimes that's a useful
> nudge; often you don't need it.

## What you need

Ask needs the `chat:use` permission, so *owner*, *admin*, *member* and *external* can use it;
*observer* collaborators are read-only (see [roles & permissions](./roles-and-permissions.md)).

The built-in analysis behind Ask is a *Changemaker* (€75/seat) and *Guardian* (€150/seat)
feature, running on EU-hosted Gemini - chat that works out of the box. On *Free* it's limited.
On *Innovator* (€20/seat) you bring your own model instead: the chat screen becomes an
integration where you connect ChatGPT or Claude over [MCP](./mcp-and-bring-your-own-llm.md)
(*coming soon*). See [tiers & billing](./tiers-and-billing.md).

## Chat vs library vs reports

Three tools turn conversations into understanding, for different moments:

- *Ask* (this page) - interactive, question-by-question. Best for exploring and pulling
  specific answers with sources.
- *[Library & analysis](./library-and-analysis.md)* - a standing, automatically extracted view
  of topics, aspects and quotes across *all* your conversations. Best for large datasets where
  you want the whole landscape laid out.
- *[Reports](./reports.md)* - a built, shareable document. Best when you're ready to
  communicate, not just explore.

Most teams use all three: explore with Ask, see the landscape in the library, publish a report.

## Related

- [Conversations & transcripts](./conversations-and-transcripts.md) - the material Ask reads,
  and where cited sources point.
- [Library & analysis](./library-and-analysis.md) - the standing, extracted view for large datasets.
- [Reports](./reports.md) - turn Ask findings into something you can share.
- [Tiers & billing](./tiers-and-billing.md) - Free limits, Innovator BYO, Changemaker+ built-in analysis.
- [MCP & bring-your-own-LLM](./mcp-and-bring-your-own-llm.md) - connect your own model on
  Innovator (coming soon).
- [dembrane next](./dembrane-next.md) - preview features like agentic mode, not in production yet.
- For a host's walkthrough, see [chat & Ask for hosts](../users/host/chat-and-ask.md).
