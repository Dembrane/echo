---
title: Maintaining the docs
description: How this documentation stays true to the product. Where the pages live, the rule that a product change updates its page in the same pull request, and how the site is built and published per environment.
audience: developer-internal
---

# Maintaining the docs

The working rule is short: a change to the product changes its page in the same pull request. A stale page misleads the people who read it and the agents that answer from it, so docs are kept true as part of the change, not afterwards.

## Where things live

| Piece | Path |
|---|---|
| The published pages | `docs/` at the repository root |
| How to write it | `docs/_authoring/STYLE.md`: voice, spelling, frontmatter, links |
| Site settings | `docs/manifest.json`: name, colours, the two locales (`en-UK` and `nl-NL`), comments |
| The sidebar | `docs/sidebar.json`: the sections and the order of the pages in the site's navigation |
| Publishing | `.github/workflows/docs.yml` |

Nothing in `docs/_authoring/` is published. No page links to it.

## Who reads the published site

- People: hosts, partners, participants and developers.
- The dashboard. It links to the site's home page, to the Dutch home page, and to two pages directly (see "Pages that must not move").
- Agents connected over MCP. Their documentation tools read the published site: they fetch `llms.txt` and then the markdown twin of each page it lists. A page that is not listed there is invisible to them.

So a wrong sentence does not stay on one page. An agent repeats it as a confident answer.

## The rule, step by step

1. Classify the change. Anything a user can observe needs its page updated: an interface label, a route, a permission, a tier, an endpoint, a limit. A change to how the code is built belongs on the pages in this section. "No docs impact" is a valid conclusion. Say so in the pull request.
2. Find the pages. Look three ways: by feature (`docs/features/` holds one page per feature), by audience (each folder under `docs/users/` retells features for one kind of reader), and by text (search `docs/` for the exact labels and names your change touches).
3. Update the feature page first, then the audience pages.
4. Ground every claim in code. Read the code, not the pull request description. Copy interface labels exactly from the source. If you cannot verify something, leave it out.
5. Check the links and open the pull request with the code change.

Rules for a page are in `STYLE.md`. The ones that break the site when you forget them:

- Every page starts with frontmatter: `title`, `description`, `audience`.
- Links are relative links to `.md` files.
- folder2website finds pages by following links from `docs/README.md`. A page that nothing links to does not appear on the site. When you add a page, link it from its section index and from `docs/map.md`, and add it to `docs/sidebar.json`. A page missing from that file is left out of the sidebar.
- A translation is a twin file next to the page, named `<page>.nl-NL.md`.

## Pages that must not move

The product and the repository link to these addresses. Renaming or moving one breaks a link someone clicks.

| Linked from | Pages |
|---|---|
| The dashboard (`dembrane/frontend/src/config.ts`) | The home page and its Dutch twin, `users/host/chat-and-ask.md`, `users/host/troubleshooting-transcripts-and-summaries.md` |
| The root `README.md` | `users/host/getting-started.md`, `users/developer-external/self-hosting.md`, `users/developer-external/configuration-and-llm-providers.md`, `users/developer-internal/architecture.md`, and the section indexes for hosts, participants, external developers and features |

## How the site is built and published

The site is built from `docs/` with folder2website. There is one site per environment, so each site describes the product that environment runs.

| Site | Published from | When |
|---|---|---|
| `docs.staging.dembrane.com` | `main` | On every push to `main` that changes `docs/` |
| `docs.dembrane.com` | The release tag | With each production release, after the production deploy |

What this means for you:

- A merged docs change shows on the staging site first. It reaches `docs.dembrane.com` with the next release, together with the product change it describes.
- A fix to the pages alone does not have to wait for a release. A maintainer can run the workflow by hand to publish a chosen ref to production. That publishes everything `docs/` says at that ref, so check that it describes nothing unreleased.
- The build needs the full git history, because folder2website reads each page's history for its dates.
- The site is built with the address it will be served at. The MCP documentation tools depend on that address in `llms.txt`.

The exact build command and the pinned version of the builder are in `.github/workflows/docs.yml`.
To preview the site on your machine, run `./docs/build.sh --serve`.

## When a page is found to be wrong

Fix the page. Then find the change that made it stale and check the other pages that change should have touched.

## Related

- [Internal developer overview](./index.md)
- [Deployment and releases](./deployment-and-releases.md)
- [Chat and the assistant](./chat-and-agent.md)
- [MCP and agent access](../developer-external/mcp-and-byo-llm.md)
- [Contributing](../developer-external/contributing.md)
