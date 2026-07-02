---
title: Webhooks
description: Subscribe to conversation and report events, manage webhook endpoints over the API, and verify the HMAC-SHA256 signature on every delivery.
audience: developer-external
---

# Webhooks

Webhooks let dembrane call *your* systems when something happens in a project - a
conversation finishes transcribing, a report is generated. Instead of polling the API, you
register an endpoint and dembrane `POST`s a payload to it as events occur. Use them to push
transcripts into a data warehouse, notify a Slack channel, kick off your own analysis, or sync
state into a CRM.

For the host-facing, point-and-click view of the same feature, see
[webhooks & integrations](../../features/webhooks-and-integrations.md). This page is the
developer reference.

> [!IMPORTANT]
> Webhooks are gated to *Changemaker and above*. On the managed service you'll need a
> Changemaker (or Guardian) workspace to use them; see
> [tiers & billing](../../features/tiers-and-billing.md). When you
> [self-host](./self-hosting.md), you operate the whole platform.

## Events

A webhook is registered against a project and fires for these events:

| Event | When it fires |
|---|---|
| `conversation.started` | A participant begins a conversation in the project. |
| `conversation.transcribed` | A conversation's audio has been transcribed. |
| `conversation.summarized` | A conversation's summary has been generated. |
| `report.generated` | A report has finished generating. |

These line up with the stages of the [processing pipeline](../developer-internal/processing-pipeline.md):
`started` at capture, `transcribed` then `summarized` as a conversation is processed, and
`report.generated` when a report completes.

## Managing webhooks (API)

Webhook endpoints are managed under a project's `webhooks` collection. All of these require an
[authenticated request](./authentication.md) (a Directus token) with the right
[workspace permissions](../../features/roles-and-permissions.md) - `workspace:webhooks` is an
admin/owner capability.

| Method & path | Action |
|---|---|
| `GET /api/projects/{pid}/webhooks` | List the project's webhooks. |
| `POST /api/projects/{pid}/webhooks` | Create a webhook (target URL, events, optional secret). |
| `PATCH /api/projects/{pid}/webhooks/{id}` | Update a webhook (URL, events, secret, enabled). |
| `DELETE /api/projects/{pid}/webhooks/{id}` | Remove a webhook. |
| `POST /api/projects/{pid}/webhooks/{id}/test` | Send a test delivery to the registered URL. |
| `GET /api/projects/{pid}/webhooks/{id}/copyable` | Get a copyable representation (for sharing/setup). |

> [!TIP]
> After creating a webhook, hit the `/test` endpoint. It sends a delivery to your URL so you
> can confirm your receiver is reachable and your signature verification works before any real
> event arrives.

## The payload

Deliveries are `POST`ed to your URL as JSON. Each payload identifies the event type and
carries the relevant identifiers and data for that event (for example, the conversation ID for
a `conversation.*` event, or the report ID for `report.generated`). The exact field set is
visible in the `/copyable` output and in the `/test` delivery - inspect those for the shape
your build produces rather than hard-coding fields.

The implementation lives in `service/webhook.py` if you're reading along in the code.

## Verifying deliveries: `X-Dembrane-Signature`

If you set a *secret* on the webhook, every delivery includes an
`X-Dembrane-Signature` header containing an *HMAC-SHA256* of the request body, keyed by
your secret. Verify it before trusting a payload - this is how you confirm a delivery really
came from dembrane and wasn't replayed or forged.

```python
import hashlib
import hmac

def is_valid(body: bytes, signature_header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    # constant-time compare against the value in X-Dembrane-Signature
    return hmac.compare_digest(expected, signature_header)
```

> [!WARNING]
> Always compute the HMAC over the *raw request body bytes*, exactly as received - not over a
> re-serialised object. Re-encoding JSON can reorder keys or change whitespace and break the
> comparison. Use a constant-time compare (`hmac.compare_digest`), and reject any delivery
> whose signature doesn't match.

If you don't set a secret, deliveries are sent unsigned - fine for a closed network, but set a
secret for anything reachable from the public internet.

## Good practices

- *Respond fast, process later.* Acknowledge the delivery with a `2xx` quickly and do the
  real work asynchronously. A slow or failing receiver shouldn't hold up dembrane.
- *Be idempotent.* Treat events as at-least-once; a delivery may arrive more than once.
- *Verify first.* Check the signature before doing anything with the payload.

## Related

- [Webhooks & integrations](../../features/webhooks-and-integrations.md) - the host-facing feature page.
- [Authentication](./authentication.md) - tokens for the management endpoints.
- [Export & integrations](./export-and-integrations.md) - for pulling data rather than receiving pushes.
- [Tiers & billing](../../features/tiers-and-billing.md) - the Changemaker gate.
- [Internal: the processing pipeline](../developer-internal/processing-pipeline.md) - what triggers each event.
