---
title: The participant portal
description: The page people record on, screen by screen. The start cards and privacy card, recording, typing, Explore and Verify, the thank you page and the report page.
audience: participant
---

# The participant portal

The portal is the web page people record on. They open it from the host's link or QR code,
in the browser of a phone or laptop. There is no account and nothing to install.

What the portal asks and shows is set by the host in the [portal editor](./portal-editor.md).

## Language

The portal opens in the project's language, because the link and the QR code carry it.
There is no language picker inside the portal.

The interface exists in English, Dutch, German, French, Spanish, Italian, Ukrainian and
Czech. The tutorial and privacy cards are written in the first six. A Ukrainian or Czech
portal shows those cards in English.

## 1. Start

The participant first goes through cards, one button press each. The host chooses how many
with "Select tutorial":

| Tutorial | Cards |
|---|---|
| None (the default) | The privacy card only |
| "Basic" | Six short cards about dembrane and how to take part, then the privacy card |
| "Advanced" | The basic cards, the privacy card, then three tips: reduce background noise, use a strong internet connection, do not lock your device |

The privacy card depends on the project's legal basis:

| Legal basis | What the participant sees |
|---|---|
| "Client-managed" | A card that says the organiser is responsible for how the data is used, and that dembrane processes the conversation on their behalf. One button, "I understand". |
| "Consent" | The same card with a checkbox, "I consent to my conversation being recorded and processed.", and a link "Read the organiser's privacy policy". The participant cannot continue without ticking the box. |
| "dembrane events" | A card that says dembrane records and analyses the conversation on the basis of its legitimate interest, with a link "Read the full privacy policy". |

The last card is the start form, "Ready to begin?". It shows a name field ("Session name")
when the host asks for a name, and a "Tags" list when the project has tags. When the
project asks for neither, the portal skips the form and starts by itself.

There is no microphone check and no language choice on the way in.

Opened inside the LinkedIn, Instagram or Facebook app, the portal shows a notice that the
microphone may not work there, with a "Copy link" button to open the page in a normal
browser.

## 2. Record

The recording screen shows the host's title and text, a "Record" button and a text icon.

- "Record" starts the recording. A live level meter and a timer show that audio is coming
  in.
- "Stop" pauses. A "Recording paused" dialog offers "Resume", "Finish" and "Switch to text
  input".
- The text icon opens a text box with "Submit". Spoken and typed answers can be mixed in
  one conversation.
- "View your responses" lists the participant's own pieces as text. Each has "Delete".
- "Settings", the gear icon in the header, holds the microphone test: the selected
  microphone, a list to choose another, and the live audio level. It opens by itself when
  the microphone gives a flat signal for 8 seconds.
- "Finish" ends the conversation, once at least one answer exists.

The screen must stay on: a locked screen does not record. In an anonymised project the
screen also says that the transcript will be anonymised and that the host cannot listen to
the recording.

What happens on a bad connection is described on [recording](./recording.md).

## 3. Explore and Verify

When the host switched on "Explore" or "Verify" (both Beta), a button labelled "ECHO"
appears while recording. It works after 60 seconds of recording. It opens a choice of two
cards:

- "Explore" gives an immediate reply from dembrane to help the group go deeper. A language
  model writes it from the conversation so far and the project's context. Recording
  continues.
- "Verify" writes an outcome on a topic the participant picks, for example "What we
  actually agreed on". They read it, talk about what should change, choose "Revise" to have
  it rewritten from what was said since, and choose "Approve" when it is right. The host
  sees approved outcomes only.

After use, each card cools down for 2 minutes.

## 4. Finish

The thank you page shows the host's own text, or "Thank you for participating!". It offers
"Show QR code" and "Record another conversation".

When the host asks for an email, the page has a sign-up, "Do you want to stay in the
loop?", where the participant can add one or more addresses.

Unless the host switched it off, the page ends on a card, "dembrane at your event?", that
links to the dembrane website. Switching it off needs a paid plan.

## The report page

The portal has a report page that shows the project's latest published report. It is the
same for every visitor: it is not a summary of one participant's own conversation. Until a
report is published it reads "This report is not yet available." See [reports](./reports.md).

## Passing the portal on

"Share portal", the QR icon in the header, shows a full-screen QR code ("Scan to start a
new portal session") with "Copy link", "WhatsApp" and "Email". The link it hands out does
not carry the participant's own details.

## Links that fill things in

A host can add parameters to the portal link:

| Parameter | Effect |
|---|---|
| `participant_name`, `title` or `name` | Fills in the name |
| `participant_email` or `email` | Sent along with the conversation |
| `tags` | Tags to select in advance, separated by commas |
| `mode=text` or `mode=audio` | Opens the text screen or the recording screen |
| `feedback` | Opens the text screen with this text filled in |
| `skipOnboarding=1` | Skips every card, the privacy card included |

> [!WARNING]
> `skipOnboarding=1` also skips the privacy card and the consent checkbox. Use it only when
> you give participants the privacy information in another way.

## Related

- [The portal editor](./portal-editor.md): where the host sets all of this.
- [Recording](./recording.md): how audio is sent, and what happens when it fails.
- [What to expect](../users/participant/what-to-expect.md) and
  [recording your conversation](../users/participant/recording-your-conversation.md): the
  same steps written for participants.
- [Refining and verifying](../users/participant/refining-and-verifying.md): Explore and
  Verify from the participant's side.
- [Your privacy and data](../users/participant/your-privacy-and-data.md) and
  [your report](../users/participant/your-report.md).
