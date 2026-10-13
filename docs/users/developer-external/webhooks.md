---
title: Webhooks
description: The four events dembrane sends, the payloads, the X-Webhook-Signature header and how to verify it, retries, and where a host sets a webhook up.
audience: developer-external
---

# Webhooks

dembrane sends an HTTP POST with a JSON body to your URL when something happens in a project. You do not poll.

A webhook belongs to one project. A host adds it under "Automation" (Beta) in the project's sidebar, with "Add webhook". Two conditions apply:

- The person is an admin or owner of the workspace. Anyone else reads "Only workspace admins can manage project automation."
- The workspace is on the Changemaker plan or above. See [tiers & billing](../../features/tiers-and-billing.md).

The form asks for a "Name", a "Webhook URL", an optional "Secret" and the "Events to listen for". "Clone from another project" copies the settings of a webhook you manage elsewhere.

## Events

| Event | Sent when |
|---|---|
| `conversation.started` | A participant starts a conversation. |
| `conversation.transcribed` | The conversation is finished and every chunk of it is transcribed. |
| `conversation.summarized` | The conversation's summary is written. |
| `report.generated` | A report finishes generating. |

If you want the finished conversation, subscribe to `conversation.summarized` only. Its payload already carries the transcript and the summary, so you make no second call.

## The request

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Dembrane-Webhook/1.0` |
| `X-Webhook-Event` | The event name. |
| `X-Webhook-Signature` | `sha256=<hex>`. Present only when the webhook has a secret. |

A conversation event:

```json
{
  "event": "conversation.summarized",
  "timestamp": "<ISO time of the event>",
  "conversation": {
    "id": "...",
    "created_at": "...",
    "updated_at": "...",
    "participant_name": "...",
    "duration": 120,
    "source": "PORTAL_AUDIO",
    "is_finished": true,
    "is_all_chunks_transcribed": true,
    "tags": ["..."],
    "emails_csv": "",
    "transcript": "...",
    "summary": "..."
  },
  "project": { "id": "...", "name": "...", "language": "..." },
  "dashboardUrl": "<dashboard>/<locale>/w/<workspace id>/projects/<project id>/conversations/<conversation id>/overview"
}
```

- `transcript` is present on `conversation.transcribed` and `conversation.summarized`.
- `summary` is present on `conversation.summarized` only.
- `conversation.started` has neither.
- `emails_csv` is always present. It is an empty string when there are no emails.

A report event:

```json
{
  "event": "report.generated",
  "timestamp": "...",
  "report": { "id": 1, "status": "...", "language": "...", "date_created": "..." },
  "project": { "id": "...", "name": "...", "language": "..." },
  "dashboardUrl": "<dashboard>/<locale>/w/<workspace id>/projects/<project id>/report"
}
```

## Verify the signature

Set a secret and check `X-Webhook-Signature` on every delivery. Without a secret the delivery is unsigned.

The signature is HMAC-SHA256, keyed with your secret, over the payload written as compact JSON with sorted keys. It is not computed over the raw request body. The body is sent with spaces after `,` and `:` and with keys in their original order, so hashing the raw bytes gives a different result.

So: parse the body, write it again in the canonical form, then compare.

```python
import hashlib
import hmac
import json


def is_valid(body: bytes, signature_header: str, secret: str) -> bool:
    payload = json.loads(body)
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    digest = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest("sha256=" + digest, signature_header)
```

In another language, produce the same canonical form before you hash:

- keys sorted by code point, at every level;
- `,` and `:` with no spaces;
- ASCII only, with every other character written as a `\uXXXX` escape;
- numbers written the way Python prints them.

## Delivery and retries

| Your answer | What dembrane does |
|---|---|
| `2xx` | Done. |
| `4xx` | Treats it as a refusal. It is not retried. |
| Anything else, a timeout or a network error | Retries 3 times. The first wait is 5 seconds and each wait doubles. |

- A delivery times out after 40 seconds. Answer fast and do the work afterwards.
- Redirects are not followed. A `3xx` answer counts as a failure and is retried.
- Delivery is at least once. Make your receiver safe to call twice with the same event.
- A retry sends the same body as the first attempt. The URL and the secret are read at send time, so an edit takes effect on deliveries already waiting.
- Only a webhook with status `published` receives deliveries. A new webhook is published.

## The URL

The URL must start with `http://` or `https://` and resolve to a public address. A URL that resolves to a loopback, private or other internal address is refused with the code `webhook.target_not_allowed`.

## Test it

"Test webhook" on the Automation page sends a sample to your URL and reports whether it answered. The sample has the shape of a summarised conversation with `event` set to `webhook.test`, and it is signed like a real delivery. Use it to check your signature code before a real event arrives.

## Manage webhooks over the API

These routes need a signed-in session of a person who may manage the project's webhooks. See [authentication](./authentication.md) for what that means for scripts.

| Method and path | What it does |
|---|---|
| `GET /api/projects/:project_id/webhooks` | Lists the project's webhooks: `id`, `name`, `url`, `events`, `status`, `date_created`, `date_updated`. The secret is never returned. |
| `GET /api/projects/:project_id/webhooks/copyable` | Lists webhooks of your other projects, to copy settings from. |
| `POST /api/projects/:project_id/webhooks` | Creates one. Body: `name`, `url`, `events` (required) and `secret` (optional). Answers `201`. |
| `PATCH /api/projects/:project_id/webhooks/:webhook_id` | Updates `name`, `url`, `secret`, `events` or `status`. |
| `DELETE /api/projects/:project_id/webhooks/:webhook_id` | Deletes it. Answers `204`. |
| `POST /api/projects/:project_id/webhooks/:webhook_id/test` | Sends the sample and returns `success`, `status_code` and `message`. |

`status` is `published`, `draft` or `archived`.

## If you run dembrane yourself

`ENABLE_WEBHOOKS` is the global switch. It is on by default. `WEBHOOKS_ALLOW_PRIVATE_TARGETS` lets a URL resolve to a private address. It is for local development only.

## Related

- [Webhooks & integrations (feature)](../../features/webhooks-and-integrations.md)
- [Export & integrations](./export-and-integrations.md)
- [MCP & bring-your-own-LLM](./mcp-and-byo-llm.md)
- [Authentication](./authentication.md)
- [Tiers & billing](../../features/tiers-and-billing.md)
