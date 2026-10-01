---
name: popcorn-demo
description: Make a clearly synthetic Popcorn sales demo for an organisation from its website and a short brief, using echo's demo builder through the staff API. Use for fictional demo projects to show a prospect.
---

# Popcorn demo

echo builds the demo itself: it reads a few pages of the website, writes a research report, authors fictional conversations, seeds an organisation with the contact as admin, runs Popcorn extraction and reviews the result. The agent only starts it, follows it and publishes it. Needs a staff API key (see `data-export.md`).

```sh
API=https://api.dembrane.com
H=(-H "Authorization: Bearer $DEMBRANE_STAFF_KEY" -H "content-type: application/json")
```

## 1. Start

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/accounts/demos" -d @- <<'JSON' | tee demo.json | jq '{id, status}'
{
  "organisation_name": "Example Housing",
  "website_url": "https://www.example.org",
  "brief": "What the demo should show, in a few sentences.",
  "language": "nl",
  "example": "Optional: an event or situation to set it in.",
  "contact_name": "Name of the contact",
  "contact_email": "contact@example.org",
  "sign_in": false
}
JSON
```

`language` is `en` or `nl`. `sign_in: true` invites the contact to sign in with an email code when the demo is published. An optional `offer` prepares an offer draft on the organisation; staff send it later.

## 2. Follow

```sh
ID=$(jq -r .id demo.json)
curl -sf "${H[@]}" "$API/api/v2/admin/accounts/demos/$ID" | jq '{status, steps: [.steps[] | {name, status, error}], links}'
```

Steps run `fetch`, `research`, `author`, `seed`, `extract`, `review`. Poll until `status` is `draft` or `failed`. On `failed`, read the step's `error`, then `POST $API/api/v2/admin/accounts/demos/$ID/retry`: it resumes at the failed step. `GET $API/api/v2/admin/accounts/demos` lists every demo.

## 3. Review before publishing

Open `links.projects` (the demo in the dashboard) and read `research` in the status. Check that the first screen says the stories are invented, that no real person is quoted or named as saying anything, and that nothing is presented as a real finding. A person decides whether it is good enough to show.

## 4. Publish

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/accounts/demos/$ID/publish" -d '{}' | jq '{status, links}'
```

Pass `{"sign_in": true}` or `false` to override the choice made at the start. Return `links.public` (the live presentation per language), `links.account` and `links.continue_url`. Do not send outreach unless a person says send.
