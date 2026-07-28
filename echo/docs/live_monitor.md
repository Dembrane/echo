# Live monitor

What this feature lets you do, from the perspective of the people using it.

When you run a session (a workshop, a consultation, a set of interviews), people
scan a QR code and record on their own phones, all at the same time. You cannot
stand behind each of them. The live monitor is the room you watch instead: it
shows every participant as they arrive, set up, and record, so you can see who
is going well, who is stuck, and who needs a hand, without interrupting anyone.

There is really one person in this story: the *host* (a project admin or
facilitator) watching a session happen. Everything below is what you, the host,
see and can do on the Monitor page. The participants just record as usual on
their phones; the monitor is your window onto that.

## Where to find it

Open your project and go to *Monitor*. The page also shows the project's QR
code, so you can put it on a screen for people to scan and join.

The page is live. It updates on its own as people scan, record, pause, and
finish. You never refresh. If the live connection drops for a moment it keeps
working on a slower update and shows a small *Reconnecting* note until it comes
back.

## The live participant flow

At the top is the flow: people moving left to right through three stages.

- *Scanned*: they opened the portal from the QR code.
- *Setting up*: they are moving through consent, the mic check, and entering
  their details.
- *Recording*: they have started a conversation and audio is being captured.

Each dot is a person. It is a live picture of where everyone is right now, so
you can see, for example, that ten people scanned but only three have started
recording, and go help the seven who are stuck in setup.

Click any dot to see more. A person still in setup shows a *visitor* card: what
they have done so far (scanned, accepted terms, mic checked or skipped or
blocked, entered details), each with a time, plus their device and any weak
network or low battery warning. A person who is recording opens the conversation
view described further down.

## The conversation list

Below the flow is the list of conversations, grouped by tag so a busy project
stays scannable. Within a group the rows keep a steady order (by when each
person started), so they do not jump around while you read them.

Each row is one participant, and it is built to answer a host's questions at a
glance.

### What state they are in

A colored pill tells you what the person is doing right now: *Recording*,
*Paused*, *Verifying*, *Exploring*, *Typing*, *Finishing*, *Finished*,
*Waiting*, *Just started*, *Away* (their screen is locked or the tab is hidden),
*Left* (they closed the tab), or *Offline* (we have lost contact). The recording
pill gently pulses so an active recording is easy to spot.

### How long they have recorded

A small clock shows the recorded length, with a state-colored dot beside it. It
counts up while they record, holds still while they are paused, and settles on
the final length when they finish. It only ever shows real recording time, so a
paused or not-yet-started session never drifts upward.

### Whether audio is really coming in

While someone is recording, a small microphone meter shows how loud their mic
is. Lit bars mean audio is flowing; empty bars mean it is very quiet, which is
your cue to check they are not muted. It reflects the loudest moment over the
last few seconds, so a natural pause between sentences does not read as silence.

### What they are saying

The most recent line of their transcript fades in under the pill, so you can
follow the gist without opening anything. If a conversation is anonymized,
personal details in that line are shown as redaction badges rather than the
original words. On some plans, transcripts for new conversations are locked; the
row shows a prompt to upgrade instead of the text.

### When something needs attention

Warnings surface right on the row so you can act:

- *Audio stopped?*: they were recording but nothing has arrived for a while.
  They may have lost connection or locked their phone.
- *Screen locked*: their screen is locked or the tab is hidden, so recording is
  paused until they come back. This is gentle, not an alarm.
- A weak-network or low-battery icon when their device reports one.
- *Error*: some recent audio could not be transcribed. The recording itself is
  still saved.

### How transcription is going

A badge shows transcription progress: *Transcribing N clips* while it catches
up, or *Transcribed* once a conversation's audio is done. A language tag shows
the detected or chosen language.

## The summary line

Across the top of the list is a running count so you can gauge the whole session
without reading every row: how many are *live*, how many are *offline*, how many
have *audio stopped*, how many are *transcribing*, how many have *errors*, and a
rough *catch up ~N min* estimate for how long the transcription backlog will take
to clear. The estimate is deliberately conservative, so it never over-promises.

## Opening a conversation

Click a row (or its pencil) to open the conversation. From here you can:

- *Rename* the participant, so an anonymous row becomes a name you recognize.
- *Edit tags*, to group or re-group the conversation on the fly.
- See the *timeline*: their journey (scanned the QR, accepted terms, mic
  checked, entered details), then when they joined the conversation, started
  recording, and were last heard.
- *Delete* the conversation, with a confirmation first. Deleted conversations
  disappear from the monitor and the flow right away.
- *Open conversation* to jump to the full conversation view.

## Privacy and what stays hidden

- Anonymized conversations have personal details redacted in the live transcript
  line, shown as badges instead of the words.
- On plans where transcripts are gated, the monitor shows the state and progress
  of a conversation but not its transcript text, with a prompt to upgrade.
- Deleted conversations are never shown here.

## At a glance

| | What it tells you |
|---|---|
| Participant flow | Where everyone is: scanned, setting up, or recording |
| State pill | What each person is doing right now |
| Recording clock | Real recorded length, paused-aware |
| Mic meter | Whether audio is actually coming in |
| Transcript line | The latest words, redacted where anonymized |
| Warnings | Audio stopped, screen locked, weak network, low battery, errors |
| Transcription badge | How far along transcription is, and a backlog estimate |
| Conversation view | Rename, edit tags, timeline, delete, open |
| Updates | Live, on their own, with automatic reconnect |
