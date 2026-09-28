# dembrane MCP integration

This reference describes the Echo implementation inspected on 2026-09-17. Live tool discovery is authoritative; inspect schemas before calls.

## Available in the inspected server

MCP is mounted at `/api/mcp`, with OAuth access acting as the user. Workspace access, organisation grants and read/write scope still apply.

| Tool | Use in this workflow |
| --- | --- |
| `dembrane_whoami` | Identify accessible organisations/workspaces and scopes. |
| `dembrane_list_tools` | Discover the connected server's actual capabilities. |
| `dembrane_find_projects` | Search accessible projects before upserting a demo. |
| `dembrane_get_project` | Inspect destination and read back settings. |
| `dembrane_update_project` | Update supported fields on an existing authorised project. |
| `dembrane_list_conversations`, `dembrane_get_conversation`, `dembrane_read_transcript` | Verify imported conversations and synthetic labels. |
| `dembrane_read_doc`, `dembrane_search_docs` | Look up current server guidance. |

`dembrane_update_project` currently accepts name, context, language, is_conversation_allowed, default_conversation_title, default_conversation_description and default_conversation_finish_text. Its `context` is a description visible to hosts and participants. Store only public-safe research there, not a private sales brief.

Other tools include transcript search and tool/issue feedback. `dembrane_request_tool` and `dembrane_report_issue` send feedback to others; missing functionality alone does not authorise those calls.

## Missing in the inspected server

There are no MCP tools to create a project, import synthetic text conversations, configure/run/read Popcorn, or publish its output. A skill alone does not add these capabilities. Prepare the content and state the gap if the connected server still lacks them.

The minimal future bridge should expose existing services rather than a separate demo generator. Every write is an upsert, never a bare create: the existing `dembrane_update_project` already carries the project's context, language, intake and default conversation fields, so the bridge extends it rather than adding a create tool beside it.

- Upsert a project: `dembrane_update_project` grows into an upsert that also accepts a workspace and a stable key, marks the project synthetic and closed to real intake, and returns its ID.
- Upsert labelled synthetic conversations into that project by stable import key, with read-back support.
- Upsert the Popcorn session with its intro, disclosure, notice and synthetic provenance before extraction, then start/read existing Popcorn extraction and retrieve its preview.
- Export/publish only when authorised, retaining disclosure and the sales portal QR.

These are capability requirements, not callable tool names. Upserts preserve normal user access and prevent accidental writes into real research. Public visibility must remain off until required provenance and content checks pass.

For implementation in an Echo checkout, inspect `echo/server/dembrane/agent_access/{mcp_server,tools}.py`, the workspace project service and `echo/server/dembrane/api/v2/bff/popcorn.py`. The latter exposes ordinary application endpoints under `/api/v2/bff/popcorn`; these are not MCP tools. Do not change backend interfaces as an incidental part of creating one customer's demo.

## Popcorn data supported by the local prototype

Settings store three opening blocks in existing `popcorn_settings`, each off by default and available to every session:

```json
{
  "intro": { "enabled": true, "title": "", "subtitle": "" },
  "disclosure": { "enabled": true, "text": "", "invitation_title": "", "invitation_text": "" },
  "notice": { "enabled": true, "text": "" },
  "data": { "enabled": true },
  "language": { "ui": "auto", "translate_to": "" }
}
```

Limits: titles and the notice text 160 characters, other texts 600. Each line of a text is a paragraph. A switch without words shows nothing. For a synthetic session the bundle ignores the `disclosure` and `notice` settings and shows the demo's own words, filling empty ones with standard synthetic copy in the demo language. `data` has no words of its own: the screen follows the project's `anonymize_transcripts` and effective `legal_basis`. `language.ui` is `auto` or one of en, nl, de, fr, es, it, uk, cs; `language.translate_to` is empty (original language, the default) or one of those, and a new value starts a read that translates the results.

The sales portal is an ordinary project. `dembrane_update_project` sets its name, language, `is_conversation_allowed` and the three `default_conversation_*` texts from `echo/demos/sales-portal.json`; its `legal_basis` (`dembrane-events`) is not in the tool and is set in the dashboard by a dembrane account.

Synthetic state carries:

```json
{
  "demo": {
    "synthetic": true,
    "public_sources_only": true,
    "language": "nl",
    "portal_url": "https://portal.example/nl-NL/<sales-portal-project>/start?utm_source=popcorn_demo&utm_campaign=example",
    "portal_urls": { "nl": "…", "en": "…" },
    "disclosure": { "text": "…", "invitation_title": "…", "invitation_text": "…" },
    "notice": { "text": "…" }
  }
}
```

The demo carries its own disclosure, invitation and frame (`notice`) words; hosts cannot change them in the dashboard and the settings API refuses edits, so the upsert that marks a project synthetic writes them too. The QR uses the sales portal in the screen's language, falling back to `portal_url`. This example URL is illustrative. Set `public_sources_only` from provenance, and `portal_url` to the tested sales portal start link. State is held in `agent_loop.popcorn_state`; presenters and bundles derive their synthetic metadata from it. The setting toggle cannot remove this provenance. Preserve it on rerun. Project-wide immutable provenance is not implemented by these presenter changes, so keep these projects isolated from real research.

Use IDs exactly as returned. Project IDs are typically UUIDs; Popcorn report IDs may be integer strings. Never fabricate IDs from a generic MCP instruction.
