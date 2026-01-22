# dembrane UI Style Guide

This is the north star for how dembrane looks, sounds, and feels.

It's not a rulebook. Use your gut. If something serves the brand better by bending a guideline, bend it.

When in doubt, ask: Does this feel approachable, grounded, and human? Does it invite people in?

---

## Colors

Use brand colors in these approximate proportions:

| Color | Name | Usage | Hex |
|-------|------|-------|-----|
| Off-white | Parchment | Default background | `#F5F5F0` |
| Dark grey | Graphite | Mood/text | `#2D2D2D` |
| Blue | Institution Blue | Action/primary | `#4169E1` |
| Light grey | Grey | Disabled states | `#B8B8B8` |

**Accent colors (for categories/tags):**

| Color | Name | Usage |
|-------|------|-------|
| Cyan | Cyan | VALUE |
| Bright green | Spring Green | DESIGN |
| Pink | Mauve | ENGINE |
| Yellow | Lime Yellow | ADMIN |

**System states only (never for branding):**

| Color | Name | Usage |
|-------|------|-------|
| Orange | Peach | Warning |
| Pink-red | Salmon | Error |

---

## Buttons

### Primary
- Default: Institution Blue background, white text, rounded corners
- Hover: Graphite background
- Click: Graphite background

### Secondary
- Default: Transparent with blue border, blue text
- Hover: 10% blue opacity fill
- Click: 20% blue opacity fill

### Tertiary
- Default: Text only, blue, no border
- Hover: 10% blue opacity background
- Click: 20% blue opacity background

### Disabled
- Grey background, darker grey text

---

## Typography

### Rules
1. Always keep text left aligned (unless very short and wrapped in a border)
2. Avoid orphans — single words alone on a line. Adjust text box width.
3. Prefer hanging punctuation — quotes and bullets "hang" outside the text box
4. Never use bold. Use *blue* or *italics* for emphasis.

### Hierarchy
- Keep it simple: one or two font weights max
- Let whitespace do the work, not bold text

---

## Writing: Product UI

**Golden rule:** Shortest possible, highest clarity.

### Tone
- Accessible, friendly, specific
- Write like you're explaining to a colleague, not presenting to a board
- No jargon, no corporate speak
- If you wouldn't say it out loud, rewrite it

### Vocabulary

| Don't say | Say instead |
|-----------|-------------|
| Collective sense-making | Make sense of big messy conversations |
| Users | Participants and hosts |
| Customers | Partners and clients |
| The tool | The platform / dembrane |
| Facilitate deliberation | Help groups have better conversations |
| AI | Language model (when describing our features) |

### Words we keep but explain plainly
- "Stakeholders" → fine, but prefer "everyone affected" or "the people involved"
- "AI" → fine in general context, but be specific: "the language model" or "the transcription model"

### Never say in UI
- "We are pleased to inform you..."
- "Please be advised..."
- "In order to..."
- "Successfully" (just state what happened)
- "We apologize for any inconvenience this may have caused"
- "Click here to..."

---

## UI Copy Patterns

### Buttons
✅ Upload  
✅ Save  
✅ Delete  
❌ Click here to upload  
❌ Save your changes  

### Labels
✅ Project name  
✅ Start date  
❌ Please enter project name  
❌ Name of the project  

### Errors
✅ "File too large. Max 100MB."  
✅ "Something went wrong. Try again."  
❌ "An error occurred. The file exceeds the maximum allowed size..."  

### Success states
✅ "Saved"  
✅ "File uploaded"  
❌ "Successfully saved"  
❌ "Your file has been successfully uploaded"  

### Empty states
✅ "No conversations yet. Start your first one."  
❌ "You have not created any conversations"  

### Loading/Processing
✅ "Analyzing..."  
✅ "Processing audio..."  
❌ "Please wait while we process your request"  

---

## Dutch Localization

### Core rules
- Use "je/jij/jou" — never "u/uw" (always informal)
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

**Bad:** "Gelieve uw bestand te uploaden"  
**Good:** "Upload je bestand"

**Bad:** "We zijn verheugd u te informeren dat de functionaliteit hersteld is"  
**Good:** "Chat doet het weer"

---

## Component Guidelines

### Modals
- Clear, direct title (action-oriented when appropriate)
- Body text: one or two sentences max
- Warning callouts: use Peach background, keep text brief
- Actions: Primary on right, Cancel on left

### Forms
- Labels above inputs, left-aligned
- Placeholder text is not a substitute for labels
- Validation errors inline, close to the field
- Don't disable submit buttons while form is incomplete — show errors on attempt

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

## Spacing & Layout

- Use consistent spacing scale (8px base)
- Generous whitespace — let content breathe
- Group related items, separate unrelated ones
- Mobile-first responsive design

---

## Icons

Use [Phosphor Icons](https://phosphoricons.com/) for all iconography.

- Regular weight for most UI
- Keep icons simple and recognizable
- Don't rely on icons alone — pair with text labels where clarity matters

---

## Platform Context

ECHO is event-driven, not daily-use software. Users run discrete engagement sessions: workshops, consultations, civic forums, employee feedback rounds.

**Typical flow:** Prepare event → Run session → Analyze conversations → Generate report → Return for next event

This means:
- Don't add friction to infrequent tasks
- Remind users where they left off
- Make re-onboarding seamless
- Celebrate completed analyses, not login streaks

---

## Quick Checklist

Before shipping any UI:

- [ ] Can I say this in fewer words?
- [ ] Would I say this to a colleague?
- [ ] Is it clear what to do next?
- [ ] Does it feel approachable and human?
- [ ] Have I avoided bold text?
- [ ] Are error states helpful, not scary?
- [ ] Does it work in Dutch?