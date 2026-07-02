---
title: Transcripts & conversations
description: The host workflow for what you've collected - reading transcripts and summaries, tags, locking, bulk actions, retranscribe, delete, and anonymisation.
audience: host
---

# Transcripts & conversations

Once people have spoken, dembrane [transcribes](../../features/transcription.md) what they
said and writes a summary. This is the day-to-day of working with that material: reading it,
organising it, and keeping it accurate. Reading and organising is open to workspace
*owners*, *admins*, *members*, plus *external* collaborators and *observers* (read-only);
deleting is owner/admin/member only.

For the role-neutral reference, see
[conversations & transcripts](../../features/conversations-and-transcripts.md).

## When the transcript appears

A conversation shows up in the dashboard as soon as it starts. The transcript follows about
*30 seconds to a minute later*. Why the wait? Audio is sent in 30-second pieces, and the
higher-quality transcription takes a little extra processing time. So a fresh conversation
with no text yet is normal - give it a minute.

## The conversation list

Each project has a *conversations* view listing everything collected. It's your home base:
*search* across conversations, *filter* by tags and other attributes, and select several to
apply *bulk actions* (below).

## Reading a conversation

Open one to see:

- *Transcript* - the full text in chunks. *Copy* it or *download a PDF*.
- *Summary* - a short overview written by a language model. *Generate* it if it's not there
  yet, or *regenerate* it after a retranscribe or if the first pass missed the point.
- *Tags* - labels you add to group related conversations.
- *Verified artifacts* - the points a participant approved, if you used
  [verification](./portal-editor.md#the-optional-extras) in the portal.
- *Anonymisation status* - whether personal information has been redacted.

> [!NOTE]
> Summaries are a starting point, not a verdict. They surface what's there so you can decide
> what matters - read the transcript when a point is load-bearing. *People know how.*

## Tagging

Tags make a pile of conversations navigable. Add tags that match the cuts you'll want later -
by table, theme, sentiment, or location. Tagged conversations are easy to filter and to
select as context for [Ask](../../features/chat-and-ask.md) and
[reports](../../features/reports.md). If you set
[portal tags](./portal-editor.md#the-optional-extras), conversations arrive pre-tagged.

## Locking

*Locking* marks a conversation as settled and protects it from accidental changes. Lock the
ones you've finished checking so a later bulk action doesn't touch them by mistake.

## Retranscribe

If a transcript came out rough - heavy accents, a noisy room, jargon you hadn't listed - you
can *retranscribe* it. First fill in your project's
[key terms](./portal-editor.md#key-terms-the-highest-value-field), since they feed
transcription. Afterwards, *regenerate the summary* so it reflects the improved text.

> [!TIP]
> A bad transcript is usually a missing-key-terms problem. Add the proper nouns and acronyms,
> then retranscribe - the second pass is often markedly better.

## Anonymisation

If you turned on
[anonymise transcripts](./portal-editor.md#what-you-ask-of-participants) in the portal,
dembrane redacts personal information as it processes each conversation, and the conversation
shows its anonymisation status. Use it for sensitive topics and wherever you've promised
anonymity - part of your broader
[data ownership & compliance](../../features/data-ownership-and-compliance.md)
responsibilities.

## Bulk actions

Select several conversations in the list and apply:

- *move* - relocate to another project;
- *lock* - settle a batch in one go;
- *delete* - remove conversations (owner/admin/member only);
- *retranscribe* - re-run transcription across a batch.

> [!WARNING]
> Deleting is permanent and removes the transcript and audio. To just keep something out of
> analysis, move it or filter it out rather than deleting.

## A clean post-session routine

1. Skim the list; *delete* obvious test recordings.
2. *Retranscribe* anything that reads badly (after checking key terms), then *regenerate* its summary.
3. *Tag* conversations by the cuts you'll want.
4. *Lock* the ones you've reviewed and are happy with.
5. Move on to [Ask](../../features/chat-and-ask.md) or a [report](../../features/reports.md).

## Related

- [Conversations & transcripts](../../features/conversations-and-transcripts.md) - canonical feature reference.
- [Transcription](../../features/transcription.md) - how audio becomes text, and why key terms matter.
- [Setting up the portal](./portal-editor.md) - key terms, anonymisation, and verification are set here.
- [Chat & Ask](../../features/chat-and-ask.md) - ask questions across tagged conversations.
- [Reports](../../features/reports.md) - turn conversations into something shareable.
