# Popcorn session lifecycle and dashboard

Design, September 5th 2026, for the second half of Dembrane/echo PR #1044.
Written by Oren from Jorim's brief and approved in chat. The first half of
the PR (the pipeline, the evidence invariants) is described by the flow page
at `view/flow/`; this document covers how a session is started, read, shown
and configured.

## Why

Today a popcorn session is born live: it reads every two minutes until an
expiry, the dashboard page shows the deck in a cramped box with a Full screen
button, and the host's controls are bolted onto the deck itself (hover a tab
to hide it, a corner for the QR code). Two things are wrong with that. A host
who wants one read of a finished session pays for a schedule they never asked
for, and the deck carries controls that do not belong on a wall.

The new shape: a session is read on demand, live reading is a deliberate
choice with a duration, the deck is only ever shown full screen in its own
browser tab, and every host control lives in the dashboard.

## Lifecycle

A session is a `project_report` of kind popcorn with one `agent_loop`, as
before. The loop's `status` carries the mode:

| Mode | `status` | What happens |
|---|---|---|
| manual (default) | `paused` | Nothing is scheduled. Refresh runs one tick. Rerun wipes and runs one tick. |
| live | `active` | The two-minute chain runs until `expires_at`, then the loop goes back to manual. |

Legacy statuses (`expired`, `ended`, `stopped`) read as manual. A session
never "ends": the deck stays up and Refresh keeps working. `expires_at` is a
not-null column; in manual mode it holds the time the session was created or
last stopped, and nothing reads it. Only a scheduled tick checks expiry; when
one finds it passed it sets the loop to `paused` and no-ops. A manual tick
never refuses on expiry.

Actions, all on the dashboard and none on the deck:

- **Run** (before a session exists): create the session in manual mode and
  fire one manual tick.
- **Refresh**: one manual tick, rate limited to one per twenty seconds as
  today. Reads changed conversations, pays owed second passes, redoes stale
  analysis views.
- **Rerun**: reset the live state (phrases, quotes, analysis; the run counter
  continues so saved runs stay in order) and fire one manual tick. Earlier
  runs are saved in the history. The dashboard asks first.
- **Live**: choose 1, 8 or 24 hours; the loop becomes `active` with that
  expiry and reads straight away. While live the dashboard shows the next
  read's countdown and a Stop live control. Stop live returns to manual.

## Start

Before a session exists, the project popcorn GET carries `readiness`: how
many conversations have a transcript, and roughly how much talk that is (a
word count, shown as minutes at 150 words a minute). The start page shows
that line, the title, the voice fields, and Run. A project with no
transcripts can still Run; the page says the deck will have nothing to read
until a conversation lands. The duration picker is gone from start; it
belongs to Live.

## Dashboard page

The iframe, the Full screen button and the postMessage bridge that let the
deck edit settings are removed. The page is a control surface:

1. Title, Beta badge, and a status line: conversations, phrases, validated,
   held back, last read; while live, "live until" and the cadence.
2. Actions: **Open presenter view** (large, opens the deck in a new browser
   tab), Refresh, Rerun, Live (distinct style, a menu of durations; while
   live, the countdown chip and Stop live).
3. Screen: switches for the tensions tab, the stakeholders tab, the QR code,
   names or numbers on the legend (`public_labels`), and the dembrane mark
   (tier gated as today).
4. Voice: the presets and the free note, as today, with Save.
5. Share: the public switch, the link, the embed code, open the public page.
6. Earlier: saved runs, newest first, each opening the presenter view of that
   run in a new tab.
7. Status: the last run's detail line and the validation progress
   ("reading 2 of 4 conversations", "26 of 28 validated").

The route file is split: one component per section under
`frontend/src/components/popcorn/`, the route composes them.

## Presenter view

`GET /v2/bff/popcorn/{id}/view/?present=1` is the deck in presenting mode
from the first paint: the room's bundle (`view=room`), neutral labels when
the setting says so, no passages, no host affordances. The message listener
that used to switch presenting on and off is removed; the query parameter is
the only switch. `?version=` still replays a saved run. The public page is
untouched.

## Deck

- Quotation marks only for a phrase the bundle marks `verbatim`. A rooted
  paraphrase is plain. The passage mark (`.pop-mark`, ❝) and its style are
  removed; the disclaimer says: popcorns in "quotes" are the room's words,
  word for word; the rest paraphrase what was said.
- One phrase size. `weight` leaves the bundle; the deck's step-down-to-fit
  keeps working from the one size.
- A countdown on the empty stage while the first read is in flight: 3, 2, 1,
  then the first phrase. The first phrase is held until the count ends. If
  nothing has landed at zero, a spinner replaces the count with "the first
  popcorn is taking longer than usual", and the deck sends one beacon
  (`POST view/data/latency`, `{ms}`) that the server records as the PostHog
  event `popcorn_first_phrase_late`. The count runs only when the session has
  no phrase yet and a read is in flight, so a rerun counts down again and a
  finished read that found nothing does not.
- The long list's header is a tally: `28 popcorns · 26 validated · 2 held
  back`, with `reading 2 of 4` while a second pass is running.

## Extractor

Prompt file `popcorn-v1.7.md`: v1.6 without the Weight section. The schema
and the shaper drop `weight`; `shape_popcorn_items` no longer awards or caps
it; between two twins the first kept wins. The bundle emits no `weight`. The
prompt text is not part of any fingerprint (commit 4a07df65 had put it
there for one evening; it comes out again here, at Jorim's request): a
prompt change re-reads nothing on its own. It applies to conversations read
after the deploy, and to a Rerun.

## Held-back phrases

After the second pass, a phrase whose passage could not be found in the
transcript leaves the deck: it moves from `items` to `review.dropped` on the
conversation's state entry, with the model's reason, for the host. The
bundle carries `held_back` (a count) per conversation so the tally can show
it in the room's view without the text.

## API

| Route | Change |
|---|---|
| `GET /popcorn?project_id=` | adds `readiness` when `popcorn` is null |
| `POST /popcorn` | `expires_at` and `cadence_minutes` optional and ignored; creates in manual mode |
| `POST /popcorn/{id}/refresh` | unchanged |
| `POST /popcorn/{id}/rerun` | new: reset the live state, fire a tick; same rate limit as refresh |
| `POST /popcorn/{id}/live` | new: body `{hours: 1 \| 8 \| 24}`; active with that expiry, reads now |
| `POST /popcorn/{id}/live/stop` | new: back to manual |
| `POST /popcorn/{id}/view/data/latency` | new: the deck's beacon |
| `PATCH /popcorn/{id}/settings` | accepts `public_labels` |
| `POST /popcorn/{id}/loop/{action}`, `PATCH /popcorn/{id}/loop` | removed |

`loop` in the payload gains `mode: "manual" | "live"`; `counts` gains
`validated` and `held_back`.

## Out of scope

The recommendations tab (the platform does not produce the slide yet), prompt
text overrides (the voice note is the override), the public page, and the
flow page's footer link (it is still served at `view/flow/` locally; the
presenter view no longer links to it).

## Testing

Server: unit tests beside the existing ones (`test_popcorn_service.py` new;
`test_popcorn_ticks.py`, `test_popcorn_analysis.py`, `test_popcorn_flags.py`
extended) for readiness, the rerun reset, live and stop, expiry back to
manual, the manual tick ignoring expiry, held-back phrases, the tally, no
weight anywhere. The BFF has no HTTP tests today; the endpoints are proven on
the local stack in the Browser pane. Frontend: no popcorn tests exist; the
page is proven in the Browser pane (start, run, countdown, refresh, rerun
modal, live and stop, presenter tab, every switch).
