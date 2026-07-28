---
title: Chat & Ask - for hosts
description: As a host, ask questions of your conversations and get cited answers - one assistant that searches and shows its work, with the classic Specific Details chat one click away.
audience: host
---

# Chat & Ask (for hosts)

Ask is your interactive deep-dive into a [project](../../features/projects.md). You type a
question in plain language and dembrane answers from the conversations you've collected,
pointing back to where each part came from. It doesn't replace reading transcripts - it helps
you find what's worth reading. The answers come from your participants; the model's job is to
find and organise what they said, with receipts.

The full mechanics live in the canonical [Chat & Ask](../../features/chat-and-ask.md) reference.

## Run a good deep-dive

The pattern that works: start broad, then zoom in, then ask for evidence.

1. Click *Ask question* (or *New chat*) in your project.
2. Start broad: *"What are the main themes?"*
3. Zoom in: *"What concerns came up about the bus route?"*
4. Ask for evidence: *"Show me the quotes."*

Each chat is a thread - read the answer, then follow up: *"say more about the second point"*,
*"who said that?"*, *"now just the under-30s"*. Old chats stay in your history. This is the
right tool for comparing viewpoints, finding quotes, or testing a hunch.

## One place to ask

> [!NOTE]
> The new Ask experience is live on *[dembrane next](../../features/dembrane-next.md)* and
> reaches production with the next release.

Ask opens as a home for your chats, with one input: *Where would you like to start?* Type
your question and press Enter, and the assistant gets to work in steps - searching your
conversations, reading [transcripts](../../features/conversations-and-transcripts.md), and
chaining what it finds to answer harder questions (*"find every conversation where someone
disagreed with the proposal and tell me why"*). Typing in the same bar also filters your
earlier chats, so it's how you find last week's thread too. A *Templates* menu inserts a
saved prompt.

You watch the assistant's progress as it works, and *Stop* replaces *Send* so you can halt a
run mid-way. Answers cite sources by name - *"Maria's conversation"* - and each link jumps to
the exact spot in the transcript.

## The classic chat: Specific Details

Prefer to pick the conversations yourself? One click on *Prefer the old chat? Start a
Specific Details chat* starts a classic chat: you choose the conversations (one, a few, or
all of them) and dembrane answers in one pass with exact quotes and citations from the full
transcripts. Reach for this when every answer should come from the same fixed set - say,
while drafting a report. If you're already viewing one conversation when you start, it's
selected for you.

> [!TIP]
> Map the territory by asking the assistant first, then start a *Specific Details* chat
> narrowed to the right conversations once you know which thread to pull.

The old *Overview* mode has been retired: its job - themes and patterns across all your
conversations - is now just a question you ask the assistant.

## Check the sources

Every answer links back to the conversations it drew on. Glance at them: they let you check
the answer against what people actually said, jump to the
[transcript](../../features/conversations-and-transcripts.md) for full context, and quote a
participant accurately. If an answer feels too neat, open the sources. The transcripts are the
truth; the chat is a way in.

## Templates and the prompt library

You don't have to write every question from scratch. Templates are pre-written prompts for
common jobs - pulling out themes, listing concerns, summarising one topic. Built-in ones ship
in the chat; you can save your own when you reuse a prompt across projects. There's also a
prompt library with more to copy. Pick one, adjust the wording to your project, send. They're a
starting point, not a cage.

## Tips for good questions

- Ask one thing at a time. *"What were the top three concerns?"* beats a five-part paragraph.
- Name the scope when it matters: *"in the Tuesday sessions, …"*.
- Give the project good [context](./creating-a-project.md) - the model uses it as background,
  so honest, specific context sharpens every answer.
- Check the sources before you act on an answer.

## More than analysis

The assistant does more than answer questions about your data:

- Ask *"is anyone recording right now?"* and it checks the same live status as the
  [Monitor page](./collecting-conversations.md#watch-the-room-the-monitor-page).
- Ask *"how do I set up verification?"* and it answers from this documentation, linking the
  page it used.
- Ask it to improve your setup and it *proposes* settings changes - you review and apply each
  one; it never changes your project by itself.
- If you're stuck, it can [log a question with the dembrane team](./getting-help.md).

It also *remembers*: it can save notes about how you like to work and what the project is
about, so your next chat starts smarter. You stay in charge of that memory - see and remove
your own notes under *Settings → Assistant*, project notes in project settings, and workspace
notes in [workspace settings](./managing-your-workspace.md#give-the-assistant-standing-context).

## What your plan gives you

| You're on | Chat & Ask gives you |
|---|---|
| *Free* | Chat is gated under free-tier limits. |
| *Innovator* | No built-in analysis; the chat screen becomes a bring-your-own-LLM + MCP integration (*coming soon*). |
| *Changemaker* | Built-in analysis on EU-hosted Gemini - the usual home for hosts doing analysis. |
| *Guardian* | As Changemaker, on an EU-sovereign stack (*coming soon*). |

If you hit a wall, that's a tier limit, not a bug. See
[tiers, billing & usage](./tiers-billing-and-usage.md) for how to upgrade.

## Related

- [Chat & Ask - feature reference](../../features/chat-and-ask.md) - the canonical how-it-works
  page.
- [Conversations & transcripts](../../features/conversations-and-transcripts.md) - what chat
  reads, and where sources point.
- [Library & analysis](./library-and-analysis.md) - the other way to make sense of a large set
  of conversations.
- [Reports](./reports.md) - turn good answers into something you can share.
- [Tiers, billing & usage](./tiers-billing-and-usage.md) - what each plan unlocks.
- [MCP & bring-your-own-LLM](../../features/mcp-and-bring-your-own-llm.md) - connect your own
  model on Innovator (*coming soon*).
- [dembrane next](../../features/dembrane-next.md) - preview features (like the new Ask
  experience) that aren't in production yet.
