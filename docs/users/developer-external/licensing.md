---
title: Licensing
description: dembrane is BSL 1.1 - free for non-production and for small organisations in production, converting to GPLv3 after three years.
audience: developer-external
---

# Licensing

dembrane is open source under the *Business Source License 1.1 (BSL 1.1)*. The BSL is a
source-available licence designed to keep the code open and learnable while protecting the
project's ability to fund its own development. This page explains what that means in practice - 
what you can do for free, when you need a commercial licence, and who to talk to.

> [!NOTE]
> This page summarises the licence so you can make a decision. It is *not* legal advice and
> it is *not* the licence text. The `LICENSE` file in the repository is the authoritative
> source; read it before deploying, and take your own legal advice if your situation is at all
> borderline.

## What you can do for free

*Non-production use is unrestricted.* Read the code, run it locally, fork it, experiment,
learn from it, build prototypes, contribute back - none of that is gated. This is the open
part of "open source": the source is right there and you're welcome to use it.

*Production use is free below a finance threshold.* You may run dembrane in production at no
cost provided your organisation's *total finances are at or below €1,000,000 over any rolling
twelve-month period*. For most individuals, small teams, non-profits, and early-stage
projects, that means production use is free.

If you cross that threshold and want to run dembrane in production, you need a
[commercial licence](#commercial-licence).

## The Change Date - conversion to GPLv3

Each *release* of dembrane carries a *Change Date* of its *release date plus three
years*. On that date, that release's licence automatically converts from BSL 1.1 to
*GPLv3*.

In other words: every version of dembrane becomes fully GPLv3 open source three years after it
ships, regardless of the finance threshold. The BSL restriction is a rolling three-year window
that always eventually opens. Newer releases reset the clock for *their* code; older releases
keep converting on schedule.

> [!TIP]
> If you only need an older release and you're happy to wait, the GPLv3 conversion means the
> restriction is time-limited by design. For current releases in production above the
> threshold, the commercial licence is the path.

## Commercial licence

If your organisation is above the €1M threshold and wants to run a current release in
production, or you want terms the BSL doesn't grant (support, warranties, bespoke compliance,
managed hosting), dembrane offers a *commercial licence*. Bespoke compliance arrangements and
self-hosting support are available alongside it.

The managed service at dembrane.com is the turnkey alternative - see
[tiers & billing](../../features/tiers-and-billing.md). Changemaker and above is where most
teams land; the EU-sovereign Guardian tier is *coming soon*.

## At a glance

| Your situation | Under BSL 1.1 |
|---|---|
| Local dev, prototyping, learning, forking | Free, unrestricted (non-production). |
| Production, organisation finances ≤ €1M / 12 months | Free. |
| Production, organisation finances > €1M / 12 months | Needs a [commercial licence](#commercial-licence). |
| Using a release ≥ 3 years after its release date | GPLv3 (the Change Date has passed). |

## Who to contact

| Topic | Contact |
|---|---|
| Pull requests, security | sameer@dembrane.com |
| Legal, licensing, stewardship | bram@dembrane.com |
| Mission, press | jorim@dembrane.com |
| Hosting, commercial arrangements | evelien@dembrane.com |

For commercial-licence and self-hosting-support enquiries, *evelien@dembrane.com* (hosting /
commercial) or *bram@dembrane.com* (legal / stewardship) are the right starting points.

## Related

- [Contributing](./contributing.md) - the CLA and how to send changes.
- [Building on dembrane (overview)](./index.md) - what's open source.
- [Self-hosting](./self-hosting.md) - running it yourself.
- [Tiers & billing](../../features/tiers-and-billing.md) - the managed alternative.
