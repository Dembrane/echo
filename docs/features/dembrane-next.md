---
title: dembrane next (preview features)
description: dembrane next is the staging environment that gets every change before production. Features marked "dembrane next only" are live there but not yet in production.
audience: host
---

# dembrane next

*dembrane next* is the staging version of dembrane. Every change that merges to the
main branch deploys there straight away; production updates on a tagged release roughly
every two weeks. So some things are usable on dembrane next before they reach the
production app most people use.

Anywhere in these docs you see *dembrane next only*, the feature works on dembrane next
but is **not yet in production**. This page is the running list of what that covers right
now, so you always know whether something you read about is actually available to you.

> [!NOTE]
> You're almost certainly on production (`dashboard.dembrane.com`). If a feature below
> isn't showing up for you, that's expected - it hasn't shipped yet, it isn't a bug.

## On dembrane next right now

| Feature | What it is | Where |
|---|---|---|
| *Agentic mode* (in Ask) | An assistant that works in steps - searching, reading transcripts, checking live status, answering from the docs, and proposing settings changes for your review. Ask opens as a home for your chats, with named citations and a Stop control. | [Chat & Ask → Agentic mode](./chat-and-ask.md#agentic-mode-in-more-detail) |
| *Assistant memory & context* | The assistant saves notes (you view and remove them in user, project, and workspace settings) and takes standing guidance from a workspace-wide *assistant context*. | [Account & security](./account-and-security.md#what-the-assistant-remembers-about-you), [managing your workspace](../users/host/managing-your-workspace.md#give-the-assistant-standing-context) |
| *The Monitor* | A live view of a session: the participant flow from QR scan to recording, live recordings with audio warnings, and transcription progress. | [Recording → Watch it live](./recording.md#watch-it-live-the-monitor) |

If the table is short, that's a good sign: most of dembrane is the same on next and
production. Only genuinely in-progress features live here.

## How this list stays honest

The source of truth is the per-environment flags in the frontend config
(`frontend/src/config.ts`), where a *dembrane next only* feature reads as
`byEnv({ next: true }, false)` - on for next, off everywhere else.

At each production release (tagged from main, ~every two weeks), this page is reviewed:
anything whose flag has widened to production *graduates* - it comes off this list and
its *dembrane next only* tag is dropped from the main docs. So when a feature "goes out
of next", the docs follow.

## Related

- [Chat & Ask](./chat-and-ask.md) - where agentic mode lives.
- [Chat & Ask - for hosts](../users/host/chat-and-ask.md) - the host walkthrough.
- [The documentation map](../map.md) - everything else.
