---
title: Internal developer overview
description: Orientation for engineers who work on the dembrane codebase. The stack in one screen, the repository layout, and a map of the guides in this section.
audience: developer-internal
---

# Internal developer overview

dembrane is one Bun and TypeScript backend on PostgreSQL, and one React frontend. Each page in this section gives you the shape of one part in a few screens, then names the file in the repository that decides the detail.

If you integrate with dembrane or run it yourself, start at the [external developer guide](../developer-external/index.md).

## The stack in one screen

- Five apps deploy: `api`, `worker`, `media`, `web` and `migrate`. Each builds to one compiled binary.
- The apps are built from packages in three layers. Apps sit on top. Namespaces are the product areas. Capabilities are building blocks with no business rules.
- PostgreSQL is the only stateful service the platform needs. Jobs, schedules, live events, presence and rate limits all run on it. Audio and files live in S3-compatible object storage.
- There is no Redis, no Directus service, no Python process and no separate agent service.
- The frontend is one React and Vite codebase. It serves both the dashboard and the participant portal.
- Language models run on Google Vertex AI. Features ask for a model group, never a vendor model name.

[Architecture](./architecture.md) explains each line.

## The repository at a glance

| Path | What is in it |
|---|---|
| `dembrane/platform` | The backend. `apps/` holds the five programs and `packages/` the libraries they are built from. `legacy/` holds what exists only because of the previous stack. Nothing in it ships in an image. |
| `dembrane/frontend` | The dashboard and the participant portal. |
| `dembrane/infra` | Terraform for the preview, staging and production environments. |
| `.github/workflows`, `.github/scripts` | The checks, the image builds and the deploys. |
| `docs` | This documentation. |
| `dembrane-go` | The iOS app. |
| `brand`, `skills` | Logos and style assets, and the brand guidelines agents follow when they write for dembrane. |

## Where to read next

| You want to | Read |
|---|---|
| Run it on your machine | [Local development](./local-development.md) |
| See how the apps and packages fit together | [Architecture](./architecture.md) |
| Find a table | [The data model](./data-model.md) |
| Follow audio from upload to summary | [The processing pipeline](./processing-pipeline.md) |
| Add or debug a job | [Background jobs and schedules](./background-jobs-and-scheduler.md) |
| Work on Ask or the assistant | [Chat and the assistant](./chat-and-agent.md) |
| Change who may do what | [Roles and policies in code](./roles-and-policies.md) |
| Add or change a free plan limit | [The free tier in code](./free-tier.md) |
| Ship a change | [Deployment and releases](./deployment-and-releases.md) |
| Change a page of these docs | [Maintaining the docs](./maintaining-docs.md) |

## The files that decide

These pages summarise. The files below are the source of truth, so check them when a page and the code disagree.

| File | What it settles |
|---|---|
| `dembrane/platform/README.md` | How to run the platform, what each app is, the layer rule, and where to start reading. |
| `dembrane/platform/PACKAGES.md` | Every app and package with a one-line description, and which namespace may import which. It is generated. Do not edit it by hand. |
| `dembrane/platform/packages/config/src/schema.ts` | Every setting, with its description and default. |
| `dembrane/platform/packages/db/src/schema/` | Every table. |
| `dembrane/infra/README.md` | The environments and what runs in each. |
| `.github/workflows/platform.yml` | The checks on a pull request and how each environment is deployed. |
| `CONTRIBUTING.md`, `TRANSLATING.md` | How to contribute code and translations. |

## Conventions worth knowing early

- Run `bun run check` in `dembrane/platform` before you push. It runs the lint, the type check, the layer rule and the tests.
- A dependency points down only: apps, then namespaces, then capabilities. `bun run packages check` fails when a package breaks this.
- Code reads a setting as `config.<section>.<key>`. A setting that is not declared in the schema is a type error.
- A table changes in the Drizzle schema first. `bun run db:generate` writes the migration, and CI fails when the schema and the migrations disagree.
- A job is defined in its namespace and run by the worker. A service can enqueue a job inside its database transaction, so the job exists only if the change commits.
- Access to a workspace or a project is decided by policies in `packages/access`. A route asks for a policy by name.
- A change to the product changes its docs page in the same pull request.
- Your first pull request adds your GitHub username to `contributors.yml`. That is how you sign the contributor licence agreement. See [contributing](../developer-external/contributing.md).

## Related

- [Architecture](./architecture.md)
- [Local development](./local-development.md)
- [Deployment and releases](./deployment-and-releases.md)
- [The free tier in code](./free-tier.md)
- [External developer guide](../developer-external/index.md)
- [Contributing](../developer-external/contributing.md)
- [Licensing](../developer-external/licensing.md)
