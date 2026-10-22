---
title: Transcription
description: How dembrane turns audio into text. What the project language does, key terms, anonymisation, retranscribing, and what a failed piece looks like.
audience: all
---

# Transcription

Transcription is automatic. The portal sends audio in pieces of 30 seconds, and each piece
is queued for transcription as soon as it arrives. You do not start anything. Text typed in
the portal skips this step, because it already is the transcript.

While audio is being recorded or transcribed, "Conversations" in the project sidebar shows
a small progress ring. When the work ends you get "Transcription done", or "Transcription
failed" when a conversation could not be transcribed.

## What does the work

dembrane sends the audio to a Gemini language model on Google Vertex AI, through its EU
data residency endpoint. The model is told to write down exactly what is spoken and to
leave text out before it guesses. Two marks can appear in a transcript: `[unclear]` and
`[crosstalk]`. A piece with no speech reads "[Nothing to transcribe]".

## The project language is a hint

The "Language" you choose in the [portal editor](./portal-editor.md) is given to
transcription as a hint only. The model is told to trust the audio and to transcribe all
speech it can make out, other languages included. A Dutch conversation in a project set to
English is not forced into English.

The language does decide two other things: the language the portal opens in, and the
language of summaries and generated titles.

## Key terms

Key terms tell transcription how to spell the names and words that matter in your project.
Without them, a name the model does not know often comes out misspelt, and that carries
into summaries, chats and reports.

Add the people, places, organisations and jargon you expect to hear. You can do it while
you create the project, or later under "Key terms" in the portal editor's "Advanced
settings". Press Enter after each term, or separate several with commas.

> [!TIP]
> Add key terms before the session. They apply to audio transcribed after you add them.
> For a conversation that is already transcribed, use retranscribe.

## Anonymisation

"Anonymize transcripts" (Beta) is a switch in the portal editor's "Advanced settings". With
it on, new transcripts have personal information replaced with placeholders such as
`<redacted_name>`, `<redacted_email>`, `<redacted_phone>` and `<redacted_address>`.

What to know before you switch it on:

- Decide before you collect. It works on new transcripts, and it cannot be undone for
  conversations that are already processed.
- For an anonymised conversation, audio playback, audio download and retranscription are
  switched off in the dashboard.
- Names are replaced even when they are in your key terms.
- Participants are told. The recording screen says the transcript will be anonymised and
  that the host cannot listen to the recording.
- Replies from Explore and outcomes from Verify are redacted in the same way.

## Retranscribe

On a conversation's transcript, the circular arrow "Retranscribe conversation" (Beta) makes
a new conversation from the same audio with a fresh transcription. The original stays as it
is, and the two are linked.

You give the new conversation a name and can switch "Anonymize transcript" on or off for
this run. If the original has approved outcomes, "Attach verified artifacts" copies them to
the new conversation.

Retranscribing needs a role that can edit the project. It is not available for anonymised
conversations.

## When a piece fails

A failed transcription is tried again up to 6 times, over about 15 minutes, before the
piece is marked as failed. A failed piece does not block the rest: the conversation is
still merged and summarised from the pieces that worked.

| Where | What you see |
|---|---|
| In the transcript | The piece reads "Unable to process this chunk" |
| In the conversation lists | A red "Transcription error" badge |
| On the [monitor](./live-monitor.md) | A red "Error" icon and the count "# with errors" |

The recording itself is saved. For what to try next, see
[troubleshooting transcripts and summaries](../users/host/troubleshooting-transcripts-and-summaries.md).

## On the free plan

Every conversation is transcribed and summarised, on every plan. The free plan limits how
much audio comes in: 5 hours a month for the account, and 1 hour per conversation. Nothing
that was recorded is hidden. See [recording](./recording.md).

## Related

- [Recording](./recording.md): where the audio comes from.
- [The portal editor](./portal-editor.md): language, key terms and anonymisation.
- [Conversations and transcripts](./conversations-and-transcripts.md): reading and
  downloading the result.
- [Data ownership and compliance](./data-ownership-and-compliance.md): where data is
  processed and stored.
- [Troubleshooting transcripts and summaries](../users/host/troubleshooting-transcripts-and-summaries.md).
