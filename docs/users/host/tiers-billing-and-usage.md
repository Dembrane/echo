---
title: Tiers, billing & usage - for hosts
description: As a host, understand the plans, seats, and metered usage - what each tier unlocks, how to upgrade, and how to request one.
audience: host
---

# Tiers, billing & usage (for hosts)

dembrane comes in four plans - *Free, Innovator, Changemaker, Guardian*. Your workspace's plan
decides your recording hours, whether you get built-in
[analysis](./library-and-analysis.md) and [reports](./reports.md), and a few compliance features
on top. Here's what each gives you, how seats and usage work, and how to move up.

The full breakdown is in the canonical [tiers & billing](../../features/tiers-and-billing.md)
reference.

## The plans

Each tier includes everything below it, and each is counted in seats. There's no published
price: contact dembrane for current pricing. See [upgrading](#upgrading).

| Capability | Free | Innovator | Changemaker | Guardian |
|---|---|---|---|---|
| Secure transcription | ✓ | ✓ | ✓ | ✓ |
| Recording hours | 1 h | unlimited | unlimited | unlimited |
| Bring-your-own-LLM + MCP | - | ✓ | ✓ | ✓ |
| Built-in analysis (Gemini) | - | - | ✓ | ✓ |
| Audit logs | - | - | ✓ | ✓ |
| White-labelling | - | - | ✓ | ✓ |
| EU-sovereign stack | - | - | - | ✓ |

In practice:

- *Free* - 1 hour of recording, a single user, secure transcription. The only tier with an
  hours cap. Good for trying dembrane on a small session.
- *Innovator* - unlimited hours, *no built-in analysis*; the
  [chat screen](./chat-and-ask.md) becomes a bring-your-own-LLM integration over MCP (connect
  ChatGPT/Claude). *Coming soon*, gated on MCP shipping.
- *Changemaker* - unlimited hours plus *built-in analysis* on EU-hosted Gemini
  ([library](./library-and-analysis.md), [reports](./reports.md), chat), audit logs,
  and white-labelling. Available now.
- *Guardian* - everything in Changemaker on a CLOUD-Act-safe EU-sovereign stack.
  *Coming soon*.

> [!NOTE]
> Existing paying customers move to Changemaker (unlimited hours) until renewal. Bespoke
> compliance and self-hosting are available - talk to dembrane.

## Seats

Most roles take a *seat*: owner, admin, member, billing, external. *Observer* is free.
Seats are metered, never blocked - inviting never hits a wall, the count just shows in usage. A
person counts once per workspace, pooled across the workspaces on a billing account. See
[roles & permissions](../../features/roles-and-permissions.md) for which role does what, and
[managing your workspace](./managing-your-workspace.md) for adding people.

## Usage

Open *Settings → Billing & usage* (or the org-wide rollup if you run several workspaces) to see
your *recording hours* (capped at 1 h on Free, unlimited above), *seats* in use, and
per-project usage under each project's own *Usage* section.

> [!TIP]
> On Free, if you're planning a session over an hour, check usage and upgrade before the event,
> not mid-recording. On paid tiers, hours are unlimited.

## Upgrading

Use the in-app contact flow or contact dembrane to discuss an upgrade.

If you don't hold billing access, you can also *request an upgrade* from inside the workspace.
It goes to whoever can approve it (your workspace owner or admin, or dembrane staff for
free-tier requests), and you're notified of the decision.

If your workspace already pays, none of this changes it. Your plan, your amount and your
invoices stay under *Settings → Billing & usage*, and you manage the subscription there as
before.

## What's gated, at a glance

| If you're blocked from… | You need… |
|---|---|
| Recording past 1 hour | Innovator or above |
| The library, reports, dembrane's built-in chat | Changemaker or above |
| Audit logs, white-labelling | Changemaker or above |
| Making a workspace/project more private than "open" | Innovator or above |
| An EU-sovereign stack | Guardian (*coming soon*) |

## Related

- [Tiers & billing - feature reference](../../features/tiers-and-billing.md) - the canonical
  plan page, and how to get a price.
- [Roles & permissions](../../features/roles-and-permissions.md) - which roles take seats and
  what they can do.
- [Managing your workspace](./managing-your-workspace.md) - adding people and reading usage.
- [Library & analysis](./library-and-analysis.md) and [reports](./reports.md) - the headline
  Changemaker features.
- [Chat & Ask](./chat-and-ask.md) - built-in on Changemaker, bring-your-own-LLM on Innovator.
