# Synthetic Popcorn demos

## Scope

A host supplies an organisation's website and a brief. The reusable [popcorn-demo skill](../../skills/popcorn-demo/SKILL.md) researches the organisation, creates a fictional corpus, and uses dembrane MCP to build a separate Echo project and Popcorn demo. The first example is deltaWonen's Bondgenotendag, around the meaning of geluk.

The skill is the orchestration layer. This version needs no dedicated generator API, job system, catalogue management interface or separate demo application. Use existing projects, existing Popcorn extraction, a small collection of demo links and the presenter changes below. The eventual destination is `https://demo.dembrain.com/<organisation>`; domain configuration and deployment are still unverified.

The demo previews the experience of listening. It must never be presented as an outcome that real participants produced or are expected to adopt.

## Skill workflow

1. Accept website, brief, language and optional event/customer example. Discover the connected MCP tools and authorised workspace; find an existing demo before upserting another.
2. Research primary public sources. Save a report with URLs, retrieval dates, facts, unknowns and separately labelled invented themes. Use public-safe research as project context. Private sales emails stay in a separate private brief; current project context is visible to hosts and participants.
3. Upsert an isolated, explicitly synthetic project with real intake disabled. Attach the research and import a small fictional corpus with generic roles, contrasting perspectives and unresolved questions. Stamp synthetic provenance before extraction or publication.
4. Run existing Popcorn extraction, then configure the intro and point the QR at the sales portal. Inspect the output for false attributions, consensus or claims of real attendance. Preserve returned IDs to resume safely.
5. Review the exact presenter, sources, phrases, tensions, stakeholder map and QR destination. Publish when requested to the configured destination. Retain disclosure in every public bundle and only add published demos to the collection.

The sentence “Only public data was used to create this example” is conditional on provenance. If substantive private email informs the generated example, omit or replace it. User-supplied event metadata is scenario context, not participant evidence.

## Required MCP integration

The current MCP implementation supports project discovery/read/update and conversation reads. It does not yet expose project creation, synthetic conversation import or Popcorn operations. The skill checks the live catalogue rather than assuming these exist. Until exposed, it can prepare the complete content packet; the existing local fixture helper can populate a development environment when local work is requested.

The remaining integration is a narrow set of authenticated wrappers around existing services: upsert a synthetic project, upsert labelled conversations, upsert/start/read Popcorn, and retrieve/export its output. Every write is an upsert rather than a create: `dembrane_update_project` already carries the project context that matters, so it grows into the project upsert instead of gaining a create tool beside it. Preserve user scopes and workspace policy, keep public access off until provenance is applied, and return resource/run IDs. Hosting can use the configured deployment tooling when requested. See the skill's [MCP reference](../../skills/popcorn-demo/references/dembrane-mcp.md) for the verified capabilities and gaps.

## Small Popcorn changes

Every session gains optional host settings in existing `popcorn_settings`. Existing sessions default to all of them off.

- `intro`: a title (160 characters) and subtitle (600) before the countdown.
- `disclosure`: a text (600) on the opening screen, plus an optional follow-up screen with its own title (160) and text (600). Each line of text is a paragraph; in a follow-up of several lines, the first reads as the subtitle.
- `notice`, the frame: a text (160) in the blue bar across the top of every presenter tab, with a link that reopens the opening.
- `data`: a last opening screen, "Here's what happens to your data, step by step", with three illustrated steps (scan, talk, understand) and a closing note. Its words are not typed by the host: they follow the project's `anonymize_transcripts` (anonymised: transcribed, names scrubbed, the host cannot listen, no training; otherwise: transcribed and analysed, the host may use it for research) and its effective legal basis (consent, client-managed or dembrane-events, resolved through workspace and owner as the portal does, with the organiser's privacy policy linked under consent). EU processing on Google Vertex AI, encrypted storage in Amsterdam and dembrane.com/trust close the screen. It makes no deletion promise: audio is not deleted after transcription; for anonymised conversations the dashboard never offers it to the host.
- `language`: `ui` sets the screen's own words (`auto` follows the results: the translation language when one is chosen, else the project's language), and `translate_to` asks for the results in another language. By default results stay in the language people spoke. A chosen language starts a read that translates every phrase, quote, tension, stakeholder and relation the room's bundle shows; translations are kept in the session state per language, keyed by source text, so only new or changed texts are translated later. The bundle swaps them in as its last step, after published objects, and says how many are still pending. Host-written opening texts are shown as written.

A switch without words shows nothing. The dashboard edits the opening in one "Opening and frame" card and the languages in a "Language" card. The opening screens are URL state (`#intro/N`), so the browser's back button returns a step; a fresh load always starts at the first screen.

Synthetic sessions have this opening:

