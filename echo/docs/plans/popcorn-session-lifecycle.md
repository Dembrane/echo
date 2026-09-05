# Popcorn: sessions manual by default, live by choice

## Status

Implemented on PR #1044 (2026-09-06), commits `4cb82c15` onward
(the later ones fix what Jorim's first look and first run-through found:
the rerun's wipe moves into the tick, the button says Go live, the QR panel
floats and folds, the second pass reaches the screen without a click). The feature as shipped is described in
`docs/popcorn_sessions.md`; this is the plan it was built from, kept for the
reasoning. Written by Oren from Jorim's brief and approved in chat on
2026-09-05.

## Context

Before this, a popcorn session was born live: `create_popcorn` set the loop
`active` with an expiry, the scheduled chain read every two minutes until the
expiry, and then the session was `expired` and refused every read. The
dashboard page showed the deck in an iframe of `calc(100vh - 300px)` with a
Full screen button, and the host's controls were on the deck itself: hover a
tab to hide it from the room, a corner button for the QR code, both posting
`dembrane:popcorn:settings` back to the parent page.

Two things were wrong. A host who wants one read of a finished session paid
for a schedule they never asked for (and lost the deck when it expired). And
the deck carried controls that do not belong on a wall; the iframe made it
hard to judge what the room would see.

The extractor also asked the model for a weight of 1 to 3 per phrase, with at
most one 3, and the wall sized phrases by it. Astra's review of the pipeline
(2026-09-05) found the weight uncalibrated and that it decided which of two
twin phrases survived; Jorim asked for it to go.

## Goals

- A session reads on demand. Run reads once; Refresh reads again; Rerun
  wipes and reads again, keeping the saved runs.
- Live is a deliberate choice with a duration (1, 8 or 24 hours), visibly
  different from the default, and switches itself off into manual.
- The deck is only ever shown full screen in its own browser tab, as the room
  sees it. Every host control lives in the dashboard.
- The wall shows quotation marks only for the room's words verbatim, takes a
  phrase nothing supports off the screen, and counts what it validated.
- A countdown to the first popcorn, and a record when it is late.
- No weights.

## Non-goals

- The recommendations tab: the platform does not produce that slide yet.
- Prompt text overrides per session: the voice note is the override.
- The public page: untouched.
- Re-reading sessions when a prompt changes: Jorim's explicit call is that a
  new prompt version must not re-read a running session. It applies to
  conversations read after it ships, and to a rerun.

## Decisions

- **The loop's status carries the mode.** `paused` is manual, `active` is
  live. No new column, no new collection; the legacy statuses read as manual.
  `expires_at` is not nullable, so in manual mode it holds the time the
  session was created or last stopped, and nothing reads it.
