# Release videos

Two videos, recorded from the real app by a script, so each release re-records them instead of re-editing them:

- **Onboarding**: a new user's first walk through dembrane. It belongs behind the "watch the tutorial" onboarding step.
- **What's new**: the release's own cards (numbers, headlines) plus the onboarding scenes that show what changed. It goes in the release's `videoUrl` in `src/components/release/releases.ts`.

Both come in English and Dutch, as 1920x1080 MP4s with a WebVTT caption file each, and optionally a copy with the captions drawn in.

## Record

You need the local stack from `dembrane/platform/README.md` (Postgres, the API on :8080), a production build of the dashboard served on :5173 and the portal on :5174, Chromium and ffmpeg. From `dembrane/frontend`:

```sh
pnpm build
(cd ../platform && PORT=5173 bun --env-file=.env.local apps/web/src/main.ts) &
(cd ../platform && PORT=5174 WEB_ROLE=portal bun --env-file=.env.local apps/web/src/main.ts) &
pnpm videos --burn
```

`pnpm videos` seeds the local database first (`apps/migrate/src/video-seed.ts`: an ordinary user, Alex Morgan, who owns the Millbrook and best practices samples) and removes whatever the previous recording created. It writes to `videos/out/<release>/`:

- `onboarding.en.mp4`, `onboarding.en.vtt`, and `.captioned.mp4` with `--burn`
- the same for `whats-new` and for `nl`
- `<lang>/clips/<scene>.mp4`: every scene on its own

Options: `--langs en`, `--videos whats-new`, `--only keyboard,portal` (records only those clips, for working on a scene), `--release v3.0.0`, `--no-seed`, `--no-record` (assembles the clips already recorded), `--voice <dir>`, `--script`.

## Voiceover

The narration is a person's own recordings, cleaned up; nothing is synthesised.

1. `pnpm videos --script` writes `out/<release>/narration-script.md` from the last recording: every line per scene and language, with how long it is on screen now.
2. The narrator records one file per scene and language, the lines in order with a pause of about a second between them: `<voice dir>/<lang>/<scene id>.m4a` (any common format). A retake of one line is `<scene id>-<n>.m4a`, which replaces line n.
3. `pnpm videos --voice <voice dir>` (or `VIDEO_VOICE_DIR`; the default is `out/<release>/voiceover`). Each take goes through DeepFilterNet 3 (speech enhancement: removes noise and hum, keeps the voice; the pinned binary downloads once to `out/bin`), a high-pass and loudness normalisation to -16 LUFS, and is cut at its longest pauses into the scene's lines. Each shot then holds until its line has been spoken, and the lines are mixed into the videos at their captions' start.

Lines without a recording keep their reading time and are listed when the videos are assembled. Takes are matched to lines by order, so after adding or removing a line in a scene, record that scene again.

The dev server shows developer overlays, which is why the videos record a production build.

## Each release

1. Copy `releases/v3.0.0.ts` to the new version and register it in `RELEASES` in `render.ts`.
2. Write the cards: what changed, in numbers where there are numbers. Values in square brackets are placeholders; the render lists any that are left.
3. For a feature a new user should see, add a scene to `scenes/app.ts`, put it in `ONBOARDING` (`releases/release.ts`) and list its id in the release's `whatsNew`.
4. Scenes that broke because the UI changed fail with the selector that is gone. Fix the scene, then `--only <scene>` until it looks right.
5. `pnpm videos --burn`, watch both videos, upload them (YouTube takes the `.vtt` as captions) and put the what's new link in `releases.ts`.

## How a scene works

A scene opens its first page in `setup` (not recorded), then `run` drives the app while `ctx.say` shows a caption. Each caption stays up for at least its reading time, so the pacing follows the words, and the captions and the picture come from the same clock.

```ts
await ctx.say(
	{ en: "Open one to read the summary.", nl: "Open er een voor de samenvatting." },
	() => click(page, page.getByTestId("project-conversation-row-…")),
);
```

Scenes find elements by test id or URL, never by visible text, so one scene records in every language. When an element has no test id, add one to the component. `lib/cursor.ts` draws a pointer (headless Chrome has none) and moves it before every click. `scenes/card-scene.ts` makes a scene from a full-screen card. `device: "phone"` records the portal at phone size, and `zoom` enlarges part of the frame.

Copy follows `skills/brand-guidelines.md`: lowercase dembrane, British spelling, "language model" rather than AI, informal Dutch (je/jij), no em dashes, and claims stop at the record.

## Not yet

- The sample conversations are in English, so the Dutch video shows a Dutch interface over English content.
