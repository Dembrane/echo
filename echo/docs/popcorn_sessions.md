# Popcorn sessions: manual and live

What this feature lets you do, from the perspective of the people using it.

Popcorn is a screen for a room: short phrases from the project's
conversations, popping up one at a time on a wall, with a tensions slide and
a stakeholder map behind it. A *session* is the popcorn for one project. It is
read on demand: you run it, you look at the screen, you refresh it when more
conversations have landed. Reading every two minutes is a choice you make for
an event, for as long as you say, and it switches itself off afterwards.

There are two people in this story: the *host*, who runs the session from the
dashboard, and the *room*, which sees the screen and nothing else.

## Two modes

- **Manual.** The default. Nothing is scheduled. *Refresh* reads the
  conversations once (the changed ones, plus any check still owed). *Rerun*
  wipes every phrase, tension and stakeholder and reads everything again;
  earlier runs are saved in the history.
- **Live.** A read every two minutes for 1, 8 or 24 hours, then back to
  manual. While live, the dashboard shows the clock to the next read and a
  *Stop live* control.

A session never ends. When live runs out, the screen stays exactly as it is
and Refresh keeps working.

## If you are a host

You run popcorn from the project's Library, on the Popcorn page.

**Before a session exists** the page says what a first read would find ("13
conversations with a transcript, about 15 minutes of talk. Ready."), asks for
a title and, if you want, a voice for the phrases, and offers one button:
*Run*. Run creates the session in manual mode and reads once. A project with
no transcripts can still run; the screen fills as conversations land.

**Once a session exists** the page is the control surface:

- **Open presenter view** opens the screen in its own browser tab, full
  size, exactly as the room sees it: numbered conversations unless you say
  otherwise, no passages, no controls. Open it on as many screens as you
  like. The screen is never shown inside the dashboard.
- **Refresh**, **Rerun** and **Go live** as above. Rerun asks first, and
  says that earlier runs stay in the history. A rerun pressed while a read is
  running still reruns: the wipe happens inside the read, under its lock.
- **Status**: conversations, phrases, how many are validated, how many were
  held back, the last read and what it did, and a progress bar while the
  check is running.
- **Screen**: the tensions tab, the stakeholders tab, the QR code, names on
  the legend (off numbers the conversations; on shows the name typed on the
  phone, which may be a person's), and the dembrane mark (a Changemaker plan
  can take it off). Every switch lands on the wall at its next poll.
- **Voice**: the title and how the phrases should sound. Changing the voice
  re-reads every conversation on the next read.
- **Share**: the public page switch, the link, the embed code.
- **Earlier runs**: every run that changed the screen, each opening the
  presenter view of that run in its own tab. A rerun keeps them.

## What the room sees

The first time a session reads, the empty stage counts **3, 2, 1** and the
first phrase lands as the count ends. If the first phrase is late, a spinner
takes over and the host's browser sends one note of the delay, so the team
can see how often that happens.

A phrase in **"quotation marks"** is the room's words, word for word. A phrase
without them paraphrases a passage of the conversation; a check in the
background finds that passage, and a phrase for which no passage can be found
is taken off the screen (the host sees it as *held back*). The long list under
the stage carries the tally: how many phrases, how many validated, how many
held back, and how many conversations are still being read, in the footer.

Every phrase is the same size on the wall; a long one steps down only to fit.
As the background check lands, the phrases on stage and in the list pick up
their icons and quotation marks by themselves, and the tally moves.

When the QR code is on, it floats bottom right over the whole screen,
whichever tab is showing, full size while the slide is up. Scrolling into
the keys shrinks it; scrolling into the list hides it; it comes back on the
way up. Whoever is at the presenter view can also fold it away to a small
chip, remembered in that browser. The dashboard only decides whether it is
on at all.

Under the stage, one switch says how the popcorns play: off, in the order
they were said, whatever the conversation, none skipped; on, shuffled, with
the conversations taking turns. The footer carries the tally (popcorns,
validated, held back, still reading) and the disclaimer about quotation
marks.

## If you are working on it

A session is a `project_report` of kind `popcorn` with one `agent_loop`. The
loop's `status` carries the mode: `paused` is manual, `active` is live. The
legacy statuses (`expired`, `ended`, `stopped`) read as manual. `expires_at`
is only read by the scheduled chain: a scheduled tick past it sets the loop
to `paused` and no-ops; a manual tick (run, refresh, rerun) goes ahead in any
mode at any time. A tick is scheduled or on request (`manual` for run and
refresh, `rerun`); the rerun wipes the state itself, under the run lock, so a
read in flight cannot write the old state back over it.

The BFF routes under `/v2/bff/popcorn`:

| Route | What it does |
|---|---|
| `GET ?project_id=` | the session, or `{"popcorn": null, "readiness": {"conversations", "words"}}` before one exists |
| `POST` | create in manual mode and read once |
| `POST /{id}/refresh` | one read now; one per twenty seconds |
| `POST /{id}/rerun` | queue a `rerun` tick: the state is wiped under the run lock, then everything is read; the run counter continues; saved runs kept; one per twenty seconds, apart from refresh |
| `POST /{id}/live` | body `{"hours": 1 \| 8 \| 24}`; active with that expiry, reads now |
| `POST /{id}/live/stop` | back to manual |
| `PATCH /{id}/settings` | title, client, tabs, public, show_qr, show_branding, public_labels, voice |
| `GET /{id}/view/?present=1` | the presenter view; `&version=` replays a saved run |
| `POST /{id}/view/data/latency` | the deck's beacon; recorded as the PostHog event `popcorn_first_phrase_late` |

The payload's `loop.mode` is `"manual"` or `"live"`; `counts` carries
`validated` and `held_back`. A phrase the second pass could not root moves from
the conversation's `items` to `review.dropped` on the state, with the model's
reason; the bundle carries `held_back` as a count per conversation and never
the text. The prompts are not part of any fingerprint: a new prompt version
applies to conversations read after it ships, and to a rerun, and re-reads
nothing on its own.

The step-by-step account of what a read does to a session's words is the
flow page at `view/flow/`, served while `SERVE_API_DOCS` is on. The dashboard
lives in `frontend/src/components/popcorn/`, one component per section.

## At a glance

| | Manual | Live |
|---|---|---|
| Loop status | `paused` | `active`, with `expires_at` |
| Reads | Refresh, Rerun, Run | every two minutes, and Refresh |
| Ends | never | at the expiry, back to manual |
| Set with | Run, Stop live | Go live, then 1, 8 or 24 hours |
