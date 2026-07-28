# Skill: Create Announcement

Push in-app announcements to dembrane users. Announcements live in the Directus `announcement` + `announcement_translations` collections.

Two push paths:
1. **Directus MCP** (`mcp__directus__items`) — only if a Directus MCP server is configured in the session. Check with ToolSearch first; as of 2026-07-13 none is configured, so don't assume it.
2. **Direct prod SQL** — insert into the prod Postgres that Directus reads from (see "Direct SQL Pattern" below). Directus serves DB rows directly; no sync step needed. This is the known-working path.

## Schema

**`announcement`** (main table)
- `id` - UUID primary key
- `level` - `"info"` or `"urgent"`
- `expires_at` - datetime (ISO format)
- `translations` - nested translations
- `activity` - tracks which users have read it

**`announcement_translations`**
- `id` - integer autoincrement (omit when inserting via SQL)
- `announcement_id` - FK to `announcement.id`
- `languages_code` - `"en-US"`, `"nl-NL"`, `"de-DE"`
- `title` - plain text, sentence case
- `message` - markdown text (main content)

`announcement.user_created` is a FK to `directus_users` — set it via an email lookup so the record has an author in Directus.

## Fetch Methods

Always check the last ~5 announcements before drafting — they are the source of truth for tone, level, expiry, and markdown conventions.

```
# Via MCP (if configured)
mcp__directus__items: action=read, collection=announcement
query: { fields: ["*", "translations.*"], sort: ["-created_at"], limit: 5 }

# Via SQL (known-working)
SELECT a.id, a.created_at, a.expires_at, a.level, t.languages_code, t.title,
       left(t.message, 300) AS preview
FROM announcement a
LEFT JOIN announcement_translations t ON t.announcement_id = a.id
ORDER BY a.created_at DESC NULLS LAST, t.languages_code
LIMIT 14;
```

## Direct SQL Pattern

Connect to the prod Postgres (DigitalOcean managed cluster; find it with `doctl databases list`, get the URI with `doctl databases connection <cluster-id> --format URI --no-header`). No local psql needed — run it through the `postgres:16-alpine` container image.

Write the SQL to a file and pipe it in (inline `-c` quoting mangles apostrophes). Dollar-quote the title/message bodies (`$t$...$t$`, `$m$...$m$`) so `don't` / `what's` survive.

```sql
BEGIN;

WITH a AS (
  INSERT INTO announcement (id, created_at, updated_at, expires_at, level, user_created)
  VALUES (
    gen_random_uuid(), now(), now(),
    'YYYY-MM-DD 12:00:00', 'info',
    (SELECT id FROM directus_users WHERE email = '<author-email>' LIMIT 1)
  )
  RETURNING id
)
INSERT INTO announcement_translations (announcement_id, languages_code, title, message)
SELECT a.id, v.code, v.title, v.msg
FROM a, (VALUES
  ('en-US', $t$Title here$t$, $m$Message here$m$),
  ('nl-NL', $t$Titel hier$t$, $m$Bericht hier$m$)
) AS v(code, title, msg);

COMMIT;

-- verify
SELECT a.id, a.level, a.expires_at, t.languages_code, t.title
FROM announcement a
JOIN announcement_translations t ON t.announcement_id = a.id
WHERE a.created_at > now() - interval '5 minutes'
ORDER BY t.languages_code;
```

## Create Pattern (MCP)

```json
{
  "action": "create",
  "collection": "announcement",
  "data": [{
    "level": "info",
    "expires_at": "YYYY-MM-DDT12:00:00",
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

1. **Check previous announcements** - last ~5, for tone/level/expiry/format conventions
2. **Gather context** - fetch sprint summary or source material
3. **Draft announcement** - write EN + NL versions
4. **Save to file** - `announcement-draft.md` for user to edit
5. **Open file** - `open /path/to/announcement-draft.md`
6. **User edits** - wait for approval (skip 4-6 if the user hands you final copy — only fix obvious typos, and say which)
7. **Push to Directus** - via MCP if configured, else direct SQL
8. **Verify** - select the row back with both translations; report the announcement id

## Important Rules

### Markdown formatting
- Use **double newlines** between paragraphs (single newline doesn't render as line break)
- Markdown supported: bold, bullet points, links

### Feature names
- Use **exact terminology** from the product
- Check `.po` files: `echo/frontend/src/locales/*.po`
- Example: "Select all" not "Select all conversations"

### Level guidelines
- `"info"` - feature announcements, general notices, ongoing degradations with a roadmap
- `"urgent"` - active outages, critical issues, breaking changes

Observed convention in prod history: `urgent` has only ever been used for same-day outages (expiry within hours); everything that lasts days or weeks — including service degradations — ships as `info`.

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
- Don't call the product "ECHO" in user-facing copy — the product is just dembrane

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
See `echo/brand/STYLE_GUIDE.md` for complete guidelines.
