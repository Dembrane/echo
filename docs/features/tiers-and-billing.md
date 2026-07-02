---
title: Tiers & billing
description: dembrane's plans - Free, Innovator, Changemaker, Guardian - what each unlocks, how per-seat pricing works, and how billing is organised.
audience: all
---

# Tiers & billing

A *tier* is the plan a workspace is on - it decides which features that workspace has. There
are four, and they stack: each one includes everything below it. Prices are per seat, per
month, in euros.

## What each plan gives you

| Capability | Free | Innovator €20 | Changemaker €75 | Guardian €150 |
|---|---|---|---|---|
| Secure [transcription](./transcription.md) | ✓ | ✓ | ✓ | ✓ |
| Recording hours | 1 h | unlimited | unlimited | unlimited |
| Bring your own language model + [MCP](./mcp-and-bring-your-own-llm.md) | – | ✓ | ✓ | ✓ |
| Built-in analysis ([library](./library-and-analysis.md), summaries, themes) | – | – | ✓ | ✓ |
| [Audit logs](./account-and-security.md#audit-logs) | – | – | ✓ | ✓ |
| [White labelling](./data-ownership-and-compliance.md) | – | – | ✓ | ✓ |
| EU-sovereign stack | – | – | – | ✓ |

What each one is for:

- *Free* - one hour of recording, a single user, open registration, and the same secure,
  multilingual transcription as every paid tier. It's the only tier with an hour cap. On Free
  the heavier features ([chat](./chat-and-ask.md), [reports](./reports.md), extra workspaces)
  are gated, and you'll be prompted to upgrade when you reach for them.
- *Innovator* (€20) - unlimited hours, plus the option to point your own ChatGPT or Claude at
  your conversations over [MCP](./mcp-and-bring-your-own-llm.md) instead of dembrane's
  built-in analysis. *Coming soon*, once the MCP integration ships.
- *Changemaker* (€75) - the tier most teams land on, and the one you can buy yourself today.
  Adds dembrane's [built-in analysis](./library-and-analysis.md) on EU-hosted language models,
  [audit logs](./account-and-security.md#audit-logs), and
  [white labelling](./data-ownership-and-compliance.md).
- *Guardian* (€150) - everything in Changemaker on an EU-sovereign, CLOUD-Act-safe stack for
  the strictest compliance needs. *Coming soon*.

> [!TIP]
> Need bespoke compliance terms or to run dembrane yourself? Those go beyond the standard
> tiers - see [data ownership & compliance](./data-ownership-and-compliance.md) and the
> [external developer guides](../users/developer-external/index.md).

## Monthly vs yearly

The prices above are the yearly rate, which is the cheaper option. You can pay monthly
instead for 15% more per seat.

## What a seat is

A *seat* is what a person occupies in a workspace. Most roles use one - owner, admin, member,
billing, and external. The [observer](./roles-and-permissions.md#the-free-read-only-observer)
role is free and never does.

Two things make seats easy to live with:

- *They're metered, never blocked.* You can always add someone - dembrane counts the seat and
  reflects it in your bill rather than stopping the invite. Pending invites count too;
  observer invites don't. See [invites & access](./invites-and-access.md#seats-and-pending-invites).
- *A person counts once per workspace.* Seats are pooled across the workspaces in a billing
  account, and the same person in the same workspace is a single seat, not one per project.

> [!TIP]
> The mental model is "add who you need, watch the count." If someone only needs to *see*
> results, make them a free
> [observer](./roles-and-permissions.md#the-free-read-only-observer).

## How billing is organised

Billing attaches to a *billing account*, scoped one of two ways:

- *Pooled across your organisation* - the default. All your
  [internal workspaces](./organisations-and-workspaces.md) share one account and pool their
  seats.
- *Per workspace* - used for external-client workspaces, where a
  [partner](./partner-program.md) runs work for someone else. That workspace gets its own
  account so the client's usage stays cleanly apart.

The full split, and what it means for data ownership, is in
[data ownership & compliance](./data-ownership-and-compliance.md).

Payments go through Mollie. Where dembrane needs to invoice offline - larger or public-sector
customers paying by bank transfer - staff can arrange managed invoicing
([staff billing guides](../users/staff/managed-and-offline-billing.md)).

> [!NOTE]
> Existing paying customers move onto Changemaker (with unlimited hours) until their renewal,
> so nobody loses recording capacity in the transition.

## Requesting an upgrade

If you're a [member](./roles-and-permissions.md#what-member-really-means-day-to-day) without
billing rights, you don't pay the bill - you *request* an upgrade (a new workspace or a higher
tier), and someone with billing rights, or dembrane staff, approves it. The same flow gates a
few transitions, like
[moving a workspace out of "open"](./visibility-and-discovery.md#the-one-paywalled-transition),
which needs Innovator or above.

## Related

- [Roles & permissions](./roles-and-permissions.md) - who can see invoices and change the plan.
- [MCP & bring-your-own-LLM](./mcp-and-bring-your-own-llm.md) - the coming-soon Innovator integration.
- [Data ownership & compliance](./data-ownership-and-compliance.md) - internal vs external billing and the sovereign stack.
- [Organisations & workspaces](./organisations-and-workspaces.md) - what shares a billing account.
- [Invites & access](./invites-and-access.md) - how seats are counted as you add people.
- [Library & analysis](./library-and-analysis.md) - the built-in analysis Changemaker unlocks.
