---
title: The portal editor
description: How a host configures the participant portal - onboarding, languages, key terms, anonymisation, verification, replies, and the QR/invite link.
audience: host
---

# The portal editor

The portal editor is where you shape what a participant sees and does when they record for a
project. Every screen of [the participant portal](./portal-and-participant-experience.md) - the
welcome cards, the consent text, the languages, what's asked of people, what they see at the
end - is set here. Configure it once per project, preview it live, then share the QR code or
link.

It lives at a project's *Settings → portal editor*. Editing needs a role that can edit projects
- *owner*, *admin* or *member* (and *external* collaborators on projects shared with them); see
[roles & permissions](./roles-and-permissions.md). Available on every
[tier](./tiers-and-billing.md).

## The experience

- *Tutorial* - which onboarding set the welcome cards show.
- *Language* - the portal's default language. You can also share per-language links. Note: this
  only changes the *intro screens* - the welcome, instructions and consent. Transcripts stay in
  the language people actually speak (see [transcription](./transcription.md)).
- *Default conversation title* - the title new conversations get.
- *Default description* - the intro text participants see.
- *Finish text* - the closing message on the completion screen.

## Transcript quality and privacy

- *Key terms* - the proper nouns, names and jargon you want transcription to get right. These
  are fed into the cleanup pass so a transcript spells "Janssen" and your acronyms correctly.
  Add anything that matters, including "dembrane" itself.
- *Anonymise transcripts* - strip identifying details so what's stored can be shared without
  exposing who said it.

> [!TIP]
> These two are the highest-leverage fields. Key terms sharpen every transcript in the project;
> anonymisation is a privacy decision best made before you collect. Set both before you print
> the QR code.

## What you ask participants for

- *Ask for name* and *ask for email* - whether onboarding collects each. Email is handy for
  sending a report or updates. Both are off unless you switch them on, keeping the
  [no-account](./portal-and-participant-experience.md) experience light.

## What dembrane generates

- *AI title & tags* - let a language model name and tag each conversation, so a long list stays
  navigable without manual filing.
- *Get Reply* - an audio-reply mode where dembrane responds to a participant, with its own mode
  and prompt so you control the tone.

## Verification

Let participants confirm what was drawn from their conversation - the participant, not the
model, decides how they're represented. Turn *verification* on, choose whether it shows on the
finish flow, and pick the *topics* (predefined or custom) people are asked to confirm.

## Notifications and tags

Offer participants a *subscription* to updates - great for post-event follow-up, since people
who leave an email get notified when reports are ready. And define the *tags* available for
conversations in this project.

## Preview, then share

A *live preview* shows the portal as you change settings, so you see exactly what a participant
gets. When you're happy, generate the *QR code and invite link* - print the QR for a venue, or
send the link by email. Both open the same
[participant portal](./portal-and-participant-experience.md).

> [!NOTE]
> Changes here affect *new* conversations from that point on. If you change key terms or turn on
> anonymisation after collecting, you can [re-transcribe](./transcription.md) existing
> conversations to apply it.

## Why each setting exists (intent)

Every field is here to steer one downstream behaviour. Knowing what a setting *drives*
tells you when to touch it and when to leave it. This is also the reference the project
onboarding assistant reads when it suggests changes.

- *Context* (project setting, not on this screen but the most important field): the
  purpose, audience and what you want to learn. It steers chat answers, report framing and
  the assistant's suggestions. Vague context weakens everything downstream, so write 2-5
  real sentences.
- *Language*: sets the language of the intro screens only. Its intent is the participant's
  first impression, not transcript language. Match it to who you're inviting.
- *Default conversation title / description / finish text*: the participant's framing
  before, during and after. Intent is clarity and trust - the finish text should say what
  happens with their contribution, so write it for a person, in their language.
- *Key terms* (`transcript_prompt`): the intent is transcript accuracy. These names and
  jargon feed the transcription cleanup pass, so anything spelled wrong here stays wrong in
  every transcript. Highest-leverage field for data quality.
- *Anonymise transcripts*: a privacy decision that changes what is stored. Set it before
  collecting; its intent is making transcripts shareable without exposing who spoke.
- *Ask for name / email*: intent is post-event contact and report delivery, traded against
  keeping onboarding light. Only turn on what you will use.
- *AI title & tags*: intent is navigability of a long conversation list, not analysis. Safe
  to leave on.
- *Get Reply*: intent is giving participants a response in the moment; the mode and prompt
  exist so you control tone. Only enable when you have decided what that reply should feel
  like.
- *Verification*: intent is participant agency - they, not the model, confirm how they're
  represented. Enable when representation accuracy matters more than a shorter finish flow.
- *Subscription*: intent is follow-up - people who leave an email hear when reports land.

## Related

- [The participant portal](./portal-and-participant-experience.md) - the experience these
  settings produce.
- [Transcription](./transcription.md) - how key terms and anonymisation feed the cleanup pass.
- [Projects](./projects.md) - the project these portal settings belong to.
