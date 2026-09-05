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
  with the logomark) on the popcorn stage; `.qr-panel` styles were added.
- A tab whose file leaves the bundle leaves the deck (hosts hide tabs live).
- Host only: an unverified phrase with a `source` opens `showSourceTip`, the
  closest transcript passage, labelled as a reading aid, from the stage. The
  public bundle never carries `source`, so the room's page behaves exactly as
  upstream.
- `EMBED.version` makes the bundle request ask for a saved run, for replay.
- The empty-stage line says when a finished read found nothing (#1043).
- While the host presents fullscreen (`dembrane:popcorn:presenting`), the
  bundle request carries `view=room` and the server answers with the room's
  bundle: neutral labels, no passages, no links.
- A settled popcorn file is still applied when its revision moved: on the
  platform a conversation can be re-read after its transcript grows.
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
