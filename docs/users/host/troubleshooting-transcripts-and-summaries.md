---
title: Troubleshooting transcripts & summaries
description: What to do when a transcript has mistakes, a summary misses the point, or a conversation shows no text or an error.
audience: host
---

# Troubleshooting transcripts & summaries

Almost every problem is one of three: the transcript has mistakes, the summary misses the
point, or there is no text at all. Find yours below.

| What you see | Go to |
|---|---|
| Names or jargon are misspelt, or passages read badly | 1. The transcript has mistakes |
| The summary is vague, off topic or in the wrong language | 2. The summary misses the point |
| "Transcribing", "Empty", "Transcription error", or nothing at all | 3. There is no transcript or summary |

## 1. The transcript has mistakes

You cannot edit the text of a transcript. Instead you give dembrane better information and
let it transcribe again.

1. Add key terms. Open "Portal editor", "Advanced settings", "Key terms", or press "Set key
   terms" on "Overview". Add the names of people, places and organisations and the jargon
   that came out wrong. Press Enter after each one.
2. Check the language. "Language" under "Basic settings" in the portal editor is a hint for
   transcription. dembrane writes down what is spoken, and the hint helps where the audio
   leaves room for doubt.
3. Retranscribe. Open the conversation and click the circular arrow next to the "Transcript"
   heading, "Retranscribe conversation" (Beta). Fill in "New conversation name" and press
   "Retranscribe".

Adding key terms does not change transcripts that already exist. Retranscribing does.

### What retranscribing does

- It makes a new conversation from the same audio, with a fresh transcript. The original
  stays as it is, and each of the two links to the other. Delete the old one yourself when
  the new one is good.
- You see "Retranscription started. New conversation will be available soon." Press "Go to
  new conversation".
- "Anonymize transcript" starts on the project's setting. With it on, the new conversation
  has no audio playback, no audio download and cannot be retranscribed again.
- "Attach verified artifacts" shows when the original has approved outcomes. Switch it on to
  copy them to the new conversation.
- The new conversation shows in your usage like any other. On the free plan it does not use
  up the month's hours.
- An anonymised conversation cannot be retranscribed.

### Marks you can find in a transcript

| Mark | Meaning |
|---|---|
| `[unclear]` or `[crosstalk]` | Words dembrane could not make out. It leaves a passage out before it guesses. |
| `[Nothing to transcribe]` | That piece of audio had no speech in it. This is not an error. |
| `<redacted_name>` and similar | The conversation is anonymised and personal details were replaced. Names you listed as key terms are replaced too. |
| "Unable to process this chunk" | That piece of audio failed. See section 3. |

For the next session: keep the phone close to the people who speak and away from background
noise.

## 2. The summary misses the point

A language model writes the summary from the transcript, the project's name and "Project
context", the key terms, the "Page title" and "Page content" of the portal, and the outcomes
a participant approved. It writes in the project's language.

1. Get the transcript right first (section 1). A summary cannot be better than the text
   under it.
2. Sharpen the "Project context". Open "Manage", "General", or press "Set project context"
   on "Overview". Say what the project is about and what you want to learn.
3. Open the conversation and press "Regenerate summary" next to "Summary", then
   "Regenerate". The new summary replaces the current one, which is lost.

Other things to know:

- With "Auto-generate titles" on, regenerating also writes the title again and can add tags.
- You can write the summary yourself. Press "Manage" on the conversation's row to open "Edit
  conversation" and type over the text.
- A summary in the wrong language follows the project's "Language". Change it in the portal
  editor, then regenerate.
- A summary that reads `[No transcript available]` means the conversation has no text. See
  section 3.

## 3. There is no transcript or summary

| What you see | What it means | What to do |
|---|---|---|
| "Transcribing" in the list, or "Transcribing..." on a piece | dembrane is working on it. | Wait. A piece that fails is tried again for about 15 minutes before dembrane gives up. |
| "No transcript exists for this conversation yet. Please check back later." | No piece of audio has arrived. | During a recording, wait: the first piece arrives after 30 seconds. On a finished conversation, see "Empty". |
| "Empty" | In the list: no audio has arrived. On the conversation's page: the conversation is finished and has no text. | A recording that just started fills in by itself. A finished conversation without audio has nothing to recover, so ask the participant to record again. If it also shows "Transcription error", follow the next row. |
| "Transcription error", and "Unable to process this chunk" in the transcript | Part of the audio could not be transcribed. The rest was transcribed and summarised, and the recording is saved. | Retranscribe to give the whole recording a fresh pass. If the same part fails again, tell us with "Give feedback". |
| "Generate summary" is greyed out | The summary needs transcript text first. | Wait for the transcript, then press "Generate summary". |
| A finished conversation has no summary yet | The summary is not written yet, or the attempt failed. | dembrane tries again every 5 minutes. You can also press "Generate summary". |

## Still stuck?

Open the conversation and press "Give feedback" under "Help" at the bottom of the sidebar.
Your current page is sent along, so the dembrane team can find the conversation. Other ways
to reach us are in [getting help](./getting-help.md).

## Related

- [Transcripts & conversations](./transcripts-and-conversations.md)
- [Setting up the portal](./portal-editor.md)
- [Collecting conversations](./collecting-conversations.md)
- [Tiers, billing and usage](./tiers-billing-and-usage.md)
- [Getting help](./getting-help.md)