1. Mandatory disclosure: every story, quote and perspective is invented for demonstration, not real workshop findings. Its words, the invitation's and the frame's belong to the demo: they are set in `demo` with the synthetic marking, never read from the host's settings, and empty words become standard synthetic copy in the demo's language. Refresh and deep links show it too.
2. Invitation, the disclosure's follow-up screen: explain that the real value comes from listening to real stakeholders, including their disagreements and uncertainty. The standard copy is generic; deltaWonen's fixture sets its own, which looks forward to hearing their bondgenoten and real stories.
3. Explicit start, then the 3, 2, 1 countdown and existing Popcorn experience.

The frame is likewise always on for synthetic sessions, so a synthetic label remains visible on every presenter tab and detail view, with a way to reopen the introduction. Nobody sets or clears the synthetic marking from the dashboard: only the demo tooling writes it (the local helper now, the MCP upsert later). For a synthetic session the dashboard leaves the disclosure and frame controls out, and the settings API answers 409 to an edit of either; the host still controls the intro, the data screen and the languages. Shared bundles retain synthetic metadata on presentation data. Inside the deck, a synthetic session reads like a real run: its phrases, tensions and stakeholders carry quotes and evidence, with no per-item "invented" wording; the frame and the opening carry the provenance.

The QR and adjacent clickable link open dembrane's sales portal: a separate, real dembrane project, per language, whose page says "You scanned this QR code from a demo. The demo does not contain real recordings and will not update if you record something. Instead, this portal records feedback for the dembrane team. Have any feedback for dembrane? Share your story!" Its legal basis is dembrane-events. Recordings land in the sales portal project, never in the demo project. The link carries `utm_source=popcorn_demo` and the demo's slug as `utm_campaign`. The portal shows the project's title and description on the recording page, after its standard privacy card; a portal change would be needed to show them first. The words live in [sales-portal.json](../demos/sales-portal.json) and reach production through `dembrane_update_project`; the legal basis is set in the dashboard by a dembrane account.

The local implementation stores `synthetic`, `public_sources_only`, `language`, `portal_url`, `portal_urls` (per language), `disclosure` and `notice` under `agent_loop.popcorn_state.demo`. Normalisation, reruns and bundle generation preserve it independently of optional intro settings. This does not yet establish immutable project-wide provenance outside Popcorn; demo projects must remain isolated from real research.

## deltaWonen local example

Title: “Wat betekent geluk voor jullie?” Subtitle: “Een denkbeeldige Bondgenotendag voor deltaWonen. Een voorproefje van luisteren met dembrane.”

Public sources describe “Ruimte voor Geluk” through woongeluk, leefgeluk and werkgeluk. Security, belonging, agency and collaboration are fictional discussion lenses, not official pillars or event outcomes. The 2030 horizon remains unverified. See [research](../demos/deltawonen/research.md).

The prototype contains five fictional conversations and thirty phrases, each found word for word in its transcript, with four quote-backed tensions and six stakeholder groups. It uses an authored fixture, not a completed model extraction; its fingerprints are stamped the way a tick stamps a read, so a refresh or a translation request leaves the authored deck alone. The [local helper](../demos/README.md) seeds local Echo and a local sales portal, and exports the actual presenter with a simple collection page. It is a development aid, not the production MCP path.

## Acceptance

- The skill produces a sourced research report, a labelled fictional corpus and usable settings from a website and brief, and accurately reports missing tools or access.
- Project and conversation upserts resume without duplication and cannot modify real customer research. Public-safe context excludes private sales notes.
- Intro, disclosure, notice, data and language settings survive save/reload. Ordinary sessions with them off retain their behaviour; an ordinary session with a worded disclosure or notice, or the data screen on, shows it.
- The data screen's words follow anonymisation and the effective legal basis, and never promise deletion.
- Results stay in their original language unless a translation is requested; a requested translation covers every result text the room sees and reports what is pending.
- Synthetic disclosure and notice survive their own switches, the intro toggle, refresh and deep links. Escape and navigation keys cannot bypass it. Countdown and phrases wait until the opening is completed.
- Synthetic labels persist across tabs, details, mobile layouts and exported data. Reruns retain provenance.
- QR decodes to the sales portal in the demo's language, whose page says the demo will not update and asks for feedback for dembrane; nothing recorded there reaches the demo project. Use a phone-reachable origin for local previews.
- Hosted publication verifies the configured domain, HTTPS, direct-path routing and QR destination before a public link is reported as live.

## Delivery status

Implemented locally: reusable skill, optional intro, disclosure, notice, data and language settings for every session, result translation in the tick, mandatory synthetic opening, invitation, data screen, countdown, persistent labels, sales portal QR, deltaWonen research/fixture, local Echo seeding and static export.

Remaining for the complete MCP workflow: expose the missing write and Popcorn operations, connect the MCP server, and test a full authenticated run. Hosted deployment to `demo.dembrain.com` is separate and has not happened. No private email was accessed for this example.
