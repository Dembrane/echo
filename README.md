# dembrane

dembrane helps people make sense of big, messy conversations together. Participants record small-group discussions on their own phones, while hosts see what is emerging across the room. Transcripts, participant-verified insights, chat, and reports help turn those conversations into shared next steps while everyone is still there.

Built for workshops, citizen assemblies, strategy sessions, conferences, and other occasions where many people need to be heard. Read more on [dembrane.com](https://www.dembrane.com/).

[Try the platform](https://dashboard.dembrane.com/) · [Documentation](https://docs.dembrane.com/) · [Features](https://www.dembrane.com/platform/features) · [Trust center](https://www.dembrane.com/trust)

> dembrane was formerly called ECHO. The old name still appears in this repository's name, container images, and Kubernetes namespaces.

## How it works

1. *Prepare and share.* Create a project, configure the participant portal, and share its QR code or link.
2. *Start talking.* Participants join in a browser with no account or download required. Record several groups at once, work across languages, or upload existing recordings.
3. *Make sense together.* Follow incoming conversations in the dashboard. Enable Explore for questions that deepen the discussion and Verify so participants can critique, refine, and approve what the language model surfaces.
4. *Bring the results back.* Ask questions across conversations, check the cited sources, and create reports that capture themes, differences, and recommendations. Review the results with the people involved.

See the [feature overview](https://www.dembrane.com/platform/features) and [quick start for hosts](https://docs.dembrane.com/users/host/getting-started).

## Inside the app

These screenshots show the local development app. Available features and navigation can differ from the hosted release. Select an image to view it at full size.

<table>
  <tr>
    <td align="center" width="50%">
      <a href=".github/readme/project-overview.jpg">
        <img src=".github/readme/project-overview.jpg" alt="Project overview with a participant QR code, portal settings, and shortcuts to the main tools" width="440">
      </a>
      <br>
      <em>Share a project by QR code or link</em>
    </td>
    <td align="center" width="50%">
      <a href=".github/readme/portal-editor.jpg">
        <img src=".github/readme/portal-editor.jpg" alt="Portal editor with language and participant settings beside a live preview of the welcome screen" width="440">
      </a>
      <br>
      <em>Configure and preview the participant portal</em>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href=".github/readme/ask.jpg">
        <img src=".github/readme/ask.jpg" alt="Ask screen with an example question about agreement and differing perspectives, ready to select conversations" width="440">
      </a>
      <br>
      <em>Start an analysis with your own question</em>
    </td>
    <td align="center" width="50%">
      <a href=".github/readme/report-setup.jpg">
        <img src=".github/readme/report-setup.jpg" alt="Report setup with English selected and focus areas for key themes and recommendations" width="440">
      </a>
      <br>
      <em>Choose the language and focus of a report</em>
    </td>
  </tr>
</table>

## What you can do

- *Listen across groups and languages.* Capture parallel conversations through the participant portal, transcribe them, and review their summaries and source transcripts.
- *Keep participants involved.* Explore and Verify let people question and improve the interpretation of their own conversation.
- *Ask questions of the whole project.* Compare perspectives, find recurring concerns, and follow citations back to the source. Agentic chat can search and read conversations in several steps.
- *Create and share reports.* Review a draft, share it by link, or download a PDF.
- *Work together.* Organise projects in workspaces, invite collaborators, and control access through roles and permissions.
- *Build on your data.* Export material and connect other systems through the API and webhooks.

The [feature catalogue](https://docs.dembrane.com/features/) covers capabilities and availability in more detail.

## Trust and security

The [dembrane trust center](https://www.dembrane.com/trust) describes the managed service's EU hosting and processing, ISO 27001 certification, encryption at rest, and data protection practices. Client data is not used for model training unless the client opts in. Hosts determine the legal basis for their sessions, and participant identity collection is configurable.

These commitments describe the managed service. For your own deployment, review the [self-hosting guide](https://docs.dembrane.com/users/developer-external/self-hosting) and [provider configuration](https://docs.dembrane.com/users/developer-external/configuration-and-llm-providers).

Please report vulnerabilities through our [security policy](SECURITY.md).

## Getting started

- *Use the hosted platform:* [open the dashboard](https://dashboard.dembrane.com/) and follow the [host guide](https://docs.dembrane.com/users/host/getting-started).
- *Run an event with us:* dembrane offers event services, facilitator training, and scholarships. See [services and pricing](https://www.dembrane.com/pricing) for the current options.
- *Run or develop it yourself:* start with [self-hosting](https://docs.dembrane.com/users/developer-external/self-hosting), the [local development setup](#development), and the [architecture guide](https://docs.dembrane.com/users/developer-internal/architecture).

The codebase includes the React dashboard and participant portal, and a Bun API, worker and media service. PostgreSQL and S3-compatible storage support the processing pipeline.

## Development

### Layout

- `dembrane/platform`: the Bun API, worker, media service, migrations and web server (`apps/`), their packages (`packages/`), infrastructure (`infra/`) and the parity harness against the previous stack (`parity/`).
- `dembrane/frontend`: the dashboard and participant portal (React, Vite).
- `dembrane/demos`: the example synthetic demos the accounts seed reads.
- `brand`: logos and style assets.
- `dembrane-go`: the iOS app.
- `skills`: the brand guidelines agents follow when writing for dembrane.

### Run the platform

```sh
cd dembrane/platform
bun run setup        # Postgres in docker, dependencies, migrations
bun run dev          # API on :8080
bun --env-file=.env.local apps/worker/src/main.ts   # worker
bun run check        # lint, types, tests
```

### Run the frontend

```sh
cd dembrane/frontend
pnpm install
pnpm dev             # dashboard on :5173, /api proxied to :8080
pnpm participant:dev # portal on :5174
```

## Documentation

- [Published documentation](https://docs.dembrane.com/)
- [For hosts](https://docs.dembrane.com/users/host/) and [participants](https://docs.dembrane.com/users/participant/)
- [For developers and integrations](https://docs.dembrane.com/users/developer-external/)
- [Local development setup](#development)
- [Contributing](CONTRIBUTING.md)

## Project status and license

dembrane is actively maintained by Dembrane B.V. and welcomes community contributions. We build the platform so more people can help shape the decisions that affect them. Meet the team and read about our approach on the [about page](https://www.dembrane.com/about).

This repository is *source available* under the [Business Source License 1.1](LICENSE). The license permits non-production use and includes a production-use grant for organisations whose Total Finances do not exceed EUR 1,000,000 over the most recent 12-month period. Each release has a Change Date three years after release and a Change License of GPLv3. See [LICENSE](LICENSE) for the full definitions and conditions, or contact [jorim@dembrane.com](mailto:jorim@dembrane.com) for alternative licensing arrangements.

We welcome forks and contributions under those terms. If you would like to collaborate or discuss a maintainer role, get in touch.

## Stewardship

dembrane is currently independent and working towards becoming steward-owned. Community members interested in helping guide the project's future can contact [bram@dembrane.com](mailto:bram@dembrane.com).

## Contact

- Platform support: [support@dembrane.com](mailto:support@dembrane.com)
- Events, hosting, and partnerships: [evelien@dembrane.com](mailto:evelien@dembrane.com)
- Urgent pull requests: [sameer@dembrane.com](mailto:sameer@dembrane.com)
- Legal inquiries and stewardship: [bram@dembrane.com](mailto:bram@dembrane.com)
- Mission, press, and licensing: [jorim@dembrane.com](mailto:jorim@dembrane.com)

Thanks to everyone who has contributed to dembrane!

<a href="https://github.com/dembrane/echo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=dembrane/echo" alt="Contributors to dembrane">
</a>

![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Dembrane/echo?utm_source=oss&utm_medium=github&utm_campaign=Dembrane%2Fecho&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
