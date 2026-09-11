# Release notes

`getReleases()` is the curated customer-facing history, newest first. The popup
shows its first entry. The Release notes page keeps every entry, grouped by
publication month in a timeline.

Set `highlight: true` for important product milestones. These display a
"Highlight" badge and a prominent card, regardless of semver. Other patch
tags (a nonzero third number) use compact rows, with all notes and links still
available. Feature releases use regular cards. Undated drafts sit under "Next"
until they have a publication date.

Each release has a `changes` list with one customer-facing change per item:

- `feature`: a new capability, grouped under "New features".
- `improvement`: a refinement of an existing capability, grouped under "Improvements".
- `fix`: a correction to broken behaviour, grouped under "Bug fixes".

Classify each item by its actual effect, not a commit prefix or the release's
version. A patch can contain a feature; the compact layout does not hide it.
Keep beta and access-on-request qualifications from the launch announcement.
Show each category once, omit empty groups and combine overlapping descriptions
of the same feature. Within each group, preserve the editorial order.
The popup and the history render the same `changes` list. Use `description`
only for an optional introduction or legacy Markdown notes. Long releases are
deliberately complete rather than collapsed behind a "more" control.

## Entry and dismissal

The shared sidebar's What's new action opens the modal; Go to previous
release notes opens the history inside the regular app layout, with a Home / Release notes
breadcrumb. Both desktop and mobile use the same sidebar and navigation.

Closing via the close control, Escape, backdrop, or Go to previous release
notes records
the current dismissal key under `app_user.settings.release_video_seen`. A
browser fallback scoped to the authenticated Directus user preserves dismissal
through reloads and failed saves. The server setting shares it across devices
once saved. Missing or loading profiles never trigger an automatic popup.
Manual opening always remains available. A new first entry with a new key shows
once again; copy edits, translations, publication metadata and older backfills
keep the same key and do not reopen it. Adding a release requires deploying the
updated app; this is not a live Directus feed.

## Publishing

1. Prepend a release in `releases.ts`, with a stable `version` dismissal key,
   headline and classified `changes`. Video is optional.
2. Until the GitHub release is published, omit `publication`. The UI says
   "Upcoming" and does not invent a version, date or GitHub release URL.
3. When published, add `publication: { tag, date }` using the exact GitHub tag
   and its UTC publication date (`YYYY-MM-DD`). The version links to GitHub.
4. Run `pnpm messages:extract`, translate new strings, then run
   `pnpm messages:compile`.

Keep dismissal keys stable when enriching an existing announcement. The August
walkthrough keeps `version: "2026-08"` while displaying its actual `v2.2.0` tag.
Popcorn keeps its `2026-09` key while displaying its `v2.4.0` tag.
Adding old releases never changes the first entry or its seen state.

The Popcorn draft includes the non-member project-sharing fix from
[PR #1060](https://github.com/Dembrane/echo/pull/1060), and the summary retry fixes from
[PR #1029](https://github.com/Dembrane/echo/pull/1029). The transcription retry
bullet covers [PR #1034](https://github.com/Dembrane/echo/pull/1034).

## Backfill

Sources are GitHub's [published release history](https://github.com/dembrane/echo/releases)
and previously sent product announcements in Directus. Use the sent announcement
for product names and launch wording; use GitHub for exact tags and release dates.
Read GitHub using `gh api --paginate repos/dembrane/echo/releases`. Each entry in
`releaseHistory.ts` has a link to its own source through its tag. Summaries are
editorial descriptions of changes in that release, not a promise that historical
features remain available under the same name or plan today.

The Directus review covered all 14 English announcements, including expired ones.
Four product announcements match the release history:

| Release | Sent announcement | Directus announcement ID |
| --- | --- | --- |
| `v1.17.0` | What's new in dembrane (2026-04-14) | `c97f948e-baa7-4c68-a632-6835736e31ef` |
| `v1.15.0` | New look, new features (2026-02-19) | `b0db29e9-5138-4db7-ba9c-0b4408d9bbdd` |
| `v1.14.0` | New: Select Multiple Conversations in chat (2026-01-30) | `ad0f84a4-365e-4275-8ef9-7f7f329f2c14` |
| `v1.8.0` | New Features & Improvements (2025-08-12) | `cb359cec-1c6a-4bde-84bd-4f0bc0f21f39` |

The April announcement is the source for scheduled reports and custom chat
templates launching in beta, plus Ukrainian chat support. The August announcement
also recaps the Library, which appeared in `v1.7.0`. Do not shift release dates to
match announcement dates. Service outages, maintenance and holiday notices are
not release entries. No Organization announcement was found in Directus; that
entry retains the existing in-code structure walkthrough and the requested title.

Include feature releases, useful recording/access/reliability fixes, language
expansions and the first major release. Omit empty notes, deployment-only changes,
prereleases and patch notes that only duplicate a preceding feature release.
The "All releases on GitHub" link retains access to the complete technical history.

Two source details matter:

- `v2.1.0` has an annotated Git tag but no GitHub Release object. Its summary
  comes from the annotation and its date from the tagger timestamp. Set
  `source: "tag"` so the link opens the tag instead of a missing release page.
- The May 2025 release is tagged `v1.5`, although its release title says
  `v1.5.0`. Preserve the actual tag so the link resolves.

The August walkthrough first shipped in `v2.2.0`. Keep it there as a walkthrough
of the structure introduced earlier in `v2.0.0`, alongside the actual `v2.2.0`
changes. The popup's old seen key stays valid.


## Pilot acknowledgement

`PilotHistory` ends the full history (and the oldest year's view) with a 2024
acknowledgement of the archived `dembrane/pilot` repository. Its versions belong
to a different repository and must not be inserted into this release feed.
Highlights were checked against its published releases:

- [Pilot v1.0.0](https://github.com/Dembrane/pilot/releases/tag/v1.0.0), 8 May 2024: participant portal.
- [Pilot v1.0.1](https://github.com/Dembrane/pilot/releases/tag/v1.0.1), 17 May 2024: text contributions and post-conversation forms.
- [Pilot v1.0.7](https://github.com/Dembrane/pilot/releases/tag/v1.0.7), 6 August 2024: project/conversation search and branded QR codes.
- [Pilot v1.0.8](https://github.com/Dembrane/pilot/releases/tag/v1.0.8), 18 September 2024: conversation chat.
