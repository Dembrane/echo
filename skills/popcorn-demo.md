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

For someone who already uses dembrane, first ask where they work. The check is staff only and reads the email from the body, never the URL:

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/accounts/demos/check" \
  -d '{"contact_email": "contact@example.org", "organisation_name": "Example Housing"}' | jq
```

`contact` is null without an email, else `has_account`, `name` and `organisations` (the live organisations they are a member of, with `role` and `account_stage`, prospects last). `organisations_named` lists other live organisations with that name, and `demos` the five newest earlier demos for that email or name, with `same_contact` and `same_organisation`. Nothing in the answer blocks building: tell a person about a repeat and let them decide.

To put the demo in one of their organisations, add `"org_id": "<organisation id>"` to the start. The contact must have an account and be a live member of it, the organisation must not be deleted, and `offer` cannot come with it; otherwise the answer is a 422 naming `org_id` (or `offer`) and nothing is made. The demo then gets a workspace of its own in that organisation, named after `organisation_name`, with the project pinned in it and owned by the contact. No organisation, account manager, stage or onboarding is added, and the contact's role there does not change. `existing_organisation` in the status names the organisation from the first answer on. An `org_id` wins over a shared staff demo workspace.

The staff member who starts the demo (the person, or the holder of the staff key) becomes an admin of the demo's own workspace at the `seed` step, so the draft is in their own workspace list: a direct row, never an organisation membership, and only for a @dembrane.com account. A row they already have there, removed or not, is left as it is, and a maker who is the demo's contact is not added at the seed (they join at hand-over or release like any contact). The seed's `demo.seeded` event names an added maker under `staff_member_added_to_workspace`. Outside the customer's organisation the dashboard treats them as external there: they open the project, the portal editor and the brief, but not the workspace's settings, a new project or a copy, pinning or deleting conversations. A demo never handed over or released keeps them as its only admin, unable to leave it. In a held workspace that row opens it to them alone. It takes no seat anywhere: a @dembrane.com account outside the customer's organisation never takes a seat on its account (billing, reconcile, the invite preview and the staff rollup agree). A demo in the shared staff demo workspace adds nobody. They stay a member after publishing; the workspace's admins can remove them.

## 2. Follow

```sh
ID=$(jq -r .id demo.json)
curl -sf "${H[@]}" "$API/api/v2/admin/accounts/demos/$ID" | jq '{status, steps: [.steps[] | {name, status, error}], links}'
```

Steps run `fetch`, `research`, `author`, `seed`, `extract`, `review`. Poll until `status` is `draft` or `failed`. On `failed`, read the step's `error`, then `POST $API/api/v2/admin/accounts/demos/$ID/retry`: it resumes at the failed step. `GET $API/api/v2/admin/accounts/demos` lists every demo.

## 3. Review before publishing

Open `links.projects` (the demo in the dashboard; the staff member who started it can open it, a held one included) and read `research` in the status. Check that the first screen says the stories are invented, that no real person is quoted or named as saying anything, and that nothing is presented as a real finding. A person decides whether it is good enough to show.

## 4. Publish

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/accounts/demos/$ID/publish" -d '{}' | jq '{status, links}'
```

Pass `{"sign_in": true}` or `false` to override the choice made at the start. With sign-in, the contact also becomes an admin of the demo's workspace and the demo project is pinned there, so their organisation page shows it on every visit. Return `links.public` (the live presentation per language), `links.account` and `links.continue_url`. Do not send outreach unless a person says send.

In an existing organisation (`existing_organisation` is set) the workspace is hidden from everyone there, its owner included, until a publish with `sign_in: true`. That publish hands it over: the workspace opens to the organisation, the contact joins it as admin (unless they had a row there before, removed or not), and they get one email, "Your demo is ready", whose button and `links.continue_url` open the demo project through the sign-in. A publish with `sign_in: false` only makes the public link live and keeps the workspace hidden. A staff key cannot send the email, so a person publishes with sign-in. Sending an offer to the organisation or enabling it does not hand the demo over. A publish with `sign_in: true` checks the organisation and the contact again: if the organisation was deleted or the contact is no longer a live member, it answers 409 with a sentence that says why and publishes nothing. While the demo is a draft, support access to its workspace cannot be requested (409).
