# dembrane docs - STYLE & CONVENTIONS (for every author/agent)

Read `FACTS.md` first for what is true. This file is HOW to write it.

## Brand voice
- Always lowercase *dembrane* - even at the start of a sentence/heading.
- "ECHO" is the old platform-feature name. *Avoid it.* Say "dembrane", "the dashboard",
  "the portal", "the recorder". Only mention ECHO once, in passing, if disambiguating.
- Tone: approachable, grounded, human. 80% Everyman, 20% Explorer (IKEA meets Patagonia).
  Plain language, short sentences. Respect the reader's intelligence; never hype.
- Core belief to echo where natural: *PEOPLE KNOW HOW* - dembrane surfaces the
  intelligence already in the room; it doesn't replace human judgement.
- Say "language model" rather than "AI" when describing a feature mechanism. dembrane
  treats models as tools, not oracles.
- Never bold the word "dembrane". Bold sparingly in general.

## Language & spelling
- *Default pages are British English (en-UK)*: organise, organisation, customise,
  behaviour, licence (noun), colour, centre, analyse, prioritise, "whilst" is fine.
  (The codebase already uses "organisation" - match it.)
- Each page has a Dutch twin named `<page>.nl-NL.md` next to it. Dutch is natural,
  warm, "je/jij" (informal) - not "u". Keep the same headings/structure/links so the
  language switcher lines up 1:1.

## File & link conventions
- One topic per file, kebab-case filename, `.md`.
- Every page starts with frontmatter:
  ```
  ---
  title: <Human title>
  description: <one sentence, used for previews/SEO>
  audience: <host | host-partner | staff | participant | developer-internal | developer-external | all>
  ---
  ```
- *Interlink heavily.* Use relative links to other docs, e.g.
  `[roles & permissions](../features/roles-and-permissions.md)`,
  `[creating a project](./creating-a-project.md)`.
- Link Dutch pages to Dutch pages (`...nl-NL.md` → `...nl-NL.md`) so a reader stays in
  their language. The language switcher handles cross-language jumps.
- folder2website discovers pages by following links from `docs/README.md`. *A page that
  nothing links to will not appear in the site.* So: `README.md` → `map.md` → everything,
  and every page links onward. When you add a page, link it from its section index AND
  from `map.md`.
- Code/identifiers in `backticks`. Reference real routes/endpoints from FACTS where useful
  (helps power users), but keep prose task-focused.

## Practical tone (READ THIS - it's the whole point)
Our reader is a busy host who just arrived from a how-to, not an engineer reading a spec.
Write like the dembrane user guide does: warm, direct, step-by-step, with real tips. Help
them do the thing.

Do:
- *Open with the practical answer*, not a definition. First line earns its place ("A role
  decides what someone can do. You pick one each time you invite a person.").
- Lead with a *"which one do I pick / how do I do this"* table or numbered steps.
- Give *concrete tips and gotchas* from real use ("Keep your screen on while recording - a
  black screen means no recording", "the transcript appears 30s-1min after you start").
- Short sentences. Short pages. If a sentence has two ideas, split it.
- Use the reader's words ("see results", "run a session"), not system words.

Don't (these made the first draft tone-deaf):
- No literal "## What it is / ## When you'd use it / ## As who" heading scaffolding. Weave
  the who/when into plain prose instead.
- No ADR citations, no database/field names (`is_external`, "two tables"), no "if and only
  if" invariants, no code-tree diagrams on user pages. That belongs in
  `users/developer-internal/`.
- No empty throat-clearing: "This page is the canonical reference", "In this section we
  will…", "It is worth noting that…", "Crucially,". Cut them.
- Don't over-explain. One good example beats three sentences of theory.

Still call out gating where it matters ("Building reports needs a Changemaker workspace or
above"), and link to roles/tiers - just inline and lightly, not as a ceremony.

Use GitHub-flavoured callouts sparingly, for a genuine aside or warning:
> [!NOTE] / > [!TIP] / > [!IMPORTANT] / > [!WARNING]

End with a short *## Related* list of links.

## Accuracy rules
- Never invent UI labels, prices, endpoints, or limits. If FACTS doesn't have it, write
  around it or omit. Prices/tiers exactly as in FACTS §4. Roles exactly as §2.
- Mark "coming soon" features as such (Innovator MCP, Guardian sovereign stack).
- Don't promise SLAs, certifications, or legal terms beyond FACTS §0/§11.

## Structure (the tree)
```
docs/
  README.md                 (site entry → welcome + links to map)
  map.md                    (full sitemap / navigation hub)
  features/                 (per-FEATURE pages, role-neutral, the canonical reference)
    index.md
    <feature>.md ...
  users/                    (per-USER-TYPE guides; repeat features from that vantage)
    index.md
    host/ <pages>
    host-partner/ <pages>
    staff/ <pages>
    participant/ <pages>
    developer-internal/ <pages>
    developer-external/ <pages>
  + a .nl-NL.md twin for every .md
```
`features/*` = the canonical "what is this feature" reference. `users/<type>/*` = "as this
person, here's how/when I use the relevant features", linking back to the feature pages.
Repetition across user types is expected and good.
