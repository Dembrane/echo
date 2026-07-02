---
title: Library & analysis - for hosts
description: As a host, let dembrane read across a large set of conversations and surface the topics, aspects, and quotes - when to generate it, how to read it, and what's gated.
audience: host
---

# Library & analysis (for hosts)

The library is dembrane reading across all the conversations in a
[project](../../features/projects.md) at once and laying out what it found: the topics that
came up, the aspects within each, and the quotes that ground them. Where
[Chat & Ask](./chat-and-ask.md) answers a question you bring, the library answers the one you
haven't thought to ask - *"what's actually in here?"*.

Reach for it on large datasets - dozens of conversations from a multi-table town hall, a long
run of interviews, anything past what you'd sit and read. For a handful, reading the
[transcripts](../../features/conversations-and-transcripts.md) or asking a few
[chat](./chat-and-ask.md) questions is quicker.

The full mechanics live in the canonical
[Library & analysis](../../features/library-and-analysis.md) reference.

## Generate it

Open your project and go to *Library*. If it hasn't been built, generate it - dembrane reads
the conversations and extracts the structure. This takes a little time, proportional to how
much you've collected; you'll see its status while it runs. Two things:

- Collect first, then generate. The library reflects what's in the project the moment you build
  it - run it once you've got a meaningful body of conversations, not after the first.
- You can regenerate. As more conversations arrive, or after you sharpen the project's context,
  regenerate to pick up the new material.

> [!TIP]
> Give the project a clear, honest [context](./creating-a-project.md) before generating. The
> model uses it as background, so good context produces a sharper library.

## Read it: views, aspects, quotes

The library is laid out broad to specific:

- *Views* - a lens onto the conversations. dembrane builds a default view; create custom views
  to look at the same material through a different frame (say, organised around one question you
  care about). Handy when you want the analysis to line up with a [report](./reports.md)'s shape.
- *Aspects* - within a view, the distinct topics that came up.
- *Quotes* - within an aspect, participants' own words. These are the point: they keep the
  analysis honest and traceable.

Drill from a view into an aspect into its quotes. From any quote you can jump back to the
[conversation](../../features/conversations-and-transcripts.md) it came from to read the
surrounding context.

## From library to report

The library and [reports](./reports.md) work hand in hand: use the library to find the themes
and quotes, a report to present them. Generate the library, pick the aspects worth surfacing,
note their best quotes, then build a report around those. You can cross-check anything with a
targeted [chat](./chat-and-ask.md) question - *"show me everyone who raised this"* - before you
commit it.

## What your plan gives you

The library is built-in analysis, so it follows the analysis tier.

| You're on | The library |
|---|---|
| *Free* | Not included - gated, with an upgrade route. |
| *Innovator* | Not included (no built-in analysis). |
| *Changemaker* | Included - built-in analysis on EU-hosted Gemini. |
| *Guardian* | Included, on an EU-sovereign stack (*coming soon*). |

If the library is gated, that's a plan limit, not an error - see
[tiers, billing & usage](./tiers-billing-and-usage.md) to upgrade. If it isn't available to
your workspace at all, you'll see a *contact sales* prompt rather than a self-serve upgrade.

## Related

- [Library & analysis - feature reference](../../features/library-and-analysis.md) - the
  canonical how-it-works page.
- [Chat & Ask](./chat-and-ask.md) - ask targeted questions of the same conversations.
- [Reports](./reports.md) - present the themes and quotes the library surfaces.
- [Conversations & transcripts](../../features/conversations-and-transcripts.md) - where every
  quote leads back to.
- [Tiers, billing & usage](./tiers-billing-and-usage.md) - what each plan unlocks, and how to
  upgrade.
