---
title: Contributing
description: How to contribute to dembrane. What is wanted, the checks to run, the contributor agreement, translations and how to report a security issue.
audience: developer-external
---

# Contributing

Contributions are welcome: a bug report, a fix, a translation, a review of someone else's pull request. The repository's `CONTRIBUTING.md` is the authority and this page follows it.

For anything larger than a small fix, open an issue and discuss it before you write code.

## What is wanted most

The team is particularly interested in:

- security improvements
- privacy enhancements
- reliability enhancements
- public sector application experience
- backend development
- frontend development

Contributions are handled in three groups.

| Kind | How it is treated |
|---|---|
| Security and privacy improvements | Highest priority. Reviewed and merged quickly when they verifiably improve security or privacy. |
| Bug fixes and core improvements | Reviewed on impact and fit with the project's goals. |
| New features | Must fit the roadmap, and should include documentation and tests. |

## Before you open a pull request

1. Set the project up. The commands are under "Run it locally" on the [self-hosting page](./self-hosting.md). The [local development guide](../developer-internal/local-development.md) goes further.
2. Follow the existing code style, add tests for new features and update the documentation your change touches.
3. Run the checks that CI runs.

```sh
cd dembrane/platform
bun run check        # lint, types, the layer rule, tests
```

```sh
cd dembrane/frontend
pnpm lint
pnpm exec tsc
pnpm exec vitest run
```

The backend is Bun and TypeScript. The frontend uses pnpm.

## The contributor agreement

Your first pull request needs the "Dembrane B.V. Individual Contributor License Agreement" (`CLA.md`).

- You keep all right, title and interest in your contributions, except for the licences you grant.
- You grant Dembrane B.V., and the recipients of its software, a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright licence, with the right to sublicense.
- You also grant a patent licence, which ends for anyone who starts patent litigation over the work.
- You state that the contribution is your own original work, or you mark third-party work as such.

To sign, add your GitHub username as a new line in `contributors.yml`, in the same pull request. A check on every pull request to `main` comments when the author is missing from that file.

`CONTRIBUTING.md` also says: "By contributing, you agree that your contributions will be licensed under our license." See [licensing](./licensing.md).

## Review

1. Initial review by maintainers.
2. Feedback and discussion.
3. Revisions if needed.
4. Final review and merge.

## Translations

You can translate the dashboard and the participant portal without being a developer. `TRANSLATING.md` in the repository is the guide.

- The interface has 8 languages: English (the source text), Dutch, German, French, Spanish, Italian, Ukrainian and Czech. Italian, Ukrainian and Czech are marked as partial.
- You can suggest wording in an issue, edit a `.po` file in the browser on GitHub, or edit locally.
- Change `msgstr` only. Keep placeholders, tags and plural structure exactly. Leave an entry empty when you are unsure.
- Do not edit the generated `.ts` catalogs by hand. A local change includes both the `.po` file and the regenerated catalog: run `pnpm messages:extract`, edit, then `pnpm messages:compile` in `dembrane/frontend`.
- A new language starts with an issue. A `.po` file alone does not enable a language.

## Security issues

Email sameer@dembrane.com to disclose a security vulnerability. The team investigates all legitimate reports.

## Conduct and help

- The code of conduct is `CODE_OF_CONDUCT.md` in the repository.
- Create an issue for a bug.
- Email sameer@dembrane.com for general guidance.

## Related

- [Licensing](./licensing.md)
- [Self-hosting](./self-hosting.md)
- [Local development](../developer-internal/local-development.md)
- [Architecture](../developer-internal/architecture.md)
- [Building on dembrane](./index.md)
