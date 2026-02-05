# dembrane style guide

This is the north star for how dembrane looks, sounds, and feels.

Use your gut. If something serves the brand better by bending a guideline, bend it.

When in doubt, ask: Does this feel approachable, grounded, and human? Does it invite people in?

---

## Brand foundation

### Core belief

PEOPLE KNOW HOW.

Communities already hold the knowledge to solve their challenges. They just need better ways to surface it, connect it, and act on it. dembrane doesn't add intelligence to groups. It reveals the intelligence already there.

### Archetype

80% Everyman + 20% Explorer.

Think IKEA meets Patagonia. Reliable, accessible, unpretentious. But with a spark of adventure and purpose.

### What we stand for

- *Hope over cynicism* - democracy works when people can actually talk
- *Critical AI* - language models as tools, not oracles
- *People powered* - the humans in the room hold the answers
- *Complexity welcome* - real problems are messy, we don't pretend otherwise
- *Institutional respect* - working with systems, not against them

---

## Naming

### dembrane

Always lowercase. Even at the start of a sentence.

- "dembrane helps groups..." (correct)
- "Dembrane helps groups..." (incorrect)
- "DEMBRANE" (never)

### ECHO

The platform feature. Not the brand. Use sparingly in external contexts.

### Vocabulary

| Don't say | Say instead |
|-----------|-------------|
| AI | language model (when describing features) |
| Users | participants and hosts |
| Customers | partners and clients |
| The tool | the platform, dembrane |
| Facilitate deliberation | help groups have better conversations |
| Collective sense-making | make sense of big messy conversations |

### Words we use carefully

- "Stakeholders" - fine, but prefer "everyone affected" or "the people involved"
- "AI" - fine in general context, but be specific: "the language model" or "the transcription model"

---

## Voice and tone

### Tone spectrum

Warm but not gushing. Direct but not cold. Smart but not showing off.

We sound like a trusted colleague, not a corporate announcement or a tech bro pitch deck.

### Writing rules

1. Shortest possible, highest clarity
2. If you wouldn't say it out loud, rewrite it
3. No jargon, no corporate speak
4. Write for humans who are busy and smart

### Never say in UI

- "We are pleased to inform you..."
- "Please be advised..."
- "In order to..."
- "Successfully" (just state what happened)
- "We apologize for any inconvenience this may have caused"
- "Click here to..."

---

## Colors

Use brand colors in these approximate proportions:

| Color | Hex | Usage |
|-------|-----|-------|
| Parchment | `#f6f4f1` | Default background, canvas |
| Graphite | `#2d2d2c` | Primary text, mood |
| Royal Blue | `#4169e1` | Primary action, links, emphasis |

### Accent colors (for categories/tags)

| Color | Hex | Category |
|-------|-----|----------|
| Cyan | `#00ffff` | VALUE |
| Spring Green | `#1effa1` | DESIGN |
| Mauve | `#ffc2ff` | ENGINE |
| Lime Cream | `#f4ff81` | ADMIN |

### System states (never for branding)

| Color | Hex | Usage |
|-------|-----|-------|
| Golden Pollen | `#ffd166` | Warning |
| Cotton Candy | `#ff9aa2` | Error |

---

## Typography

### Font

DM Sans. With stylistic alternates enabled (ss01 through ss06) for characters: a, g, u, y, Q.

```css
font-family: 'DM Sans', sans-serif;
font-feature-settings: 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06';
```

### Hierarchy

Keep it simple. One or two font weights max. Let whitespace do the work.

| Level | Size | Weight |
|-------|------|--------|
| Display | 48-64px | Regular |
| Headline | 32-40px | Regular |
| Title | 24-28px | Regular |
| Body | 16-18px | Regular |
| Caption | 12-14px | Regular |

### Rules

1. Left-align text (unless very short and wrapped in a border)
2. Avoid orphans - single words alone on a line
3. Prefer hanging punctuation - quotes and bullets "hang" outside the text box
4. Never use *bold*. Use Royal Blue or *italics* for emphasis

---

## Buttons

### Primary

- Default: Royal Blue background, white text, rounded corners
- Hover: Graphite background
- Click: Graphite background

### Secondary

- Default: Transparent with Royal Blue border, Royal Blue text
- Hover: 10% Royal Blue opacity fill
- Click: 20% Royal Blue opacity fill

### Tertiary

- Default: Text only, Royal Blue, no border
- Hover: 10% Royal Blue opacity background
- Click: 20% Royal Blue opacity background

