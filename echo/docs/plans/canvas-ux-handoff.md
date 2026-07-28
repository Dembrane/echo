# Canvas UX handoff (from Oren's Notion page, 2026-07-08)

Source: Notion "Canvas user experience — design handoff for Sam"
(3979cd84-2705-8103-bc6e-dfc9c81a37b3), distilled from the 13th-week live
canvas. Look and feel + judgment rules; technical implementation is free.

## Tokens

```css
:root {
  --parchment: #F6F4F1;  /* page ground */
  --card: #FFFFFF;       /* every surface */
  --ink: #2D2D2C;        /* text */
  --ink-soft: #6E6B66;   /* secondary text */
  --royal: #4169E1;      /* the ONE interactive color */
  --hairline: #E6E3DF;   /* all borders */
  /* data accents only, never chrome: */
  --green: #1EFFA1; --amber: #FFD166; --cyan: #00FFFF;
  --pink: #FFC2FF; --yellow: #F4FF81; --coral: #FF9AA2;
}
```

## Spacing

- Page frame: `padding: 14px 26px 80px`; fixed chrome sits `bottom: 20px`,
  `left/right: 22px`.
- Content measures per surface, all `margin: 0 auto`: slides 1000px,
  trace/feed 760-780px, audit 860px, questions 720px, cloud 1060px.
- Card padding tiers: dense grid `12px 13px`, reading cards `15px 18px`,
  hero tiles `20px 26px`. Never below 9px, never above 26px.
- Gap tiers: tight grid 9px, card grids 12-14px, tab-to-tab 26px, section
  breathing 22-30px top margin.
- Body copy maxes at ~620px (.lede).

## Look and feel

- Borders do the work, not shadows: everything `1px solid var(--hairline)`
  on white. Shadows only on floating chrome (fixed buttons, panels, popups).
- Sharp corners everywhere. Exactly one pill (`border-radius: 9999px`),
  reserved for the primary action button. One circle: the minimized bubble.
- Royal is the ONLY interactive color: active tab underline, asks, links,
  dotted provenance underlines, the current/open item. If it is royal, you
  can do something with it or it is live.
- 3px left border = "this one matters now" (newest feed item, evidence
  cards, the block ask). Importance is an accent stripe, not a bigger box.
- Emphasis by weight and size, never color-shouting. Weights 400/500/600
  only; no bold-700 anywhere. Bright accents only as data color (5px accent
  bars, dot markers, tile borders).
- Amber tint = just landed: `rgba(255,209,102,0.35)` background + same-color
  3px outline, cleared after the next update so it always means newest.

## Type

- DM Sans throughout, line-height 1.45 body, antialiased.
- Display headings: weight 500 (never bold), negative tracking,
  `text-wrap: balance`. h1 `clamp(32px, 4.6vw, 48px) / -0.015em`;
  h2 `clamp(24px, 3.4vw, 36px) / -0.01em`; line-height 1.12-1.2.
- Eyebrows/labels: 10-12px, weight 600, uppercase, letter-spacing
  0.08-0.1em, usually royal. AT MOST ONE kicker per screen (room feedback:
  it was over-used; only where a stranger needs orienting).
- Body: 16px lede (soft ink; key phrases re-inked via
  `b { color: var(--ink); font-weight: 500 }`), 13.5px UI text, 12-12.5px
  card body, 11px meta.
- Numbers: `font-variant-numeric: tabular-nums` for timestamps, counters,
  stats. Big stats `clamp(32px, 4.2vw, 46px)`, weight 600, -0.02em.
- The middot (·) is the universal separator. Typographic quotes, colored
  royal when quoting voices. No em dashes, ever. dembrane always lowercase.

## Tab bar

Quiet text on the page ground; no boxes, no pills, no backgrounds.
Identity = ink vs soft-ink plus a 2px royal underline. 26px between tabs.
Row closes with a royal +.

```css
.tabbar { display: flex; border-bottom: 1px solid var(--hairline); }
.tabbar button {
  font-size: 14.5px; font-weight: 500; color: var(--ink-soft);
  background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 10px 2px; margin-right: 26px; cursor: pointer;
}
.tabbar button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--royal); }
```

(If the sanitizer strips buttons/JS, reproduce this look with a CSS-only
mechanism; the visual identity is what must survive.)

## Per-tab feel

