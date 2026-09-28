# Research and fictional content

## Reusable content packet

Prepare a concise packet containing:

- Organisation, website, sector, language, event scenario and proposed slug.
- Public research: source URLs and dates, verified facts, uncertainty, possible discussion themes.
- Fictional conversations: stable labels, generic participant roles, varied perspectives, synthetic transcript and summary labels.
- Intro title/subtitle, disclosure, invitation to real listening, notice bar text. The QR's sales portal has shared words in `echo/demos/sales-portal.json`.
- Provenance: public sources only or mixed inputs; any private brief stays separate from the published packet.

Choose enough fictional material to demonstrate different perspectives and tensions without inventing a statistical finding. Counts describe the demo corpus, never real attendees or population support. Generated pillars, weights and relationships are illustrative, not an organisation's official strategy or measured priorities.

## Intro copy

Adapt to the organisation and language. The first screen must plainly say the stories and perspectives are invented and are not real session outcomes. The second values listening to real people before starting the countdown. Keep a short synthetic label visible throughout the presenter and companion.

The copy lands in the demo's synthetic provenance (`demo` in the Popcorn state), not in the host's settings: the first screen in `disclosure.text`, the invitation in `disclosure.invitation_title` and `disclosure.invitation_text`, the frame label in `notice.text`. A synthetic session always shows them and hosts cannot edit them; fields left empty get generic standard copy, so write organisation-specific words into them rather than relying on the default.

Dutch first screen:

> Dit is een synthetische demo. Alle verhalen, uitspraken en perspectieven zijn verzonnen voor dit voorbeeld. Ze zijn niet afkomstig van echte deelnemers en zijn geen uitkomsten van jullie bijeenkomst.

Dutch invitation:

> We kijken ernaar uit om echt te luisteren naar jullie mensen. Hun verhalen, vragen en verschillende perspectieven geven betekenis aan jullie dag. Dit voorbeeld laat zien hoe die ervaring eruit kan zien; de echte inzichten ontstaan samen met hen.

English first screen:

> This is a synthetic demo. All stories, statements and perspectives were invented for this example. They do not come from real participants and are not findings from your event.

English invitation:

> We look forward to listening to your people. Their real stories, questions and different perspectives will give your day meaning. This example previews the experience; the real insights will come from listening to them.

Include the requested exact sentence only when supported:

> Only public data was used to create this example

That sentence alone is not a synthetic disclosure. If substantive private material informed generation, omit it or use truthful provenance copy. A user-provided event label can describe the scenario without claiming it is public evidence or an actual event outcome.

## Worked example

Echo is a public repository, so a demo about a real organisation never goes into it: it would name who dembrane is talking to. Keep that demo's folder elsewhere and pass it to the tools with `--demo`.

Do not assert an event date, attendees, deadlines or official priorities without evidence. Discussion lenses can be invented if explicitly labelled as such.

In an Echo checkout, `echo/demos/example/research.md` and `fixture.json` are the reviewed example, for an invented housing corporation. They contain five fictional conversations and thirty phrases. That size is an example, not a requirement for every sector. The fixture was manually authored, not extracted by a model run.
