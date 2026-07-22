# Skill: Data Export

Prepare and deliver a copy of a user's data when they request it. Use for GDPR/AVG data access requests ("data opvraag", "artikel 15", "export my data", "copy of my recordings"). The legal deadline is one month from the request date. Aim to deliver in days: a fast, personal response turns a compliance chore into a service moment.

## 1. Verify and locate the account

- The request must come from the account's registered email address. A matching sender is sufficient identity verification.
- Find the account in prod. There is no local psql; use podman with a doctl connection URI (cluster ids via `doctl databases list`):

```sh
PGURI=$(doctl databases connection <prod-postgres-cluster-id> --format URI --no-header)
podman run --rm docker.io/library/postgres:16-alpine psql "$PGURI" -c \
  "SELECT id, email, first_name, last_name, status, last_access FROM directus_users WHERE lower(email) = '<email>';"
```

## 2. Understand why they asked

Data requests rarely arrive in a vacuum. Before replying, check the user's usage in the database (projects, conversations, durations) and their PostHog trail (`distinct_id` = their email): caps hit, upgrade prompts viewed, rage clicks, errors. The reply can then address the real problem, not just the request.

## 3. Assemble the package

One folder named `dembrane-data-export-<firstname-lastname>`:

- `README.md`: customer-facing guide (section 4)
- `user.json`: account record with id, email, name, status, last_access, language, provider. Never include auth or token fields
- `projects.json`: the `project` rows owned by the user
- `conversations.json`: the `conversation` rows for those projects, with `merged_transcript` dropped (`to_jsonb(c) - 'merged_transcript'`)
- `audio/`: one merged recording per conversation as mp3, with friendly filenames

The exact contents of the package is a product decision, not a fixed rule. The current call and its reasoning live in the Notion Decisions database (entry dated 2026-07-13, search "data requests"). Read it before changing what goes in.

Fetching the audio: `conversation.merged_audio_path` points at the private uploads bucket, so anonymous GET returns 403. Use the platform's object storage credentials, which are managed as cluster secrets and available to authorized operators only. Request access through the usual ops channel and never copy credential values or their exact storage locations into files, chats, or this repo:

```sh
podman run --rm -v "$OUT":/out -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY docker.io/amazon/aws-cli \
  --endpoint-url https://ams3.digitaloceanspaces.com \
  s3 cp "s3://<uploads-bucket>/audio-conversations/<file>.mp3" /out/<friendly-name>.mp3
```

## 4. Customer-facing README

Follow the brand voice: lowercase dembrane, plain language, no legalese, no internal identifiers (cluster names, buckets, database ids, request procedure). One line per file explaining what it is. End with: "Questions? Just reply to the email this came with."

## 5. Deliver

- Zip the folder, excluding `.DS_Store`.
- Share via a private link and keep it live for 30 days:
  - Google Drive is simplest, but Drive links never expire on their own. Set a reminder to unshare after 30 days.
  - A Spaces signed URL also works. SigV4 presigning caps at 7 days; for 30 days sign a SigV2 URL (HMAC-SHA1). Delete the object once it expires. Note that a SigV2 URL signs the verb, so test it with a ranged GET, not a HEAD.
- Before the email goes out, verify the uploaded zip is the final version (name and size), not an earlier draft.
- Reply personally from a real address. Say what the export contains and how long the link works. If the usage trail (section 2) surfaced friction or buying intent, address it in the same email.

## 6. Log it

- Attio: add a note on the person's record covering what was requested, what was delivered, and when, with a link to the decision entry.
- If handling the request forced a new policy call, record it in the Notion Decisions database and backlink the Attio note.
- Keep an internal archive of exactly what was sent.
