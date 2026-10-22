---
title: Recording
description: How audio gets into dembrane. Recording in the participant portal, uploading audio files, the real limits, the free plan's monthly hours, and what happens on a bad connection.
audience: all
---

# Recording

People record in the participant portal, a web page that opens in the browser of a phone or
laptop. There is no account and nothing to install. A host who already has recordings can
upload audio files instead.

## Get people to the portal

Open the project's "Overview". The "Take part" card holds everything you hand out:

- the QR code, with "Download QR code" for a PNG file;
- "Copy link" and "Open link" for the direct link;
- "Download event printouts", which opens the host guide with your browser's print dialog.

The host guide is a printable instruction sheet with the project's QR code, numbered steps
and tips. You can edit the text, and your edits are shared by all hosts of the project.
Print it, or put it on a screen with "Go fullscreen". For a PDF, save as PDF from the print
dialog.

"Open link" opens the portal on the device you are using, so you can record there yourself.

## What recording looks like

1. The participant opens the link and reads the privacy card and any tutorial cards. They
   fill in a name or pick tags if the project asks for them.
2. They press "Record" and talk. A level meter and a timer show that audio is coming in.
3. "Stop" pauses the recording. A "Recording paused" dialog offers "Resume" and "Finish".
4. "Finish" ends the conversation and opens the thank you page.

Every screen is described on [the participant portal](./portal-and-participant-experience.md).

## How audio is sent

The portal records in pieces of 30 seconds and sends each piece as soon as it is complete.
An interruption costs the piece being recorded, not the conversation, and a piece that fails
to send is tried again.

Three things to tell participants:

- Keep the screen on. A locked phone does not record. The portal asks the browser to keep
  the screen awake. Battery saver can prevent that, so ask people to turn it off.
- Keep the tab open until "Finish". Pieces that are not sent yet exist only in the open
  page, and closing the tab loses them.
- Use a normal browser. Inside the LinkedIn, Instagram or Facebook app the microphone may
  not work. The portal then shows a notice with a "Copy link" button.

A conversation that gets no new audio for 5 minutes is finished automatically. If more
audio arrives later, the conversation opens again and is summarised again.

## The microphone test

There is no microphone check before recording. The test is in the portal's "Settings", the
gear icon in the header. It shows the selected microphone, lets the participant choose
another one, and shows the live audio level. The same dialog opens by itself when the
microphone gives a flat signal for 8 seconds.

Changing the microphone during a recording saves the audio so far and restarts the
recording.

## When the connection is bad

- Before recording, the portal checks that it can store audio. If it cannot, a "Connection
  issue" dialog says the audio will not be saved, and "Record" stays off until "Reconnect"
  succeeds. This happens when a VPN or a firewall blocks the connection. Turn the VPN off
  or switch network, for example to a mobile hotspot.
- During recording, the level meter changes colour and a warning appears when the
  connection has been gone for about 6 seconds.
- When the microphone stops delivering audio, typically because the phone locked or took a
  call, the portal plays an alert sound and shows "Recording interrupted". About the last
  minute of audio is lost. "Reconnect" reloads the page. The conversation and everything
  already sent are kept.

## Typing instead of speaking

The text icon on the recording screen switches to a text box. Spoken and typed pieces can
be mixed in one conversation. Typed text needs no transcription: it is the transcript.

## Upload audio files

Use "Upload" on the "Conversations" page or "Upload audio" on the "Overview".

| Limit | Value |
|---|---|
| Formats | MP3, WAV, OGG, WEBM, M4A, MP4, AAC, FLAC, OPUS |
| File size | At least 5 KB, at most 200 MB |
| Files per upload | Up to 10 |

Each file becomes its own conversation, named after the file. You can change the name
before you upload. Files are not combined. An uploaded conversation is transcribed and
summarised straight away, carries an "Upload" badge, and does not appear on the
[monitor](./live-monitor.md).

Upload takes audio only. There is no upload for documents, transcripts or text files.
Observers cannot upload.

## The free plan's hours

An account on the free plan gets 5 hours of audio a month, shared by all its workspaces.
One conversation can be at most 1 hour long. The month starts on the 1st (UTC). Deleted
conversations still count. Paid plans have no cap on hours.

- Only one project in the account takes recordings. Other projects show "Recordings are
  paused for this project on the free plan. New recordings go to {name}." and "Use this
  project for recordings" switches it.
- At 1 hour the portal stops the recording and shows "That's a wrap": "This conversation
  has reached its maximum length. Everything you recorded is saved."
- When the month's hours run out during a recording, the portal shows "Recording has
  stopped for now. Everything you recorded is saved."
- A portal with no hours left, or of a project that does not take recordings, shows "This
  project isn't taking recordings right now." It never mentions plans. A portal for
  typed text still works.
- Upload checks each file's length first: "This file is {file} long. You have {left} of
  recording left this month."
- Everything that was recorded is transcribed and summarised as usual. No conversation is
  locked.

See [tiers and billing](./tiers-and-billing.md).

## The iOS app

dembrane Go, the iOS app, cannot sign in to the current version of dembrane. Record through
the portal in a phone browser instead. See [dembrane Go](./mobile-app-dembrane-go.md).

## Related

- [The participant portal](./portal-and-participant-experience.md): every screen a
  participant sees.
- [The portal editor](./portal-editor.md): what the portal asks and shows.
- [The live monitor](./live-monitor.md): watch a session while it runs.
- [Transcription](./transcription.md): what happens to the audio next.
- [Collecting conversations](../users/host/collecting-conversations.md): running a session
  as a host.
- [Recording your conversation](../users/participant/recording-your-conversation.md): the
  same steps written for participants.
