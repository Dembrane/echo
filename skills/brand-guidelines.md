# Skill: Brand Guidelines

Reference for any agent producing dembrane-facing output: copy, emails, docs, UI text, slides, HTML artifacts. These rules come from six months of corrections by the team. The ones marked "learned the hard way" are mistakes an agent will make by default; read those twice.

For docs pages specifically, `docs/_authoring/STYLE.md` is the authority. This file is the broader brand layer that sits underneath it.

## The name

- The company and product are *dembrane*, always lowercase. Even at the start of a sentence, even in titles. Apple-style: the word is written one way, everywhere.
- Never bold the word "dembrane". Use it plainly.
- "ECHO" is a legacy platform name. The platform is "dembrane", or "the dashboard" / "the portal" / "the recorder" when you mean a part of it. Older documents and emails show "Dembrane" and "ECHO"; that is drift, not the standard.

## Voice

- Grounded, human, approachable. 80% Everyman, 20% Explorer (IKEA meets Patagonia). Plain language, short sentences, no hype.
- Core belief: *people know how*. dembrane surfaces the intelligence already in the room; it does not replace human judgement.
- Say "language model" rather than "AI" when describing how a feature works. Models are tools, not oracles.
- English defaults to British spelling: organise, colour, analyse, behaviour. The codebase already uses "organisation"; match it.

### Learned the hard way: em dashes

Avoid em dashes. One per document is the absolute ceiling; aim for zero. Overuse is the clearest "written by AI" tell and the team reacts to it strongly. Use commas, colons, semicolons, parentheses, or split the sentence.

### Learned the hard way: no violent or martial language

Never use military, combat, or aggressive metaphors, even subtle ones: "arm facilitators", "trojan horse", "weapon", "fight", "battle", "ammo", "attack the problem", "win the war". dembrane stands for hope, empowerment, and care; conversational governance cannot be marketed in the vocabulary of conflict.

Replacements that keep the punch:

- "We arm facilitators" → "We back facilitators", "We resource facilitators"
- "Win the market" → "earn the market", "be chosen"
- "Attack the problem" → "address", "meet", "work with"

This applies everywhere: decks, website, emails, internal comms, even internal naming.

### Learned the hard way: Dutch register

Dutch copy is informal *je/jij* throughout. Formal *u/uw* is always wrong in dembrane copy; if you find it on an existing page, flag it as drift. Within the informal register, use the stressed possessive *jouw* when the sentence is about the reader's own thing and wants to lean on that ("jouw evenementen", "jouw gekozen rechtsgrondslag"); use plain *je* for unstressed subjects and throwaway possessives.

## Claims and positioning

These are positioning rules, not phrasing rules. Getting them wrong undercuts published work.

- **Claims stop at the record.** dembrane makes the listening checkable: transcripts, analysis, traceability from insight back to voice. Never let copy claim that outcomes are therefore legitimate or defensible. Legitimacy is earned by the organisation and its process; a traceable record of a rigged process is still a rigged process. dembrane refuses the arbiter position on purpose.
- **"Holds up under pressure" belongs to the participant.** It means a participant's contribution surviving dismissal by an expert, because they could stress-test it. It never means record integrity or audit trails. Do not conflate the two.
- **Do not use the word "incorruptible" in copy**, even though structural trustworthiness is the deep story.
- **Position before you publish.** dembrane has published critical positions on AI-mediated deliberation. Systems that generate consensus statements *for* participants, and AI that smooths or softens language before it reaches the recipient, are critique targets, not endorsements; cite them only as contrast. Before citing any AI-and-deliberation research, check the deliberative technologies paper's stance with the team.
- **The model never pre-writes what a room must author.** The same position gates product and demo ideas: no synthetic previews of a customer's own outcome document. Clearly-fictional exemplars are fine; pre-drafts of the real thing are not.
- **Copy must never undercut the privacy promises**, in particular "never trained on your data".

## Visual identity

Direction since early 2026: down-to-earth, human, approachable. Bright accents on off-white, not muted corporate pastels. Not subtle; alive.

### Palette

| Token | Hex | Use |
|---|---|---|
| parchment | `#F6F4F1` | backgrounds |
| graphite | `#2D2D2C` | text (never pure black) |
| institution blue | `#4169E1` | primary |
| hairline | `#E6E3DF` | borders, dividers |
| cyan | `#00FFFF` | accent |
| spring green | `#1EFFA1` | accent |
| mauve | `#FFC2FF` | accent |
| lime yellow | `#F4FF81` | accent |

Accents are decorative and categorical, never semantic. Green does not mean success; yellow does not mean warning. If you need semantic colours, define separate ones.

### Type

- **DM Sans** for everything. Body weight is **300, not 400**; this is the single biggest undocumented convention and it is why dembrane UI feels airy rather than corporate. 500 for emphasis, 600 for labels, 700 rare.
- Enable stylistic sets ss01 to ss06 (the warm single-storey a/g/u/y) where the rendering path allows it. Note Google Fonts' hosted DM Sans strips these; a local or self-hosted font file keeps them.
- Never bold for emphasis in brand copy; use institution blue or italics instead.
- Always left-aligned. Headings lean lowercase.
- Type scale is a perfect fourth (ratio 1.333).

### Shape and imagery

- Border radius 0 by default. Sharp corners everywhere; the `9999px` pill is reserved for primary action buttons. Nothing in between.
- Icons: PhosphorIcons.
- Real over abstract: real clients, real events, people in dialogue over product screenshots. Video over stills.

## Working with named people

When output will be published under a real person's name (a comment, a reply, a post), keep it to 2 to 4 sentences in their voice and strip any AI scaffolding. Longer drafts go to the person to edit and paste themselves. And spell-check everything before it propagates into filenames, titles, and links.

Internally, Jorim, Eve, and Sameer are collectively "the board" in team docs. Not "principals" (too formal), not "the C-suite" (too corporate for a small team). Formally: Eve is CEO, Sameer is CTO, Jorim is COO.

## The standing rule

Not a rulebook. If something serves the brand better by bending a guideline, bend it. When in doubt, ask: does this feel approachable, grounded, and human? Does it invite people in?
