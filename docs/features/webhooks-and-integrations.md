---
title: Webhooks & integrations
description: React to events in dembrane from your own systems - webhook events, creating and testing them, signature verification, and the tier needed to use them.
audience: all
---

# Webhooks & integrations

A *webhook* lets dembrane tell *your* systems the moment something happens - a conversation
started, a transcript finished, a summary completed, a report generated. Instead of polling
dembrane to ask "is it done yet?", you register a URL and dembrane sends it a signed message
when the event occurs. That's how you wire dembrane into the rest of your stack: a Slack
alert when a report is ready, a database row when a conversation is transcribed, a
downstream job kicked off when a summary lands.

Webhooks are a *Changemaker-and-above* feature, gated on the
[tier](./tiers-and-billing.md). Within an eligible workspace, managing them sits with
[admins](./roles-and-permissions.md). On Free and Innovator workspaces the integrations tab
won't offer them.

## The four events

- `conversation.started` - a participant or host has begun a conversation.
- `conversation.transcribed` - a conversation's audio has been transcribed.
- `conversation.summarized` - a conversation has been summarised.
- `report.generated` - a [report](./reports.md) has finished generating.

Each event carries the identifiers your system needs to know *which* conversation or report
it's about, ready for you to fetch the detail (or [export](./export-and-data-portability.md)
it) if you need more.

## Adding and testing one

Webhooks live in a project's *integrations* tab:

1. *Create* a webhook by giving dembrane a URL and choosing which events it should receive.
2. *Test* it - dembrane sends a test payload to your URL so you can confirm your endpoint
   receives and parses it before relying on it.
3. There's a *copyable* form of the configuration to make setup in your own tooling
   straightforward.

The endpoints (`GET/POST/PATCH/DELETE /api/projects/{pid}/webhooks`, plus `/test`) are
documented on [webhooks](../users/developer-external/webhooks.md).

## Verifying the signature

So your endpoint can trust a request really came from dembrane, each webhook is signed. Set
a *secret* on the webhook, and dembrane computes an *HMAC-SHA256* signature over the payload
and sends it in the `X-Dembrane-Signature` header. Your endpoint recomputes the same HMAC
with the shared secret and compares - if they match, the request is authentic.

> [!WARNING]
> Always verify the `X-Dembrane-Signature` before acting on a webhook. A webhook URL is
> reachable from the internet by nature; the signature is what proves the caller is dembrane
> and not someone who guessed your URL.

## The integrations tab

The integrations tab is a project's connection point to the world outside dembrane. Webhooks
*push* events to you; [export](./export-and-data-portability.md) - transcript zips and
CSV/Excel - lets you *pull* data on demand. Both live here.

## Related

- [Webhooks (developer)](../users/developer-external/webhooks.md) - the endpoints, payloads,
  and signature-verification detail.
- [Tiers & billing](./tiers-and-billing.md) - webhooks need Changemaker or above.
- [Export & data portability](./export-and-data-portability.md) - the other half of the
  integrations tab: pulling data out.
- [Reports](./reports.md) - the source of the `report.generated` event.
