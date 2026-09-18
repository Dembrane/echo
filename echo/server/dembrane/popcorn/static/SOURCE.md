# Presentation sources

Copied from github.com/Dembrane/popcorn: `index.html`, `assets/app.js`,
`assets/planar.js`, `assets/styles.css`. First at commit 7c3d1cf (1 Sep 2026),
then re-merged at commit 8c23eba (5 Sep 2026) as a three-way merge against
7c3d1cf, so the embed patches below carried over without retyping.
`dembrane/popcorn/view.py` inlines the files the way upstream `tools/build.py`
does.

Patches carried on top of upstream, all guarded by `window.POPCORN_EMBED`:

- `fetchJson` reads every `data/<file>` from one `data/bundle.json` document
  (memoised for 250 ms), so a room full of viewers costs one request per poll
  instead of one per transcript. A hidden tab is a missing file in the bundle.
- Drag-and-drop ingestion and the localStorage restore are off: sessions from
  different projects share an origin here and must never bleed into each other.
- `renderQrPanel` draws `session.qr` (portal link as a brand QR, inline SVG
  with the logomark) on standalone pages. The Present shell safely regenerates
  the same configured URL in its shared frame.
- A tab whose file leaves the bundle leaves the deck (hosts hide tabs live).
- Host only: an unverified phrase with a `source` opens `showSourceTip`, the
  closest transcript passage, labelled as a reading aid, from the stage. The
  public bundle never carries `source`, so the room's page behaves exactly as
  upstream.
- `EMBED.version` makes the bundle request ask for a saved run, for replay.
- Presentation embeds accept a version 1 `dembrane-present-shell` bridge only
  from their configured parent origin, parent window and presentation id.
  `visibility` freezes and resumes stage and bilingual timers without
  unmounting; `block` selects only a configured Popcorn, Stakeholders or
  Tensions slide.
- The Present shell owns the whole persistent audience frame: navigation,
  notice, QR, localized progress and branding. Its deck embed suppresses those
  duplicate elements while retaining the stage and bridge behavior.
- The Present shell also owns the audience SSE subscription. Its validated
  `refresh` command enters the deck's coalesced, serialized bundle reader;
  shell-controlled embeds open no additional event stream or polling loop.
  The standalone deck retains its own SSE connection. Reads wait beyond the
  server cache window, including reconnect recovery, and preserve playback.
- After each applied bundle, the deck posts a version 1
  `dembrane-present-deck` `ready` event with its presentation id and a local
  revision. The shell replays visibility and block selection after validating
  the child window and origin.
- A version 1 `chrome` event carries localized progress, branding and QR
  labels as plain text. The shell validates the child window, origin and
  presentation id and renders these in its shared frame without HTML transfer.
- The empty-stage line says when a finished read found nothing (#1043).
- While the host presents fullscreen (`dembrane:popcorn:presenting`), the
  bundle request carries `view=room` and the server answers with the room's
  bundle: neutral labels, no passages, no links.
- A settled popcorn file is still applied when its revision or translation
  identity changes. A translation can arrive without another analysis
  revision; its target, policy and source identity also participate in the
  update check.
- Quotation marks only for a phrase the bundle marks `verbatim` (the room's
  words, word for word). A rooted paraphrase is plain; the disclaimer under
  the stage says so. Upstream draws marks on any `quoteId`.
- `?present=1` on the host view is the presenter view: `presenting` from the
  first paint, the room's bundle, no host affordance. The postMessage bridge
  (`dembrane:popcorn:presenting`, `dembrane:popcorn:settings`), the tab
  hide and show buttons and the QR corner are gone: every host control lives
  in the dashboard, and the deck edits nothing.
- The empty stage counts 3, 2, 1 to the first popcorn while the first read
  is in flight and holds the first phrase until the count ends; past the
  count with nothing landed it shows a spinner and sends one beacon
  (`data/latency`, `{ms}`) from the host's view.
- On standalone pages the QR panel floats over the whole deck on `body` (`position: fixed`,
  bottom right), whichever tab is up, foldable to a chip with its own button
  (the fold remembered in `localStorage` per path). A scroll into the keys
  shrinks it and sits its bottom edge on the top of the keys strip, following
  the strip as it slides; the moment the details (`.pop-tail`, `.deck-tail`)
  enter the viewport it is gone, so it never covers them; it comes back on
  the way up. The dashboard only says whether it is on; upstream draws it
  inside the popcorn stage with no controls. Presentation-shell embeds use the
  equivalent foldable QR in the shell's shared content frame.
- How the stage plays is one switch (`#pop-shuffle`, styled like a Mantine
  switch): off is upstream's "in order of time", charcoal, the thumb carrying
  the timer icon and the label reading "in order"; on is "at random", blue,
  the shuffle icon and "shuffle". Flipping it sends every phrase on stage off,
  so the new order starts clean. In order of time the cursor moves only once the
  phrase is on stage (`commit` after `spawnPop` returns true), so a spawn
  that finds no free band no longer skips a phrase. Upstream had two buttons
  and advanced the cursor before spawning.
- The tally lives in the footer: `renderProgress` prints popcorns, validated,
  held back and `reading n of m` after the conversation count. The controlled
  embed sends that localized plain text to its shared shell footer. The
  disclaimer is a callout at the bottom of the popcorn tab's scroll, under
  the long list. The count beside the search shows only the search result
  and what is hidden.
- Any change to a popcorn file redraws the list and the phrases on stage
  (`popcornStamp`, `refreshLivePops`): the second pass changes quotes, kinds
  and marks without changing the count, so the count alone was not the
  signal and a validated phrase stayed plain until the next interaction.
- The long list's count is a tally: popcorns, validated (with a `quoteId`),
  held back (`held_back` per file), and `reading n of m` while a second pass
  runs.
- One phrase size (`data-weight` 2, stepped down to 1 only to fit): the
  bundle carries no weight.
- `sample/` holds upstream `data/` verbatim for the Try it view.
- `flow.html` is not upstream: the account of what the tick does, served at
  `view/flow/` while `SERVE_API_DOCS` is on; the footer links to it when the
  host bundle says so (`session.host.flow`).

Two things upstream's 8c23eba merge changed on purpose:

- The long list is upstream's new one (grouped by conversation in time order,
  with hide toggles per phrase and per conversation, a histogram timeline with
  a crop window and a grip, the kind legend as a filter). The earlier
  platform-only grouping of the old list was superseded by it and dropped.