- **Only the scheduled chain honours expiry.** A scheduled tick past
  `expires_at` sets the loop to `paused` and no-ops ("Live ended; back to
  manual"); `_enqueue_next_if_due` does the same instead of writing
  `expired`. A manual tick never refuses.
- **Rerun is a tick of its own kind.** The request dispatches a `rerun`
  tick; the tick wipes the state itself, once it holds the run lock, with the
  previous run counter so the versions stay in order, then reads everything.
  The first version did the wipe in the API before dispatching, and a read
  already in flight wrote the old state straight back over it, so a rerun
  pressed during a read appeared to do nothing (found by Jorim on
  2026-09-06). Refresh and rerun have separate rate-limit keys. The dashboard
  asks first and says the history stays.
- **The presenter view is a query parameter.** `?present=1` on the host view
  sets `presenting` from the first paint (the room's bundle, `view=room`, no
  host affordance). The postMessage bridge, the tab hide/show buttons and the
  QR corner are removed from the deck. `?version=` still replays a saved run.
- **Quotation marks for verbatim only.** `verbatim` in the bundle marks a
  phrase that is in the transcript word for word. A rooted paraphrase is
  plain. Jorim tried the ❝ passage mark for paraphrases and found it odd; it
  is gone.
- **An unrooted phrase leaves the deck.** After the second pass,
  `apply_results` marks `rooted: false` when the pass answered and found no
  passage; `_enrich_one` moves those items to `review.dropped` with the
  model's reason. The bundle carries `held_back` as a count.
- **The countdown is honest.** 3, 2, 1 runs only while the first read is in
  flight and nothing has landed; the first phrase is held until the count
  ends. Past the count with nothing landed: a spinner, and one beacon from
  the host's view (`POST view/data/latency`, `{ms}`) that the server records
  as the PostHog event `popcorn_first_phrase_late`. A conversation that left
  the session takes its phrases with it on the deck, so a rerun empties the
  stage and counts down again.
- **Weights go entirely.** `popcorn-v1.7` is v1.6 without the weight section;
  the schema, the shaper, the bundle and the deck follow. Between twins the
  first kept wins. One phrase size on the wall, stepped down only to fit.
- **The QR panel belongs to the presenter view.** It floats over the whole
  deck on `body`, draggable, foldable to a chip, with its place and fold
  remembered in `localStorage` per path. The dashboard switch says whether it
  is on; where it sits and whether it is folded is the business of whoever is
  at the wall (Jorim's first run-through, 2026-09-06).
- **Any change to a popcorn file redraws the screen.** The deck used to redraw
  the list only when the number of phrases changed; the second pass changes
  quotes, kinds and marks without changing the count, so validated phrases
  stayed plain until the next click (found on the same run-through).
  `popcornStamp` (revision, validated, count per file) is the signal, and
  `refreshLivePops` redraws the phrases already on stage from the data as it
  is now, by item id, fading one the pass held back.
- **Prompts leave the fingerprints.** Commit `4a07df65` had put the prompt
  text into every conversation's fingerprint so a prompt change re-read the
  session; that is reversed here.

## How it works

### Lifecycle

`create_popcorn` creates the loop `paused` with `expires_at = now` and
dispatches one manual tick. `go_live(loop, hours=)` sets `active` with
`now + hours`, clears the failure count and dispatches a tick;
`stop_live(loop)` cancels pending popcorn tick tasks and sets `paused`.
`request_rerun(loop)` dispatches the `rerun` tick. `readiness(project_id=, ...)` reuses the
tick's gather and returns conversations with a transcript and their word
count (the dashboard says minutes at 150 words a minute). `loop_payload`
carries `mode`; `state_counts` carries `validated` (items with a `quoteId`)
and `held_back`.

### API

`GET /popcorn?project_id=` carries `readiness` when `popcorn` is null.
`POST /popcorn` ignores `expires_at` and `cadence_minutes` from older
clients. New: `POST /{id}/rerun` (a twenty-second rate limit of its own),
`POST /{id}/live` (`{hours}`, 422 outside 1/8/24), `POST /{id}/live/stop`,
`POST /{id}/view/data/latency` (the body read by hand, because `sendBeacon`
may post it as text). `PATCH /{id}/settings` accepts `public_labels`. Removed:
`POST /{id}/loop/{action}` and `PATCH /{id}/loop`.

### Dashboard

`PopcornRoute.tsx` composes one component per section from
`frontend/src/components/popcorn/`: `PopcornStart` (readiness, title, voice,
Run), `PopcornActions` (Open presenter view, Refresh, Rerun with its modal,
Go live with the duration menu, the live chip with Stop live), `PopcornStatus`,
`PopcornScreenSettings` (tabs, QR code, names on the legend, the mark),
`PopcornVoiceSection`, `PopcornShare`, `PopcornHistory`, `PopcornIntroModal`.
The hooks gain `popcornPresenterUrl`, `useRerunPopcornMutation`,
`usePopcornLiveMutation`, `usePopcornStopLiveMutation`; the go-live,
lifecycle and loop-settings mutations are gone. `useProjectPopcorn` returns
`{popcorn, readiness}` and polls only while live.

### Deck

`static/app.js`: `presenting` from the query; `quotedPhrase` draws marks for
`verbatim` only; `renderWaiting` draws the count, the spinner and the beacon;
`renderPopTables` prints the tally; the session poll prunes popcorn files for
conversations no longer in the session; `data-weight` is 2 for every phrase.
`static/SOURCE.md` lists each of these as a patch over upstream.

## Testing

Server: `tests/test_popcorn_service.py` (new: manual creation, live and stop,
legacy statuses, the rerun dispatch, readiness), `tests/test_popcorn_ticks.py`
(a scheduled tick past expiry returns to manual, a manual tick ignores expiry
and books nothing, a rerun tick wipes under the lock and re-reads everything,
a phrase without a passage leaves the deck),
`tests/test_popcorn_analysis.py` and `tests/test_popcorn_flags.py` (no
weight, the first twin wins, `held_back` in the bundle),
`tests/test_popcorn_view.py` (the presenter switch, no host bridge). 87
popcorn tests, ruff and mypy clean; `tsc` clean on the frontend.

Proven on the local stack in the Browser pane: run on a project without a
session (readiness line), refresh, rerun with the count caught at 3, 2, 1
and the first phrase after it, live for an hour and stop from the dashboard,
a Screen switch round-tripping to the server, the presenter tab presenting
from the first paint with no host button on it.

## Known edges

- A worker restart mid-tick leaves the run lock for up to five minutes. A
  Refresh in that window is accepted and waits on the lock; the read lands
  when it expires. Seen once while testing, after a restart of the local
  stack.
- The flow page's footer link (`session.host.flow`) is offered by the host
  bundle only; the presenter view fetches the room's bundle and never shows
  it. The page is still served at `view/flow/` locally.
