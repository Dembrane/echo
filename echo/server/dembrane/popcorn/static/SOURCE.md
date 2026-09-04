# Presentation sources

Copied from github.com/Dembrane/popcorn at commit 7c3d1cf (1 Sep 2026):
`index.html`, `assets/app.js`, `assets/planar.js`, `assets/styles.css`.
`dembrane/popcorn/view.py` inlines them the way upstream `tools/build.py` does.

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
  closest transcript passage, labelled as a reading aid. The public bundle
  never carries `source`, so the room's page behaves exactly as upstream.
- `EMBED.version` makes the bundle request ask for a saved run, for replay.
- `sample/` holds upstream `data/` verbatim for the Try it view.

To take a new upstream version: copy the four files again, re-apply the
patches above, and update the commit here.