### Disabled

- Parchment background (darker), Graphite text at 50% opacity

### Copy patterns

| Do | Don't |
|----|-------|
| Upload | Click here to upload |
| Save | Save your changes |
| Delete | Delete this item |

---

## Components

### Modals

- Clear, direct title (action-oriented when appropriate)
- Body text: one or two sentences max
- Warning callouts: Golden Pollen background, brief text
- Actions: Primary on right, Cancel on left

### Forms

- Labels above inputs, left-aligned
- Placeholder text is not a substitute for labels
- Validation errors inline, close to the field
- Don't disable submit buttons while form is incomplete. Show errors on attempt

### Cards

- Parchment background by default
- Minimal borders (1px if needed)
- Generous padding
- One clear action per card

### Tables

- Left-align text, right-align numbers
- Zebra striping optional (only if many rows)
- Row hover state for clickable rows

### Navigation

- Keep it flat when possible
- Clear current-state indication
- Breadcrumbs for deep nesting only

---

## UI copy patterns

### Labels

| Do | Don't |
|----|-------|
| Project name | Please enter project name |
| Start date | Name of the project |

### Errors

| Do | Don't |
|----|-------|
| File too large. Max 100MB. | An error occurred. The file exceeds... |
| Something went wrong. Try again. | We apologize for any inconvenience... |

### Success states

| Do | Don't |
|----|-------|
| Saved | Successfully saved |
| File uploaded | Your file has been successfully uploaded |

### Empty states

| Do | Don't |
|----|-------|
| No conversations yet. Start your first one. | You have not created any conversations |

### Loading/processing

| Do | Don't |
|----|-------|
| Analyzing... | Please wait while we process your request |
| Processing audio... | Your request is being processed |

---

## Layout

### Grid

12 columns. 6 row zones.

### Spacing

- 8px base unit
- Generous whitespace. Let content breathe
- Group related items, separate unrelated ones
- Mobile-first responsive design

---

## Photography and imagery

### Principles

- No stock photos
- No AI-generated images
- Warmth over polish
- Groups over individuals
- Real situations, real people
- Candid over posed

### When showing the product

- Real data where possible (anonymized)
- Avoid empty states in marketing materials
- Show the work, not just the interface

---

## Logo

### Usage

- Use the full logo (dembrane wordmark) when space allows
- Use the logomark (d symbol) for favicons, app icons, constrained spaces
- Maintain clear space around the logo equal to the height of the "d"

### Variants

- Light (for dark backgrounds)
- Dark (for light backgrounds)
- Transparent (for overlays)

Logo files live in `logos/`. SVG preferred.

---

## Dutch localization

### Core rules

- Use "je/jij/jou" - never "u/uw" (always informal)
- Natural phrasing, not word-for-word translation
- Compound words: audiobestand (not "audio bestand")
- Keep English terms when they sound better: Dashboard, Upload, Chat

### Key glossary

| English | Dutch |
|---------|-------|
| Dashboard | Dashboard |
| Upload | Uploaden |
| Chat | Chat |
| Conversation | Gesprek |
| Audio file | Audiobestand |
| Participant | Deelnemer |
| Settings | Instellingen |
| Save | Opslaan |
| Delete | Verwijderen |
| It's not working | Doet het niet |
| We're fixing it | We zijn het aan het fixen |

### Examples

- Bad: "Gelieve uw bestand te uploaden"
- Good: "Upload je bestand"

- Bad: "We zijn verheugd u te informeren dat de functionaliteit hersteld is"
- Good: "Chat doet het weer"

---

## Platform context

ECHO is event-driven, not daily-use software. Hosts run discrete engagement sessions: workshops, consultations, civic forums, employee feedback rounds.

Typical flow: Prepare event > Run session > Analyze conversations > Generate report > Return for next event

This means:

- Don't add friction to infrequent tasks
- Remind people where they left off
- Make re-onboarding seamless
- Celebrate completed analyses, not login streaks

---

## Icons

Use [Phosphor Icons](https://phosphoricons.com/).

- Regular weight for most UI
- Keep icons simple and recognizable
- Don't rely on icons alone. Pair with text labels where clarity matters

---

## Quick checklist

Before shipping any UI:

- [ ] Can I say this in fewer words?
- [ ] Would I say this to a colleague?
- [ ] Is it clear what to do next?
- [ ] Does it feel approachable and human?
- [ ] Have I avoided bold text?
- [ ] Are error states helpful, not scary?
- [ ] Does it work in Dutch?
