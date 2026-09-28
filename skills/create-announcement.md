---
name: create-announcement
description: Draft and publish an in-app announcement (the bell in the dashboard) to every dembrane user, in English and Dutch, and take one down early.
---

# Create an announcement

Needs a staff API key (see `data-export.md`).

```sh
API=https://api.dembrane.com
H=(-H "Authorization: Bearer $DEMBRANE_STAFF_KEY" -H "content-type: application/json")
```

## 1. Read the last five

They set tone, level, expiry and markdown conventions:

```sh
curl -sf "${H[@]}" "$API/api/v2/me/announcements?include_expired=true&limit=5" \
  | jq '.[] | {id, created_at, expires_at, level, translations: [.translations[] | {languages_code, title, message: .message[:300]}]}'
```

## 2. Draft

Write `announcement-draft.md` with level, expiry, and the English and Dutch title and message, for the person to edit. If they hand you final copy, fix only obvious typos and say which.

- Level: `info` for features, notices and degradations with a roadmap; `urgent` only for a same-day outage.
- Expiry: 2 to 4 weeks for `info`; 1 to 2 days after the fix for an outage.
- Title is plain text in sentence case. Message is markdown: bold, bullets, links; a blank line between paragraphs.
- Use the product's exact words: check `echo/frontend/src/locales/*.po` ("Select all", not "Select all conversations").
- Voice (`skills/brand-guidelines.md`): lowercase dembrane, never "ECHO"; short, warm, direct. No "We are pleased to inform you", "Please be advised", "successfully" or apologies for inconvenience.
- Dutch: je/jij, never u; natural phrasing, not word for word (Gesprek, Instellingen, audiobestand).

## 3. Publish (after approval)

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/announcements" -d @- <<'JSON' | jq
{
  "level": "info",
  "expires_at": "2026-10-19T12:00:00Z",
  "translations": [
    {"languages_code": "en-US", "title": "Title here", "message": "First paragraph.\n\nSecond paragraph."},
    {"languages_code": "nl-NL", "title": "Titel hier", "message": "Eerste alinea.\n\nTweede alinea."}
  ]
}
JSON
```

It is live for everyone as soon as it returns. `en-US` is required; other codes: `de-DE`, `es-ES`, `fr-FR`, `it-IT`, `uk-UA`, `cs-CZ`. Report the returned `id`.

## Take it down or extend it

```sh
curl -sf "${H[@]}" -X PATCH "$API/api/v2/admin/announcements/$ID" -d "{\"expires_at\":\"$(date -u +%FT%TZ)\"}"
```

A time in the past takes it down now; a later one keeps it up.