- Tensions render `knot` when the analysis provides one and fall back to the
  platform's `narrative` paragraph (`.tension-narrative` kept in styles.css),
  because the platform's tensions prompt still writes `narrative` and
  `toResolve`. Popcorn items carry `kind`, `question`, `qualifiers` and
  `quoteId` from the bundle; the icons, the one-word tooltip, the legend filter
  and the restored question mark need nothing beyond those fields.

To take a new upstream version: `git merge-file` the new files against the
upstream commit named here, resolve to upstream where the platform-only
change was superseded, re-check every patch above, and update the commit here.

Bilingual Popcorn patch: a translated bundle keeps `phrase` as the canonical
source text and attaches a policy-versioned `translation` to the same item.
The stage always renders the original first. Each visible language gets 3
seconds plus 0.5 seconds per word. Both states share one identity, position,
evidence link and focus target. An unheld appearance is capped at 24 seconds;
when both full intervals cannot fit, the translation takes the next fair slot.
Evidence, page visibility and the presentation shell pause both stage and
language timers. Reduced motion keeps the same intervals with an instant
handoff. Normal motion uses a 200 ms directional snap and controlled settle.

Opening patch: session.intro, session.disclosure and session.notice carry
host-written opening copy for any session: an intro, a disclosure with an
optional follow-up screen, then the countdown, and a notice bar that stays
across tabs and can reopen the opening. session.data is a last opening
screen, "what happens to your data", drawn from `illustrations/` beside the
page; its words come from the server. The bundle always includes the
disclosure and notice when session.demo.synthetic is set, and inside the
deck a demo reads like a real run: the frame and the opening carry its
provenance. A demo's QR opens dembrane's sales portal.

Localisation patch: the page's own words live in `I18N` at the top of app.js
(en and nl), with the de, fr, es, it, uk and cs audience dictionaries in
`audience-i18n.js`. A language has the same keys, and a missing key falls back
to English. They are read with `tr` and `trn` in session.language,
never applied to data. Counted strings pick their form with
`Intl.PluralRules`, and sentence templates (the stakeholder prose, relation
sentences, counts) keep word order and casing per language. session.date_iso
is formatted in that language and `<html lang>` follows it. With
session.translation the tally and the disclaimer say the texts were
translated (and how many are still pending), and the quote sentence calls
the quotes translations; a synthetic demo's disclaimer says its popcorns are
fictional. The opening's screens are history entries, `#intro/N`: back steps
back, a fresh load starts at screen 1, and an address never reaches a screen
this page load has not shown.

The six audience dictionaries are draft translations and require native-speaker
review before deployment, with particular attention to Ukrainian and Czech
plural forms. Automated tests enforce key and placeholder coverage, not wording.

- The Present bridge treats repeated current-block messages as acknowledgements, preserving the live phrase and bilingual timers across reconnects. The React room shell provides pause/resume through the timer-preserving visibility command.
