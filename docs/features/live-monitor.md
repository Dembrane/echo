---
title: The live monitor
description: Watch who has scanned, who is recording, and where audio or transcription has a problem, while a session runs.
audience: all
---

# The live monitor

During a session, people record on their own phones at the same time. The monitor shows
each of them as they scan, set up, record and finish, so you can see who needs help without
interrupting anyone.

Open "Monitor" (Beta) in the project sidebar. It is a page of its own. Anyone who can read
the project's conversations can open it, observers included. The page also shows a small QR
code ("Scan to join this project") and a "Host guide" button.

The page updates by itself. If the live connection drops, it shows "Reconnecting" and
refreshes every 5 seconds until the connection is back.

## Live participant flow

The top of the page counts people in five columns:

| Column | Who is in it |
|---|---|
| "Scanned" | Opened the portal and has not accepted the terms yet |
| "Setting up" | Accepted the terms, or is filling in the start form |
| "Recording page" | On the recording screen but not recording: waiting, paused or away |
| "Live" | Recording now |
| "Finished" | Finished, or left without finishing |

Someone who is offline is in no column. You find them in the grid below.

Click a visitor for "Visitor details". Its "Timeline" shows "Scanned the QR", "Accepted
terms" and "Entered details" with their times. There is no microphone stage, because the
portal has no microphone check before recording.

## Live monitoring

Below the flow is a grid with one tile per conversation. Group it "By tag" or "By status".
The status groups are "On recording page", "Live", "Offline" and "Finished". A tile changes
group only after its new status has held for 4 seconds, so the grid does not jump around.

A tile shows:

- a state pill: "Recording", "Paused", "Verifying", "Exploring", "Typing", "Finishing",
  "Finished", "On recording page", "Just started", "Offline", "Left", "Away" or "Idle";
- a five-bar microphone meter while audio arrives. Its tooltip reads "Audio is coming in"
  or "Very quiet right now. Check the mic isn't muted.";
- the participant's name, or "Anonymous participant";
- the recorded time;
- icons for "Weak network" and "Low battery" when the phone reports them.

## What the statuses mean

| You see | It means | What to do |
|---|---|---|
| "Live" | The phone was in contact in the last 15 seconds, or audio arrived recently, and the participant is not waiting, paused or away | Nothing |
| A warning, "Audio was coming in but stopped." | The phone is still in contact, but no audio arrived for 45 seconds | Walk over and check their connection and screen |
| "Away" | Their screen is locked or the tab is hidden. Recording pauses until they come back | Ask them to keep the screen on |
| "Offline" | Contact was lost with someone who was recording | Check their connection |
| "Error" | Some recent audio could not be transcribed. The recording is saved | Open the conversation later and see which part failed |

The monitor looks back 30 minutes.

"Live" here is not the same as "Live" or "Ongoing" in the conversation lists. In the lists
it means that audio or text arrived in the last 30 seconds.

## The summary badges

Above the grid, badges count the whole session: "# live", "# offline", "# audio stopped",
"# transcribing" and "# with errors". "Catch up ~N min" is a rough estimate of how long the
transcription backlog needs.

## Open a conversation

Click a tile for the "Conversation" dialog. It holds:

- a "Timeline": "Scanned the QR", "Accepted terms", "Entered details", "Joined the
  conversation", "Started recording" and "Last audio";
- "Participant name" and "Tags", which you can edit there;
- "Open conversation" and "Delete".

## What the monitor does not show

- Audio you uploaded in the dashboard, and retranscribed copies.
- The words being said. A tile shows state and audio level, not transcript text.
- On a free workspace that has used its hour, tiles are locked and open the upgrade dialog.
  See [recording](./recording.md).

## Related

- [Recording](./recording.md): how audio is sent, and what participants see when it fails.
- [The participant portal](./portal-and-participant-experience.md): the screens behind each
  column.
- [Conversations and transcripts](./conversations-and-transcripts.md): the statuses in the
  conversation lists.
- [Transcription](./transcription.md): what "Error" and "# transcribing" refer to.
- [Collecting conversations](../users/host/collecting-conversations.md): using the monitor
  during a session.