| Tab | Feel | Key styling |
| --- | --- | --- |
| Story (slides) | full-bleed calm, one idea per screen | `min-height: 80vh`, centered column, eyebrow + display heading + 620px lede |
| Canvas | dense wall of white blocks | 5-col grid, 9px gaps, `12px 13px` blocks, italic royal ask with 3px left bar |
| Concept cloud | floating, alive, slightly untidy | tiles rotate ±1.2°, 7s float, four size classes from 12px to `clamp(24px, 2.8vw, 34px)` |
| Trace | quiet reading room | 780px column, big balanced claim, quote cards with royal left stripe and royal quote marks |
| Munching | terminal-meets-theater | newest item bigger + royal-bordered, older items settle small and grey |
| Audit log | pull-request formality | white accordions, royal border when open, tabular timestamps |

## Motion

Small, singular, honest. Land flash 700ms once; feed entries slide up 8px
over 400ms, only genuinely new ones; cloud float ±5px over 7s; pulse dot
2.2s. Nothing loops for attention while idle. Every animation has a
`prefers-reduced-motion: reduce` fallback.

## The judgment layer

Written so a Flash-class model (eager, extrapolates when unsure) can follow
it. Core insight: almost all of the judgment is subtractive. A hallucinating
model adds; every rule below forbids adding.

### Quote tracing (the architecture)

Separate ingest from linking; verbatim quotes are the ONLY currency between
them. The model never writes "what the room meant"; it moves exact slices of
what the room said.

```
INGEST (dumb on purpose)
  every transcript/comment lands as immutable raw input
  NEVER summarize at ingest — summarizing destroys the receipts forever

PROCESS (one batch at a time)
  while reading raw text, when a passage does real work (names a decision,
  coins a phrase, answers an open question, contradicts the wall):
    push { id, who, quote: verbatim slice trimmed at sentence boundaries,
           source, when, link_to_conversation? }
    // verbatim = COPIED, transcription quirks included. never cleaned,
    // never paraphrased. copying is the anti-hallucination mechanism.

LINK (only now may the wall change)
  claim    = shortest phrase that survives without context
  evidence = quotes that DIRECTLY support it (1..n ids)
  if evidence empty: claim is the agent's own synthesis -> NO underline,
  or it does not go up at all
  else: render claim as traceable, carrying [ids]

RENDER
  traceable = dotted underline; click -> claim big, then one card per
  quote: exact words · speaker · when · source · link
  a claim built from many quotes shows EVERY voice — never merge quotes
  into one composite quote
```

Invariants that must never break:
1. No receipt, no underline. An underline on unsupported text is a forged
   receipt; it poisons trust in every real one.
2. The quote outranks the claim. If they drift apart during editing,
   rewrite the claim, never the quote.

### Concept cloud checklist (paste into the tick prompt nearly as-is)

1. Extract, never generate. A concept is a phrase FROM the transcript. You
   are a magnet, not a mint.
2. The grep test: for every tile you must be able to point at the exact
   line(s) it came from. Cannot point -> the tile does not exist. Collect
   the quote FIRST, then make the tile.
3. Size = repetition × spread. Said by two people beats said twice by one
   person beats said once memorably. XL is for phrases the room kept
   returning to unprompted.
4. Scarcity forces judgment: exactly 3 XL, hard cap ~20 tiles.
5. Subtract words, never add. "falling in love with the game again" is the
   transcript minus filler; "renewed passion for the mission" is
   hallucination in a nice coat.
6. The room's metaphors only. Transcript says "prune the tree" -> tile says
   prune the tree, not "focus our efforts".
7. Keep 1-2 jokes, small. The wall should feel like the room, not minutes.
8. Gentleness on hard content. Grief goes up in the speaker's own softest
   phrasing or not at all. Sensitive strategy (money, legal, personnel)
   stays off even when said out loud — and the audit trail says so, so
   nothing is silently swallowed.
9. When unsure, leave it out and say so ("left off the wall on judgment;
   say the word if it should be on").

### Crux rules (the one big question)

- One question at a time. A fixture: UPDATED, never appended to, never
  removed.
- A newcomer can answer it out loud: no internal references, no jargon, no
  numbers needing context.
- Phrase as an invitation with a concrete first move ("scan the code and
  give your first answer out loud: one move, one bet, one reason it works").

### Room feedback

- All-caps royal kicker: at most one per screen.
- Open questions: idea right, format unsolved (a stack of white boxes felt
  off; consider small quiet text or living inside the surfaces they came
  from).
- Protect: the sculptural typography, the fun subtle animation, quote
  tracing "coming from the transcript in a way that makes sense", the
  concept cloud, the one main question.
