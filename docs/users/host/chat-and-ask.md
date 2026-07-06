---
title: Chat & Ask - for hosts
description: As a host, ask questions of your conversations and get cited answers - choosing a mode (Overview or Specific Details), using templates, and what the preview agentic mode adds.
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

## Choose a mode

When you start an Ask you pick a *mode*, and the mode decides how dembrane reads your
conversations.

- *Overview* (beta) - reads across all the conversations in your project for themes and
  patterns. Fast, and the right default for "what are the broad themes". It paraphrases, so it
  isn't where you go for an exact quote.
- *Specific Details* - you choose the conversations (one, a few, or all of them) and dembrane
  finds exact quotes with citations from the full
  [transcripts](../../features/conversations-and-transcripts.md). Reach for this when wording
  matters, or when every answer should come from the same set (say, while drafting a report).
  If you're already viewing one conversation when you start, it's selected for you.

> [!TIP]
> Map the territory in *Overview*, then switch to *Specific Details* (and narrow to the right
> conversations) once you know which thread to pull. For a verbatim quote, always use *Specific
> Details* - Overview paraphrases.

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

## Agentic mode

> [!NOTE]
> Agentic mode is *[dembrane next only](../../features/dembrane-next.md)* - it's a preview
> feature, not in production yet. On production, Ask offers *Overview* and *Specific Details*.

On dembrane next, *Ask* opens as a home for your chats. Type in the bar to filter earlier
chats, or press Enter to ask your question as a new chat. Not sure where to start? Three
starter chips get you going: *List my conversations*, *What themes came up?*, and *Improve my
setup*. A *Templates* menu inserts a saved prompt, and one click starts a classic *Specific
Details* chat instead if you'd rather pick the conversations yourself.

Where *Overview* and *Specific Details* answer in one pass from the conversations you chose,
agentic mode works in steps - searching, reading transcripts, and chaining what it finds to
answer a harder question (*"find every conversation where someone disagreed with the proposal
and tell me why"*). You watch its progress as it works, and *Stop* replaces *Send* so you can
halt a run mid-way. Answers cite sources by name - *"Maria's conversation"* - and each link
jumps to the exact spot in the transcript.

It's also more than analysis:

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
- [dembrane next](../../features/dembrane-next.md) - preview features (like agentic mode) that
  aren't in production yet.
