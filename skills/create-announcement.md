# Skill: Create Announcement

Push announcements to ECHO users via Directus MCP.

## Schema

**`announcement`** (main table)
- `id` - UUID primary key
- `level` - `"info"` or `"urgent"`
- `expires_at` - datetime (ISO format)
- `translations` - nested translations
- `activity` - tracks which users have read it

**`announcement_translations`**
- `languages_code` - `"en-US"`, `"nl-NL"`, `"de-DE"`
- `title` - markdown text
- `message` - markdown text (main content)

## Fetch Methods

```
# Check existing announcements
mcp__directus__items: action=read, collection=announcement
query: { fields: ["*", "translations.*"], sort: ["-created_at"], limit: 5 }

# Get schema
mcp__directus__schema: keys=["announcement", "announcement_translations"]
```

## Create Pattern

```json
{
  "action": "create",
  "collection": "announcement",
  "data": [{
    "level": "info",
    "expires_at": "2026-02-27T12:00:00",
    "translations": [
      {
        "languages_code": "en-US",
        "title": "Title here",
        "message": "Message here"
      },
      {
        "languages_code": "nl-NL",
        "title": "Titel hier",
        "message": "Bericht hier"
      }
    ]
  }]
}
```

## Workflow

1. **Gather context** - fetch sprint summary or source material
2. **Draft announcement** - write EN + NL versions
3. **Save to file** - `announcement-draft.md` for user to edit
4. **Open file** - `open /path/to/announcement-draft.md`
5. **User edits** - wait for approval
6. **Review changes** - note what user changed for learning
7. **Push to Directus** - create via MCP

## Important Rules

### Markdown formatting
- Use **double newlines** between paragraphs (single newline doesn't render as line break)
- Markdown supported: bold, bullet points, links

### Feature names
- Use **exact terminology** from the product
- Check `.po` files: `echo/echo/frontend/src/locales/*.po`
- Example: "Select all" not "Select all conversations"

### Level guidelines
- `"info"` - feature announcements, general notices
- `"urgent"` - outages, critical issues, breaking changes

### Expiry guidelines
- Info announcements: 2-4 weeks
- Urgent/outage notices: 1-2 days after resolved

### Translations
- Always provide `en-US` and `nl-NL`
- `de-DE` often left empty (optional)
- Keep messaging consistent across languages

## Draft File Template

```markdown
# Announcement Draft

## Settings
- level: info
- expires_at: YYYY-MM-DDTHH:MM:00

---

## EN-US

**Title:**
[Title here]

**Message:**
[Message here - use double newlines between paragraphs]

---

## NL-NL

**Title:**
[Titel hier]

**Message:**
[Bericht hier - gebruik dubbele nieuwe regels tussen paragrafen]
```

## Brand Guidelines

### Naming
- **dembrane** - always lowercase, even at start of sentence
- **ECHO** - the platform feature, use sparingly in external contexts

### Voice
Warm but not gushing. Direct but not cold. Smart but not showing off.

Sound like a trusted colleague, not a corporate announcement.

### Writing rules
1. Shortest possible, highest clarity
2. If you wouldn't say it out loud, rewrite it
3. No jargon, no corporate speak
4. Write for humans who are busy and smart

### Never say
- "We are pleased to inform you..."
- "Please be advised..."
- "In order to..."
- "Successfully" (just state what happened)
- "We apologize for any inconvenience this may have caused"

### Good patterns
| Do | Don't |
|----|-------|
| Chat doet het weer | We zijn verheugd u te informeren dat de functionaliteit hersteld is |
| Something went wrong. Try again. | We apologize for any inconvenience... |
| Saved | Successfully saved |

### Dutch localization
- Use **"je/jij/jou"** - never "u/uw" (always informal)
- Natural phrasing, not word-for-word translation
- Compound words: audiobestand (not "audio bestand")
- Keep English terms when they sound better: Dashboard, Upload, Chat

| English | Dutch |
|---------|-------|
| Conversation | Gesprek |
| Settings | Instellingen |
| It's not working | Doet het niet |
| We're fixing it | We zijn het aan het fixen |

### Full reference
See `echo/echo/brand/STYLE_GUIDE.md` for complete guidelines.
