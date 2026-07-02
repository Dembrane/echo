---
title: Contributing
description: How to contribute to dembrane - pull requests, the CLA, the code of conduct, security disclosure, and the community Slack.
audience: developer-external
---

# Contributing

dembrane is built in the open, and contributions are welcome. Whether you've found a bug,
written a fix, or want to add a feature, this page explains how to get your change in - and how
we keep the project safe and maintainable while doing it.

The guiding principle is the same one behind the product: *PEOPLE KNOW HOW*. The people using
dembrane and reading its code often see things the maintainers don't. We'd rather hear from you
than not.

> [!IMPORTANT]
> The authoritative process lives in the repository's `CONTRIBUTING` file and `LICENSE`.
> This page summarises them; if anything here and those files disagree, the files win. Read
> [licensing](./licensing.md) before you contribute, because your contributions are licensed
> under the project's terms.

## Before you start

- *Set the project up locally.* Follow [self-hosting](./self-hosting.md) for the dev
  container and `mprocs`, or the deeper
  [internal local-development guide](../developer-internal/local-development.md).
- *For anything non-trivial, open an issue first.* A short discussion before you write code
  saves everyone time and avoids a PR that has to be rewritten.

## What gets prioritised

*Security and privacy pull requests are prioritised.* dembrane handles people's spoken words
 - often sensitive, often personal - so anything that improves security posture, fixes a data
leak, or strengthens privacy guarantees jumps the queue. If your PR is in this category, say so
in the description.

## Pull-request requirements

A PR is much more likely to be merged quickly if it arrives complete:

- *Tests.* Cover the behaviour you changed. New features need new tests; bug fixes need a
  test that fails before your change and passes after.
- *Style.* Match the existing code style and pass the project's linters and formatters
  (`uv`-managed Python on the backend, `pnpm`-managed TypeScript on the frontend).
- *Docs.* If you change behaviour, configuration, or an endpoint, update the relevant
  documentation in the same PR. A feature without docs is half-finished.

Keep PRs focused - one logical change per PR is far easier to review than a sprawling one.

## The Contributor Licence Agreement (CLA)

dembrane requires a *CLA*. By contributing, you grant *Dembrane B.V.* a perpetual licence
over your contributions. This is what lets the project ship your code under both the open BSL
1.1 licence and the commercial licence (and re-licence to GPLv3 on each release's Change Date,
as described in [licensing](./licensing.md)). You'll be prompted to accept the CLA as part of
the contribution process; we can't merge contributions without it.

## Code of conduct

dembrane has a *code of conduct*, and it applies everywhere the community gathers - issues,
pull requests, and the Slack. The short version: be decent, be respectful, assume good faith,
and make space for people who are new. The full text is in the repository.

## Reporting a security issue

> [!WARNING]
> *Do not open a public issue or PR for a security vulnerability.* Disclosing it publicly
> before it's fixed puts every dembrane user at risk.

Report security issues privately to *sameer@dembrane.com*. Include enough detail to
reproduce, and give us a reasonable window to fix and ship before any public disclosure.
Security and privacy fixes are prioritised, as noted above.

## Community Slack

There's a *community Slack* for questions, discussion, and help getting set up - a good place
to float an idea before you write code, or to ask why something works the way it does. The
invite link is in the project configuration (and surfaced in the dashboard); the maintainers
and other contributors hang out there.

## Where to dig deeper

If you're going to work on the codebase in earnest, the
[internal developer guides](../developer-internal/index.md) are written for exactly that:

- [Architecture](../developer-internal/architecture.md) - how the services fit together.
- [The data model](../developer-internal/data-model.md) - the Directus collections.
- [The processing pipeline](../developer-internal/processing-pipeline.md) - transcription
  through to reports.
- [Deployment & releases](../developer-internal/deployment-and-releases.md) - how changes ship.

## Related

- [Licensing](./licensing.md) - BSL 1.1, the Change Date, and the CLA's purpose.
- [Self-hosting](./self-hosting.md) - getting it running locally.
- [Building on dembrane (overview)](./index.md).
- [Internal developer overview](../developer-internal/index.md).
