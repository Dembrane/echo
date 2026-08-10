---
title: Chat & Ask
description: Ask questions across your conversations and get answers with cited sources - one assistant that searches, reads, and shows its work.
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

## One question bar

> [!NOTE]
> The new Ask experience is live on *[dembrane next](./dembrane-next.md)* and reaches
> production with the next release.

Click *Ask question* in a project and Ask opens as a home for all your chats, with one
input: *Where would you like to start?* Press Enter and your question becomes a new chat;
typing in the same bar also filters your earlier chats, so it finds an old thread as easily
as it starts a new one. A *Templates* menu inserts a saved prompt.

The assistant works in steps: it searches conversations, reads
[transcripts](./conversations-and-transcripts.md), and chains what it finds to answer harder
questions (*"find every conversation where someone disagreed with the proposal and tell me
why"*). While it works you see its progress step by step, and a *Stop* control replaces
*Send* so you can halt a run that's going the wrong way. Answers cite their sources by name -
*"Maria's conversation"*, *"Maria's transcript excerpt"* - and each link jumps to the exact
place in the transcript.

## The classic chat: Specific Details

Prefer to pick the conversations yourself? One click on *Prefer the old chat? Start a
Specific Details chat* starts a classic chat: you choose the conversations (or select all),
optionally filtering by [tag](./conversations-and-transcripts.md#tags), and answers come
back in one pass with exact quotes and citations. Best when every answer should come from
the same fixed set: one session, one cohort, exact wording. If you're already viewing one
conversation when you start, it's selected for you.

The old *Overview* mode has been retired: its job - themes and patterns across all
conversations - is covered by simply asking the assistant.

## More than analysis

Beyond answering questions, the assistant can:

- *Check what's live* - ask *"is anyone recording right now?"* and it reads the same live
  status as the [live monitor](./live-monitor.md).
- *Read earlier chats* in the project (your colleagues' private chats stay private).
- *Answer "how do I" questions* from this documentation, citing the page it used.
- *Suggest settings changes* - it never edits your project itself; every change arrives as a
  proposal you review and apply (or reject).
- *Log a question with the dembrane team* when you're stuck - see
  [getting help](../users/host/getting-help.md).
- *Remember* - it can save notes about your preferences and the project so the next chat
  starts smarter. You can see and remove everything it remembers: your own notes under
  *Settings → Assistant*, project notes in project settings, workspace notes in
  [workspace settings](./organisations-and-workspaces.md). The assistant writes these notes;
  you can't edit them, only remove them.

Hosts steer it with standing guidance too: the project *context* field, and a workspace-wide
*assistant context* in workspace settings that reaches every project chat in the workspace.

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
- [dembrane next](./dembrane-next.md) - preview features like the new Ask experience, not in
  production yet.
- For a host's walkthrough, see [chat & Ask for hosts](../users/host/chat-and-ask.md).
